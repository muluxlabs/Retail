/**
 * Cash custody.
 *
 * Same discipline as stock.ts and transfer.ts (AD-6): the rules that matter
 * - variance costing, idempotent posting - delegate to the identical shared
 * functions those files use, rather than restating them for cash. Cash on
 * hand is SUM(cash_movement.amount), never a stored balance; a blind count
 * posts a reconciling movement and raises exception_event the same way a
 * stock count does.
 *
 * "Blind" is not a schema property, it is who holds which permission: a
 * cashier is granted cash.count but never cash.read, so nothing in the API
 * can show them the expected figure before they submit their count. A
 * manager who holds both could look first if they chose to - the same
 * limit already accepted for stock counts, where nothing stops a
 * stock_controller from checking book stock before counting either.
 */

import { computeCountVariance, DomainError } from '@retail-ops/domain';
import type { CashPointKind, CashReason, Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface CashPointPosition {
  id: string;
  branchId: string;
  branchCode: string;
  kind: CashPointKind;
  name: string;
  terminalId: string | null;
  amount: number;
}

/**
 * Create a custody point and open it with a starting balance in one step.
 *
 * The only way any cash_point exists in a real deployment: the seed script
 * creates them by direct insert for local development, but nothing else
 * does in production - a fresh Neon database has cash's tables and no rows
 * in them until this is called.
 */
export async function createCashPoint(
  db: Db,
  input: {
    branchId: string;
    kind: CashPointKind;
    name: string;
    terminalId?: string | null | undefined;
    openingAmount: number;
    actorId: string;
  },
): Promise<CashPointPosition> {
  return db.transaction().execute(async (tx) => {
    const point = await tx
      .insertInto('cash_point')
      .values({
        branch_id: input.branchId,
        kind: input.kind,
        name: input.name,
        terminal_id: input.kind === 'till' ? (input.terminalId ?? null) : null,
      })
      .returning(['id', 'branch_id', 'kind', 'name', 'terminal_id'])
      .executeTakeFirstOrThrow();

    let amount = 0;
    if (input.openingAmount !== 0) {
      await post(tx, {
        cashPointId: point.id,
        amount: input.openingAmount,
        reason: 'opening_balance',
        actorId: input.actorId,
      });
      amount = input.openingAmount;
    }

    const branch = await tx
      .selectFrom('branch')
      .select('code')
      .where('id', '=', point.branch_id)
      .executeTakeFirstOrThrow();

    return {
      id: point.id,
      branchId: point.branch_id,
      branchCode: branch.code,
      kind: point.kind,
      name: point.name,
      terminalId: point.terminal_id,
      amount,
    };
  });
}

export async function listCashPoints(
  db: Db,
  filter: { branchId?: string | undefined } = {},
): Promise<CashPointPosition[]> {
  let query = db
    .selectFrom('cash_point')
    .innerJoin('branch', 'branch.id', 'cash_point.branch_id')
    .leftJoin('cash_on_hand', 'cash_on_hand.cash_point_id', 'cash_point.id')
    .select([
      'cash_point.id',
      'cash_point.branch_id as branchId',
      'branch.code as branchCode',
      'cash_point.kind',
      'cash_point.name',
      'cash_point.terminal_id as terminalId',
      (eb) => eb.fn.coalesce('cash_on_hand.amount', eb.val(0)).as('amount'),
    ])
    .where('cash_point.is_active', '=', true);

  if (filter.branchId !== undefined) query = query.where('cash_point.branch_id', '=', filter.branchId);

  return query.orderBy('branch.name', 'asc').orderBy('cash_point.kind', 'asc').execute();
}

async function onHand(db: Db | Tx, cashPointId: string): Promise<number> {
  const row = await db
    .selectFrom('cash_on_hand')
    .select('amount')
    .where('cash_point_id', '=', cashPointId)
    .executeTakeFirst();
  return row?.amount ?? 0;
}

interface PostInput {
  cashPointId: string;
  amount: number;
  reason: CashReason;
  actorId: string;
  docType?: string | null | undefined;
  docId?: string | null | undefined;
  counterpartSeq?: number | null | undefined;
  terminalId?: string | null | undefined;
  occurredAt?: Date | undefined;
  eventId?: string | undefined;
}

/**
 * Append one cash movement. Idempotent on event_id, same guarantee as the
 * stock ledger's postMovementInTx - a resynced event is a no-op, not a
 * duplicate.
 */
async function post(tx: Tx, input: PostInput): Promise<{ seq: number; amountAfter: number }> {
  const eventId = input.eventId ?? crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();

  const existing = await tx
    .selectFrom('cash_movement')
    .select('seq')
    .where('event_id', '=', eventId)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { seq: existing.seq, amountAfter: await onHand(tx, input.cashPointId) };
  }

  const inserted = await tx
    .insertInto('cash_movement')
    .values({
      event_id: eventId,
      cash_point_id: input.cashPointId,
      amount: input.amount,
      reason: input.reason,
      doc_type: input.docType ?? null,
      doc_id: input.docId ?? null,
      counterpart_seq: input.counterpartSeq ?? null,
      actor_id: input.actorId,
      terminal_id: input.terminalId ?? null,
      occurred_at: occurredAt,
    })
    .returning('seq')
    .executeTakeFirstOrThrow();

  return { seq: inserted.seq, amountAfter: await onHand(tx, input.cashPointId) };
}

/**
 * Move cash between two custody points - float out to a till, back to the
 * safe, or a deposit to the bank. One shared reason, applied to both legs;
 * the sign of `amount` on each row is what says which leg it is, and
 * counterpart_seq links them so one is always traceable to the other.
 */
export async function moveCash(
  db: Db,
  input: {
    fromCashPointId: string;
    toCashPointId: string;
    amount: number;
    reason: CashReason;
    actorId: string;
    docType?: string | null | undefined;
    occurredAt?: Date | undefined;
  },
): Promise<{ outSeq: number; inSeq: number }> {
  if (input.amount <= 0) {
    throw new DomainError('INVALID_MOVEMENT', 'A cash move must be a positive amount.', {});
  }
  if (input.fromCashPointId === input.toCashPointId) {
    throw new DomainError('INVALID_MOVEMENT', 'Source and destination must differ.', {});
  }

  return db.transaction().execute(async (tx) => {
    const available = await onHand(tx, input.fromCashPointId);
    if (available - input.amount < 0) {
      const { InsufficientCash } = await import('@retail-ops/domain');
      throw new InsufficientCash(available, input.amount);
    }

    const docId = crypto.randomUUID();
    const out = await post(tx, {
      cashPointId: input.fromCashPointId,
      amount: -input.amount,
      reason: input.reason,
      actorId: input.actorId,
      docType: input.docType ?? 'CASH_MOVE',
      docId,
      occurredAt: input.occurredAt,
    });
    // Only this second leg can carry the link at insert time - the first
    // leg's row exists already and cash_movement is append-only, so there is
    // no going back to backfill it (the trigger that refused the attempt is
    // doing exactly its job). One direction is enough: finding the other
    // side of a movement means matching on doc_id (shared by both legs) or
    // walking counterpart_seq from whichever leg has it.
    const inn = await post(tx, {
      cashPointId: input.toCashPointId,
      amount: input.amount,
      reason: input.reason,
      actorId: input.actorId,
      docType: input.docType ?? 'CASH_MOVE',
      docId,
      counterpartSeq: out.seq,
      occurredAt: input.occurredAt,
    });

    return { outSeq: out.seq, inSeq: inn.seq };
  });
}

/** Seed a custody point's opening balance. Refuses to run twice on the same point. */
export async function openCashPoint(
  db: Db,
  input: { cashPointId: string; amount: number; actorId: string },
): Promise<{ seq: number }> {
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('cash_movement')
      .select('seq')
      .where('cash_point_id', '=', input.cashPointId)
      .where('reason', '=', 'opening_balance')
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new DomainError('INVALID_MOVEMENT', 'This custody point already has an opening balance.', {
        cashPointId: input.cashPointId,
      });
    }
    const posted = await post(tx, {
      cashPointId: input.cashPointId,
      amount: input.amount,
      reason: 'opening_balance',
      actorId: input.actorId,
    });
    return { seq: posted.seq };
  });
}

export interface CashCountResult {
  cashPointId: string;
  expected: number;
  counted: number;
  variance: number;
}

/**
 * The blind count itself. Takes only what was physically counted - the
 * caller (the API layer) never receives `expected` before this runs, which
 * is what makes the count blind rather than a confirmation dialog. Posts a
 * reconciling movement and, if the count does not match, raises
 * `cash_variance` valued at the variance itself - there is no cost to
 * derive, unlike a stock count's WAC, since cash's value is its face amount.
 */
export async function postCashCount(
  db: Db,
  input: { cashPointId: string; countedAmount: number; actorId: string; occurredAt?: Date | undefined },
): Promise<CashCountResult> {
  return db.transaction().execute(async (tx) => {
    const expected = await onHand(tx, input.cashPointId);
    const assessment = computeCountVariance(expected, input.countedAmount, 1);

    if (assessment.variance !== 0) {
      const posted = await post(tx, {
        cashPointId: input.cashPointId,
        amount: assessment.variance,
        reason: 'cash_variance',
        actorId: input.actorId,
        docType: 'CASH_COUNT',
        occurredAt: input.occurredAt,
      });

      const cashPoint = await tx
        .selectFrom('cash_point')
        .select(['branch_id', 'terminal_id'])
        .where('id', '=', input.cashPointId)
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('exception_event')
        .values({
          event_id: crypto.randomUUID(),
          kind: 'cash_variance',
          branch_id: cashPoint.branch_id,
          terminal_id: cashPoint.terminal_id,
          actor_id: input.actorId,
          product_id: null,
          detail: JSON.stringify({
            cashPointId: input.cashPointId,
            expected,
            counted: input.countedAmount,
            variance: assessment.variance,
            movementSeq: posted.seq,
          }),
          value_impact: assessment.valueImpact,
          currency: 'USD',
          occurred_at: input.occurredAt ?? new Date(),
        })
        .execute();
    }

    return {
      cashPointId: input.cashPointId,
      expected,
      counted: input.countedAmount,
      variance: assessment.variance,
    };
  });
}

export async function cashLedger(
  db: Db,
  filter: { cashPointId?: string | undefined; limit?: number | undefined } = {},
): Promise<
  {
    seq: number;
    amount: number;
    reason: CashReason;
    docType: string | null;
    occurredAt: Date;
    cashPointName: string;
    actorName: string | null;
  }[]
> {
  let query = db
    .selectFrom('cash_movement')
    .innerJoin('cash_point', 'cash_point.id', 'cash_movement.cash_point_id')
    .leftJoin('person', 'person.id', 'cash_movement.actor_id')
    .select([
      'cash_movement.seq',
      'cash_movement.amount',
      'cash_movement.reason',
      'cash_movement.doc_type as docType',
      'cash_movement.occurred_at as occurredAt',
      'cash_point.name as cashPointName',
      'person.full_name as actorName',
    ]);

  if (filter.cashPointId !== undefined) query = query.where('cash_movement.cash_point_id', '=', filter.cashPointId);

  return query.orderBy('cash_movement.seq', 'desc').limit(filter.limit ?? 100).execute();
}
