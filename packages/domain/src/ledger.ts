/**
 * The stock ledger (AD-1).
 *
 * Stock is never a stored number. It is SUM(qtyBase) over an append-only
 * movement log. There is no quantity column here and there never will be one.
 *
 * There is deliberately not much logic in this file. The invariants live in
 * the shape of the data and in `001_core.sql`, which is the source of truth
 * for schema. This class is the same contract expressed for callers that have
 * no database in front of them - principally the offline POS, which imports
 * this package and must enforce identical negative-stock and pack-conversion
 * rules while disconnected (AD-6).
 */

import { DomainError, LedgerImmutable, NegativeStockBlocked } from './errors.js';
import type { MasterData } from './packs.js';
import { packsToBase } from './packs.js';
import {
  assertStockAvailable,
  backdateGapHours,
  BACKDATE_THRESHOLD_MS,
  computeCountVariance,
  isBackdated,
  weightedAverageCost,
} from './policy.js';
import type {
  ExceptionKind,
  ExceptionState,
  MovementReason,
  StockMovement,
  Uuid,
} from './types.js';

export { BACKDATE_THRESHOLD_MS } from './policy.js';

/** A movement after the server has assigned it a sequence and a receive time. */
export interface PostedMovement extends StockMovement {
  /** Server-assigned. Total order for sync resumption. */
  seq: number;
  /** Server clock, not client clock. The gap to `occurredAt` is data. */
  recordedAt: Date;
}

export interface ExceptionRecord {
  id: Uuid;
  eventId: Uuid;
  kind: ExceptionKind;
  state: ExceptionState;
  branchId: Uuid;
  terminalId: Uuid | null;
  actorId: Uuid;
  productId: Uuid | null;
  detail: Record<string, unknown>;
  valueImpact: number | null;
  currency: string | null;
  occurredAt: Date;
  recordedAt: Date;
  clearedBy: Uuid | null;
  clearedAt: Date | null;
  clearingNote: string | null;
}

export interface PostInput {
  /**
   * Client-generated at the terminal, before the network is available.
   * Idempotency key: replaying a synced event is a no-op, which is what makes
   * offline sync safe without conflict resolution (R4).
   */
  eventId?: Uuid;
  productId: Uuid;
  branchId: Uuid;
  /** Signed, in BASE UNITS. Positive into the branch, negative out. */
  qtyBase: number;
  reason: MovementReason;
  actorId: Uuid;
  /**
   * Unit cost in base units at the moment of the movement. Carried on the
   * movement so weighted-average cost is reproducible from history and cannot
   * drift to equal the selling price (HANDOFF section 2.2).
   */
  unitCost?: number | null;
  currency?: string;
  docType?: string | null;
  docId?: Uuid | null;
  reversesSeq?: number | null;
  terminalId?: Uuid | null;
  /** Business time. May be in the past if the till was offline or backdated. */
  occurredAt?: Date;
  /** Bypass the negative-stock guard. Never silent - see `sell`. */
  allowNegative?: boolean;
}

export interface SellInput {
  barcode: string;
  /** In PACKS as scanned. Converted to base units here, at the edge. */
  qtyPacks: number;
  branchId: Uuid;
  actorId: Uuid;
  terminalId?: Uuid | null;
  eventId?: Uuid;
  occurredAt?: Date;
  overrideNegative?: boolean;
  /** The manager authorising an override. Recorded on the exception. */
  overrideBy?: Uuid | null;
}

export interface RaiseExceptionInput {
  kind: ExceptionKind;
  branchId: Uuid;
  actorId: Uuid;
  occurredAt: Date;
  eventId?: Uuid;
  terminalId?: Uuid | null;
  productId?: Uuid | null;
  detail?: Record<string, unknown>;
  valueImpact?: number | null;
  currency?: string | null;
}

export interface CountInput {
  productId: Uuid;
  branchId: Uuid;
  /** What was physically counted, in base units. */
  countedBase: number;
  actorId: Uuid;
  docId: Uuid;
  terminalId?: Uuid | null;
  occurredAt?: Date;
}

export interface CountResult {
  expected: number;
  counted: number;
  variance: number;
  /** Sequence of the adjustment movement, or null when the count reconciled. */
  adjustmentSeq: number | null;
}

export interface LedgerOptions {
  /** Injectable clock. Production passes nothing. */
  now?: () => Date;
  /** Injectable id source. Production passes nothing. */
  newId?: () => Uuid;
}

export class Ledger {
  readonly #master: MasterData;
  readonly #now: () => Date;
  readonly #newId: () => Uuid;

  readonly #movements: PostedMovement[] = [];
  /** event_id UNIQUE - the idempotency index. */
  readonly #byEventId = new Map<Uuid, number>();
  readonly #exceptions: ExceptionRecord[] = [];
  #nextSeq = 1;

  constructor(master: MasterData, options: LedgerOptions = {}) {
    this.#master = master;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  // -- reads ----------------------------------------------------------------

  /** Stock on hand. Derived every time, never cached, never stored. */
  onHand(productId: Uuid, branchId: Uuid): number {
    let total = 0;
    for (const m of this.#movements) {
      if (m.productId === productId && m.branchId === branchId) total += m.qtyBase;
    }
    return total;
  }

  /**
   * Weighted-average cost, derived from receipt movements only.
   *
   * Mirrors the `product_wac` view. Returns null when nothing priced has been
   * received, rather than guessing - a guessed cost is how they arrived at a
   * 0.11% gross margin.
   */
  wac(productId: Uuid, branchId: Uuid): number | null {
    return weightedAverageCost(
      this.#movements.filter((m) => m.productId === productId && m.branchId === branchId),
    );
  }

  /** Resolve a scan to product and pack multiplier. Throws `UnlistedBarcode`. */
  resolveBarcode(code: string) {
    return this.#master.resolveBarcode(code);
  }

  /** Frozen copies. The ledger hands out history, never handles to it. */
  movements(): readonly PostedMovement[] {
    return Object.freeze([...this.#movements]);
  }

  openExceptions(kind?: ExceptionKind): readonly ExceptionRecord[] {
    return this.#exceptions.filter(
      (e) => e.state === 'open' && (kind === undefined || e.kind === kind),
    );
  }

  /** Movements whose backdate gap exceeds the threshold. The `backdated_movement` view. */
  backdatedMovements(): readonly PostedMovement[] {
    return this.#movements.filter((m) => isBackdated(m.occurredAt, m.recordedAt));
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Append one movement. Returns its sequence.
   *
   * Idempotent on `eventId`: a terminal that syncs the same batch twice does
   * not double-count. The idempotency check runs before validation, so
   * replaying an already-accepted event stays a no-op even if conditions have
   * since changed.
   */
  post(input: PostInput): number {
    const eventId = input.eventId ?? this.#newId();

    const existing = this.#byEventId.get(eventId);
    if (existing !== undefined) return existing; // R4: already applied

    const occurredAt = input.occurredAt ?? this.#now();
    const recordedAt = this.#now();

    // CHECK (qty_base <> 0)
    if (!Number.isFinite(input.qtyBase) || input.qtyBase === 0) {
      throw new DomainError(
        'INVALID_MOVEMENT',
        'A movement must carry a non-zero quantity',
        { qtyBase: input.qtyBase },
      );
    }

    this.#master.assertTransactable(input.productId);

    if (input.qtyBase < 0) {
      assertStockAvailable(this.onHand(input.productId, input.branchId), input.qtyBase, {
        allowNegative: input.allowNegative ?? false,
      });
    }

    const seq = this.#nextSeq;
    this.#nextSeq += 1;

    const movement: PostedMovement = Object.freeze({
      seq,
      eventId,
      productId: input.productId,
      branchId: input.branchId,
      qtyBase: input.qtyBase,
      unitCost: input.unitCost ?? null,
      currency: input.currency ?? 'USD',
      reason: input.reason,
      docType: input.docType ?? null,
      docId: input.docId ?? null,
      reversesSeq: input.reversesSeq ?? null,
      actorId: input.actorId,
      terminalId: input.terminalId ?? null,
      occurredAt,
      recordedAt,
    });

    this.#movements.push(movement);
    this.#byEventId.set(eventId, seq);

    // Backdating is detectable because both timestamps are stored (R5).
    if (isBackdated(occurredAt, recordedAt)) {
      this.raiseException({
        kind: 'backdated_entry',
        branchId: input.branchId,
        actorId: input.actorId,
        productId: input.productId,
        terminalId: input.terminalId ?? null,
        occurredAt,
        detail: {
          movementSeq: seq,
          gapHours: backdateGapHours(occurredAt, recordedAt),
        },
      });
    }

    return seq;
  }

  /**
   * Till sale. Resolves the pack multiplier, then posts in base units.
   *
   * Receiving cases and selling singles now reconcile arithmetically, which is
   * the defect behind a large share of the USD 214,516 variance.
   */
  sell(input: SellInput): number {
    const binding = this.#master.resolveBarcode(input.barcode);
    const qtyBase = -Math.abs(packsToBase(input.qtyPacks, binding.qtyBase));

    const base: PostInput = {
      productId: binding.productId,
      branchId: input.branchId,
      qtyBase,
      reason: 'sale',
      actorId: input.actorId,
      terminalId: input.terminalId ?? null,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    };

    try {
      return this.post(base);
    } catch (error) {
      if (!(error instanceof NegativeStockBlocked)) throw error;
      if (input.overrideNegative !== true) throw error;

      // An override is permitted, but it is never silent. This is the client's
      // stated "override to their own benefit" problem (HANDOFF section 2.7).
      const seq = this.post({ ...base, allowNegative: true });
      this.raiseException({
        kind: 'negative_stock_override',
        branchId: input.branchId,
        actorId: input.actorId,
        productId: binding.productId,
        terminalId: input.terminalId ?? null,
        occurredAt: this.#now(),
        detail: {
          movementSeq: seq,
          barcode: input.barcode,
          authorisedBy: input.overrideBy ?? null,
          available: error.detail['available'] ?? null,
          requested: error.detail['requested'] ?? null,
        },
      });
      return seq;
    }
  }

  /**
   * A cashier scanned something not in the master.
   *
   * The old system let this pass silently; here it is an incident with a name
   * attached, which is what makes under-the-counter selling visible.
   */
  scanUnlisted(input: {
    code: string;
    branchId: Uuid;
    actorId: Uuid;
    terminalId?: Uuid | null;
    occurredAt?: Date;
  }): ExceptionRecord {
    return this.raiseException({
      kind: 'unlisted_barcode_scan',
      branchId: input.branchId,
      actorId: input.actorId,
      terminalId: input.terminalId ?? null,
      occurredAt: input.occurredAt ?? this.#now(),
      detail: { rawBarcode: input.code },
    });
  }

  /**
   * Every control writes a work item here, open, awaiting a named human
   * (AD-4). A control nobody clears is not a control.
   */
  raiseException(input: RaiseExceptionInput): ExceptionRecord {
    const record: ExceptionRecord = {
      id: this.#newId(),
      eventId: input.eventId ?? this.#newId(),
      kind: input.kind,
      state: 'open',
      branchId: input.branchId,
      terminalId: input.terminalId ?? null,
      actorId: input.actorId,
      productId: input.productId ?? null,
      detail: input.detail ?? {},
      valueImpact: input.valueImpact ?? null,
      currency: input.currency ?? null,
      occurredAt: input.occurredAt,
      recordedAt: this.#now(),
      clearedBy: null,
      clearedAt: null,
      clearingNote: null,
    };
    this.#exceptions.push(record);
    return record;
  }

  /**
   * Post a stock count.
   *
   * The variance is computed against the ledger, and posting it writes an
   * adjustment movement valued at weighted-average cost. A count that is not
   * posted changes nothing - which is why the four counts left "In progress"
   * at Kernmaur, Mission and TM never cleared their variance, and why the next
   * count started from the same wrong base.
   */
  postCount(input: CountInput): CountResult {
    const expected = this.onHand(input.productId, input.branchId);
    const unitCost = this.wac(input.productId, input.branchId);
    const assessment = computeCountVariance(expected, input.countedBase, unitCost);
    const { variance, valueImpact } = assessment;
    if (variance === 0) {
      return { expected, counted: input.countedBase, variance, adjustmentSeq: null };
    }

    const occurredAt = input.occurredAt ?? this.#now();

    const adjustmentSeq = this.post({
      productId: input.productId,
      branchId: input.branchId,
      qtyBase: variance,
      reason: 'count_adjustment',
      actorId: input.actorId,
      unitCost,
      docType: 'COUNT',
      docId: input.docId,
      terminalId: input.terminalId ?? null,
      occurredAt,
      // A count posts what was physically there, including a shortage that
      // takes the book negative. Suppressing it would hide the variance.
      allowNegative: true,
    });

    this.raiseException({
      kind: 'count_variance',
      branchId: input.branchId,
      actorId: input.actorId,
      productId: input.productId,
      terminalId: input.terminalId ?? null,
      occurredAt,
      detail: {
        expected,
        counted: input.countedBase,
        variance,
        movementSeq: adjustmentSeq,
        docId: input.docId,
      },
      valueImpact,
      currency: valueImpact === null ? null : 'USD',
    });

    return { expected, counted: input.countedBase, variance, adjustmentSeq };
  }

  // -- the operations that do not exist (R2) --------------------------------

  /**
   * Always throws. Present so that the refusal is explicit and carries the
   * same error the database trigger raises, rather than the ledger simply
   * lacking a method someone might later add.
   */
  update(seq: number, _patch?: Partial<StockMovement>): never {
    throw new LedgerImmutable(`UPDATE of movement ${seq}`);
  }

  /** Always throws. No hard deletes anywhere in the system, ever. */
  delete(seq: number): never {
    throw new LedgerImmutable(`DELETE of movement ${seq}`);
  }

  /**
   * The supported correction: a new movement that reverses an earlier one.
   * History is never rewritten, only added to.
   */
  reverse(
    seq: number,
    input: { actorId: Uuid; reason: MovementReason; eventId?: Uuid; occurredAt?: Date },
  ): number {
    const original = this.#movements.find((m) => m.seq === seq);
    if (original === undefined) {
      throw new DomainError('UNKNOWN_MOVEMENT', `No movement with seq ${seq}`, { seq });
    }
    return this.post({
      productId: original.productId,
      branchId: original.branchId,
      qtyBase: -original.qtyBase,
      reason: input.reason,
      actorId: input.actorId,
      unitCost: original.unitCost,
      currency: original.currency,
      docType: original.docType,
      docId: original.docId,
      reversesSeq: seq,
      terminalId: original.terminalId,
      allowNegative: true,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
  }
}
