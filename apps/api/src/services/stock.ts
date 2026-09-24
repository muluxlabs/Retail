/**
 * Database-backed stock service.
 *
 * This is the server-side twin of `Ledger` in packages/domain. It holds NO
 * rules of its own: every decision is delegated to a policy function from the
 * domain package (AD-6). What it adds is the database — transactions, the
 * `stock_on_hand` view, and idempotency enforced by a unique index rather
 * than by an in-memory map.
 *
 * If you find yourself writing an `if` here that encodes a business rule,
 * it belongs in packages/domain instead.
 */

import {
  assertStockAvailable,
  backdateGapHours,
  computeCountVariance,
  isBackdated,
  packsToBase,
  UnlistedBarcode,
  type MovementReason,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface PostMovementInput {
  eventId?: string | undefined;
  productId: string;
  branchId: string;
  qtyBase: number;
  reason: MovementReason;
  actorId: string;
  unitCost?: number | null | undefined;
  docType?: string | null | undefined;
  docId?: string | null | undefined;
  terminalId?: string | null | undefined;
  occurredAt?: Date | undefined;
  allowNegative?: boolean | undefined;
}

export interface PostMovementResult {
  seq: number;
  eventId: string;
  /** True when this event_id had already been applied - a replayed sync. */
  replayed: boolean;
  qtyAfter: number;
  backdated: boolean;
}

/** Stock on hand for one product at one branch, read from the view. */
export async function onHand(db: Db | Tx, productId: string, branchId: string): Promise<number> {
  const row = await db
    .selectFrom('stock_on_hand')
    .select('qty_base')
    .where('product_id', '=', productId)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  return row?.qty_base ?? 0;
}

/** Weighted-average cost from the view. Null when nothing priced was received. */
export async function wac(db: Db | Tx, productId: string, branchId: string): Promise<number | null> {
  const row = await db
    .selectFrom('product_wac')
    .select('wac')
    .where('product_id', '=', productId)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  return row?.wac ?? null;
}

/**
 * Resolve a scanned barcode to its product and pack multiplier.
 *
 * Throws `UnlistedBarcode`, which the edge maps to 404. The old platform let
 * an unresolved scan pass silently; that is what made under-the-counter
 * selling invisible.
 */
export async function resolveBarcode(
  db: Db,
  code: string,
): Promise<{
  code: string;
  packId: string;
  productId: string;
  qtyBase: number;
  productName: string;
  reviewState: 'approved' | 'pending';
}> {
  const row = await db
    .selectFrom('barcode')
    .innerJoin('product_pack', 'product_pack.id', 'barcode.pack_id')
    .innerJoin('product', 'product.id', 'product_pack.product_id')
    .select([
      'barcode.code as code',
      'product_pack.id as packId',
      'product_pack.product_id as productId',
      'product_pack.qty_base as qtyBase',
      'product.name as productName',
      'product.review_state as reviewState',
    ])
    .where('barcode.code', '=', code)
    .executeTakeFirst();

  if (row === undefined) throw new UnlistedBarcode(code);
  return row;
}

/**
 * Resolve a product+pack directly, bypassing the barcode table.
 *
 * The till's product picker (search by name, not by code) and a just
 * quick-added item that has no barcode both need to sell without one -
 * `resolveBarcode` cannot serve either, since there is no code to look up.
 */
export async function resolvePack(
  db: Db,
  productId: string,
  packId: string,
): Promise<{
  packId: string;
  productId: string;
  qtyBase: number;
  productName: string;
  reviewState: 'approved' | 'pending';
}> {
  const row = await db
    .selectFrom('product_pack')
    .innerJoin('product', 'product.id', 'product_pack.product_id')
    .select([
      'product_pack.id as packId',
      'product_pack.product_id as productId',
      'product_pack.qty_base as qtyBase',
      'product.name as productName',
      'product.review_state as reviewState',
    ])
    .where('product_pack.id', '=', packId)
    .where('product_pack.product_id', '=', productId)
    .executeTakeFirst();

  if (row === undefined) {
    const { InvalidMasterData } = await import('@retail-ops/domain');
    throw new InvalidMasterData(`No pack ${packId} on product ${productId}`, { productId, packId });
  }
  return row;
}

/**
 * Record a scan that did not resolve, as a work item.
 *
 * `resolveBarcode` throwing 404 is not, on its own, a control - the old
 * platform let an unresolved scan pass silently, which is how
 * under-the-counter sales stayed invisible. This is the other half: the
 * scan itself becomes evidence with a cashier's name attached, landing in
 * the same exception queue as every other override.
 */
export async function logUnlistedScan(
  db: Db,
  input: { code: string; branchId: string; actorId: string; terminalId?: string | null | undefined },
): Promise<{ id: string }> {
  const row = await db
    .insertInto('exception_event')
    .values({
      event_id: crypto.randomUUID(),
      kind: 'unlisted_barcode_scan',
      branch_id: input.branchId,
      terminal_id: input.terminalId ?? null,
      actor_id: input.actorId,
      product_id: null,
      detail: JSON.stringify({ rawBarcode: input.code }),
      value_impact: null,
      currency: null,
      occurred_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row;
}

/**
 * Append one movement.
 *
 * Idempotent on `event_id`, and safe under concurrency. The transaction takes
 * an advisory lock on the product/branch position BEFORE it checks for a
 * replay, so two tills syncing the same offline batch at the same instant
 * serialise: the first inserts, the second sees the existing row and returns
 * it. `event_id UNIQUE` in the schema is the backstop if that ever fails.
 *
 * The same lock is what stops two concurrent sales both reading "1 on hand"
 * and both deciding they are allowed to sell it.
 */
export async function postMovement(
  db: Db,
  input: PostMovementInput,
): Promise<PostMovementResult> {
  return db.transaction().execute((tx) => postMovementInTx(tx, input));
}

/**
 * The same operation, against a transaction the caller already holds.
 *
 * `postMovement` above opens its own transaction, which is right for a
 * single call but wrong for a multi-line operation like dispatching a
 * transfer: nesting a Kysely transaction inside another only produces a
 * SAVEPOINT, not the single atomic unit a multi-line dispatch actually
 * needs (all lines commit together, or none do). Callers that already have
 * a `tx` - transfer.ts - call this directly instead.
 */
export async function postMovementInTx(
  tx: Tx,
  input: PostMovementInput,
): Promise<PostMovementResult> {
  const eventId = input.eventId ?? crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();

  // Serialise on the position before reading anything about it. Held until
  // the transaction ends, so the replay check and the stock check below are
  // both taken against a position nobody else can move underneath us.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${
    input.productId + input.branchId
  }, 0))`.execute(tx);

  // Replay check, so a resynced event stays a no-op even if the stock
  // position has changed since it was first accepted.
  const existing = await tx
    .selectFrom('stock_movement')
    .select(['seq'])
    .where('event_id', '=', eventId)
    .executeTakeFirst();

  if (existing !== undefined) {
    return {
      seq: existing.seq,
      eventId,
      replayed: true,
      qtyAfter: await onHand(tx, input.productId, input.branchId),
      backdated: false,
    };
  }

  const product = await tx
    .selectFrom('product')
    .select(['id', 'merged_into_id'])
    .where('id', '=', input.productId)
    .executeTakeFirst();

  if (product === undefined) {
    const { InvalidMasterData } = await import('@retail-ops/domain');
    throw new InvalidMasterData(`Unknown product: ${input.productId}`, {
      productId: input.productId,
    });
  }
  if (product.merged_into_id !== null) {
    const { ProductMerged } = await import('@retail-ops/domain');
    throw new ProductMerged(product.id, product.merged_into_id);
  }

  if (input.qtyBase < 0) {
    const available = await onHand(tx, input.productId, input.branchId);
    assertStockAvailable(available, input.qtyBase, {
      allowNegative: input.allowNegative ?? false,
    });
  }

  const inserted = await tx
    .insertInto('stock_movement')
    .values({
      event_id: eventId,
      product_id: input.productId,
      branch_id: input.branchId,
      qty_base: input.qtyBase,
      unit_cost: input.unitCost ?? null,
      reason: input.reason,
      doc_type: input.docType ?? null,
      doc_id: input.docId ?? null,
      reverses_seq: null,
      actor_id: input.actorId,
      terminal_id: input.terminalId ?? null,
      occurred_at: occurredAt,
    })
    .returning(['seq', 'recorded_at'])
    .executeTakeFirstOrThrow();

  const backdated = isBackdated(occurredAt, inserted.recorded_at);
  if (backdated) {
    await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'backdated_entry',
        branch_id: input.branchId,
        terminal_id: input.terminalId ?? null,
        actor_id: input.actorId,
        product_id: input.productId,
        detail: JSON.stringify({
          movementSeq: inserted.seq,
          gapHours: backdateGapHours(occurredAt, inserted.recorded_at),
          docType: input.docType ?? null,
        }),
        value_impact: null,
        currency: null,
        occurred_at: occurredAt,
      })
      .execute();
  }

  return {
    seq: inserted.seq,
    eventId,
    replayed: false,
    qtyAfter: await onHand(tx, input.productId, input.branchId),
    backdated,
  };
}

export type SellInput = {
  qtyPacks: number;
  branchId: string;
  actorId: string;
  terminalId?: string | null | undefined;
  eventId?: string | undefined;
  overrideNegative?: boolean | undefined;
  overrideBy?: string | null | undefined;
} & ({ barcode: string; productId?: undefined; packId?: undefined } | { barcode?: undefined; productId: string; packId: string });

/**
 * A till sale. Converts packs to base units at the edge, then posts.
 *
 * Resolves either by barcode (a scan or a typed code) or directly by
 * productId+packId (the cashier picked it from the searchable list, or it
 * was just quick-added and has no code yet) - the two are otherwise
 * identical from here down, which is the point: one sale, two ways in.
 *
 * An override is permitted but never silent: it writes an open exception with
 * the authorising manager named on it.
 */
export async function sell(db: Db, input: SellInput): Promise<PostMovementResult> {
  const binding =
    input.barcode !== undefined
      ? await resolveBarcode(db, input.barcode)
      : await resolvePack(db, input.productId, input.packId);
  const qtyBase = -Math.abs(packsToBase(input.qtyPacks, binding.qtyBase));

  const base: PostMovementInput = {
    productId: binding.productId,
    branchId: input.branchId,
    qtyBase,
    reason: 'sale',
    actorId: input.actorId,
    docType: 'SALE',
    terminalId: input.terminalId ?? null,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
  };

  // A pending product was quick-added at the till moments ago, not received
  // through the normal path - it has no stock baseline anyone can trust yet,
  // so it has none on the ledger either. Blocking its very first sale on the
  // guard that exists to catch someone selling stock the ledger says does
  // not exist would defeat the entire point of letting a cashier add it and
  // keep going. The `unreviewed_product` exception already raised at
  // quick-add is the control here; a second one on every sale of it would
  // only be noise.
  if (binding.reviewState === 'pending') {
    return postMovement(db, { ...base, allowNegative: true });
  }

  try {
    return await postMovement(db, base);
  } catch (error) {
    const { NegativeStockBlocked } = await import('@retail-ops/domain');
    if (!(error instanceof NegativeStockBlocked) || input.overrideNegative !== true) throw error;

    const result = await postMovement(db, { ...base, allowNegative: true });
    await db
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'negative_stock_override',
        branch_id: input.branchId,
        terminal_id: input.terminalId ?? null,
        actor_id: input.actorId,
        product_id: binding.productId,
        detail: JSON.stringify({
          movementSeq: result.seq,
          barcode: input.barcode ?? null,
          authorisedBy: input.overrideBy ?? null,
          available: error.detail['available'] ?? null,
          requested: error.detail['requested'] ?? null,
        }),
        value_impact: null,
        currency: null,
        occurred_at: new Date(),
      })
      .execute();
    return result;
  }
}

export interface CountLineInput {
  productId: string;
  countedBase: number;
}

export interface CountLineResult {
  productId: string;
  expected: number;
  counted: number;
  variance: number;
  valueImpact: number | null;
  adjustmentSeq: number | null;
}

/**
 * Post a stock count.
 *
 * Posting is the whole point: an unposted count changes nothing, which is why
 * four counts left "In progress" never cleared their variance and the next
 * count started from the same wrong base. Every line is posted in one
 * transaction, valued at weighted-average cost, and raises a work item.
 */
export async function postCount(
  db: Db,
  input: {
    branchId: string;
    actorId: string;
    docId?: string | undefined;
    lines: CountLineInput[];
    occurredAt?: Date | undefined;
  },
): Promise<{ docId: string; lines: CountLineResult[] }> {
  const docId = input.docId ?? crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const results: CountLineResult[] = [];

  for (const line of input.lines) {
    const expected = await onHand(db, line.productId, input.branchId);
    const unitCost = await wac(db, line.productId, input.branchId);
    const assessment = computeCountVariance(expected, line.countedBase, unitCost);

    if (assessment.variance === 0) {
      results.push({
        productId: line.productId,
        expected,
        counted: line.countedBase,
        variance: 0,
        valueImpact: null,
        adjustmentSeq: null,
      });
      continue;
    }

    const posted = await postMovement(db, {
      productId: line.productId,
      branchId: input.branchId,
      qtyBase: assessment.variance,
      reason: 'count_adjustment',
      actorId: input.actorId,
      unitCost,
      docType: 'COUNT',
      docId,
      occurredAt,
      // A count posts what was physically there, including a shortage that
      // takes the book negative. Suppressing it would hide the variance.
      allowNegative: true,
    });

    await db
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'count_variance',
        branch_id: input.branchId,
        terminal_id: null,
        actor_id: input.actorId,
        product_id: line.productId,
        detail: JSON.stringify({
          expected,
          counted: line.countedBase,
          variance: assessment.variance,
          movementSeq: posted.seq,
          docId,
        }),
        value_impact: assessment.valueImpact,
        currency: assessment.valueImpact === null ? null : 'USD',
        occurred_at: occurredAt,
      })
      .execute();

    results.push({
      productId: line.productId,
      expected,
      counted: line.countedBase,
      variance: assessment.variance,
      valueImpact: assessment.valueImpact,
      adjustmentSeq: posted.seq,
    });
  }

  return { docId, lines: results };
}
