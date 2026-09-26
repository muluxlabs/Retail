/**
 * Cashier shifts: open a till with a counted float, sell, close it with a blind count.
 *
 * Opening reads what the till should hold and posts any difference from the
 * count straight away, so the new cashier starts from what is really there.
 * Closing does the same and names the cashier on any over or short. The shift
 * report explains the expected cash line by line from the till's own ledger.
 */

import {
  fromCents,
  InvalidShift,
  shiftCash,
  ShiftAlreadyOpen,
  ShiftRequired,
  ShiftsStillOpen,
  toCents,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { onHand as cashOnHand, post as postCash } from './cash.js';
import { branchNumber } from './purchasing.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

const n = (v: unknown): number => Number(v ?? 0);

function isMoney(x: number): boolean {
  return x >= 0 && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
}

export async function shiftsRequired(db: Db | Tx): Promise<boolean> {
  const r = await db.selectFrom('system_setting').select('value').where('key', '=', 'shifts_required').executeTakeFirst();
  return r?.value === 'yes';
}

async function raiseVariance(
  tx: Tx,
  shift: { id: string; shiftNo: string; branchId: string; cashPointId: string; till: string; cashier: string },
  actorId: string,
  phase: 'open' | 'close',
  expectedCents: number,
  countedCents: number,
  at: Date,
): Promise<void> {
  const varianceCents = countedCents - expectedCents;
  if (varianceCents === 0) return;
  const posted = await postCash(tx, {
    cashPointId: shift.cashPointId,
    amount: fromCents(varianceCents),
    reason: 'cash_variance',
    actorId,
    docType: phase === 'open' ? 'SHIFT_OPEN' : 'SHIFT_CLOSE',
    docId: shift.id,
    occurredAt: at,
  });
  await tx
    .insertInto('exception_event')
    .values({
      event_id: crypto.randomUUID(),
      kind: 'shift_variance',
      branch_id: shift.branchId,
      terminal_id: null,
      actor_id: actorId,
      product_id: null,
      detail: JSON.stringify({
        shiftId: shift.id, shiftNo: shift.shiftNo, phase, till: shift.till, cashier: shift.cashier,
        expected: fromCents(expectedCents), counted: fromCents(countedCents), variance: fromCents(varianceCents), movementSeq: posted.seq,
      }),
      value_impact: fromCents(varianceCents),
      currency: 'USD',
      occurred_at: at,
    })
    .execute();
}

// -- opening --------------------------------------------------------------------------------------------

export interface OpenInput {
  id: string;
  branchId: string;
  cashPointId: string;
  cashierId: string;
  /** Who counted the float: the cashier, or a supervisor opening for them. */
  openedBy: string;
  counted: number;
  note?: string | null;
}

export async function openShift(db: Db, input: OpenInput): Promise<{ id: string; shiftNo: string; replayed: boolean }> {
  const done = await db.selectFrom('shift').select(['id', 'shift_no', 'cashier_id']).where('id', '=', input.id).executeTakeFirst();
  if (done !== undefined) return { id: done.id, shiftNo: done.shift_no, replayed: true };
  if (!isMoney(input.counted)) throw new InvalidShift('The float counted is an amount of money: zero or more, at most two decimal places.');
  try {
    const r = await db.transaction().execute(async (tx) => {
      const till = await sql<{ id: string; name: string; branchId: string; kind: string; isActive: boolean }>`
        SELECT id, name, branch_id AS "branchId", kind, is_active AS "isActive" FROM cash_point WHERE id = ${input.cashPointId}::uuid FOR UPDATE`.execute(tx);
      const t = till.rows[0];
      if (t === undefined || t.kind !== 'till' || t.branchId !== input.branchId || !t.isActive) throw new InvalidShift('That is not a till at this branch.');
      const onTill = await tx.selectFrom('shift').innerJoin('person', 'person.id', 'shift.cashier_id').select(['person.full_name as name']).where('shift.cash_point_id', '=', t.id).where('shift.closed_at', 'is', null).executeTakeFirst();
      if (onTill !== undefined) throw new ShiftAlreadyOpen(`${t.name} is already on ${onTill.name}'s shift. It must be closed first.`);
      const mine = await tx.selectFrom('shift').innerJoin('cash_point', 'cash_point.id', 'shift.cash_point_id').select(['cash_point.name as till']).where('shift.cashier_id', '=', input.cashierId).where('shift.closed_at', 'is', null).executeTakeFirst();
      if (mine !== undefined) throw new ShiftAlreadyOpen(`You already have a shift open on ${mine.till}. Close it first.`);
      const cashier = await tx.selectFrom('person').select('full_name').where('id', '=', input.cashierId).executeTakeFirstOrThrow();

      const at = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!.now;
      const expectedCents = toCents(n(await cashOnHand(tx, t.id)));
      const countedCents = toCents(input.counted);
      const shiftNo = await branchNumber(tx, input.branchId, 'SH', (await tx.selectFrom('branch').select('code').where('id', '=', input.branchId).executeTakeFirstOrThrow()).code);
      await tx
        .insertInto('shift')
        .values({
          id: input.id, shift_no: shiftNo, branch_id: input.branchId, cash_point_id: t.id, cashier_id: input.cashierId,
          opened_at: at, opened_by: input.openedBy, opening_expected: fromCents(expectedCents), opening_counted: fromCents(countedCents),
          opening_variance: fromCents(countedCents - expectedCents), note: input.note ?? null,
        })
        .execute();
      await raiseVariance(tx, { id: input.id, shiftNo, branchId: input.branchId, cashPointId: t.id, till: t.name, cashier: cashier.full_name }, input.openedBy, 'open', expectedCents, countedCents, at);
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(), action_code: 'SHIFT_OPENED', actor_id: input.openedBy, terminal_id: null, branch_id: input.branchId,
          entity_type: 'shift', entity_id: input.id, state_before: null,
          state_after: JSON.stringify({ shiftNo, till: t.name, cashier: cashier.full_name, expected: fromCents(expectedCents), counted: fromCents(countedCents) }),
          occurred_at: at,
        })
        .execute();
      return { id: input.id, shiftNo };
    });
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && (e.constraint === 'shift_one_open_per_till' || e.constraint === 'shift_one_open_per_cashier')) {
      throw new ShiftAlreadyOpen('Someone opened a shift on this till at the same moment. Refresh and try again.');
    }
    if (e?.code === '23505' && e.constraint === 'shift_pkey') {
      const won = await db.selectFrom('shift').select(['id', 'shift_no']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, shiftNo: won.shift_no, replayed: true };
    }
    throw error;
  }
}

// -- closing --------------------------------------------------------------------------------------------

export async function closeShift(
  db: Db,
  input: { shiftId: string; closedBy: string; counted: number; note?: string | null; canManage: boolean },
): Promise<{ id: string; shiftNo: string; variance: number }> {
  if (!isMoney(input.counted)) throw new InvalidShift('The cash counted is an amount of money: zero or more, at most two decimal places.');
  return db.transaction().execute(async (tx) => {
    const s = await tx.selectFrom('shift').selectAll().where('id', '=', input.shiftId).forUpdate().executeTakeFirst();
    if (s === undefined) throw new InvalidShift('No such shift.');
    if (s.closed_at !== null) throw new InvalidShift(`${s.shift_no} is already closed.`);
    if (s.cashier_id !== input.closedBy && !input.canManage) {
      throw Object.assign(new Error('Only the cashier on the shift, or a supervisor, can close it.'), { statusCode: 403, code: 'NOT_PERMITTED' });
    }
    await sql`SELECT id FROM cash_point WHERE id = ${s.cash_point_id}::uuid FOR UPDATE`.execute(tx);
    const till = await tx.selectFrom('cash_point').select('name').where('id', '=', s.cash_point_id).executeTakeFirstOrThrow();
    const cashier = await tx.selectFrom('person').select('full_name').where('id', '=', s.cashier_id).executeTakeFirstOrThrow();
    const at = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!.now;
    const expectedCents = toCents(n(await cashOnHand(tx, s.cash_point_id)));
    const countedCents = toCents(input.counted);
    await raiseVariance(
      tx,
      { id: s.id, shiftNo: s.shift_no, branchId: s.branch_id, cashPointId: s.cash_point_id, till: till.name, cashier: cashier.full_name },
      input.closedBy, 'close', expectedCents, countedCents, at,
    );
    await tx
      .updateTable('shift')
      .set({
        closed_at: at, closed_by: input.closedBy, closing_expected: fromCents(expectedCents), closing_counted: fromCents(countedCents),
        closing_variance: fromCents(countedCents - expectedCents),
      })
      .where('id', '=', s.id)
      .execute();
    await tx
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(), action_code: 'SHIFT_CLOSED', actor_id: input.closedBy, terminal_id: null, branch_id: s.branch_id,
        entity_type: 'shift', entity_id: s.id, state_before: null,
        state_after: JSON.stringify({ shiftNo: s.shift_no, expected: fromCents(expectedCents), counted: fromCents(countedCents), note: input.note ?? null }),
        occurred_at: at,
      })
      .execute();
    return { id: s.id, shiftNo: s.shift_no, variance: fromCents(countedCents - expectedCents) };
  });
}

// -- the till at the moment of a sale ------------------------------------------------------------------------

/**
 * The shift a sale belongs to. With shifts required, the cashier must have their
 * own shift open on the till. Either way, a till on another cashier's shift
 * cannot be sold on by someone else.
 */
export async function shiftForSale(tx: Tx, cashPointId: string | null, cashierId: string): Promise<string | null> {
  const required = await shiftsRequired(tx);
  if (cashPointId === null) return null;
  const open = await tx
    .selectFrom('shift')
    .innerJoin('person', 'person.id', 'shift.cashier_id')
    .innerJoin('cash_point', 'cash_point.id', 'shift.cash_point_id')
    .select(['shift.id', 'shift.cashier_id as cashierId', 'person.full_name as cashier', 'cash_point.name as till'])
    .where('shift.cash_point_id', '=', cashPointId)
    .where('shift.closed_at', 'is', null)
    .executeTakeFirst();
  if (open !== undefined && open.cashierId !== cashierId) {
    throw new ShiftAlreadyOpen(`${open.till} is on ${open.cashier}'s shift. Sell on your own till, or ask them to close their shift.`);
  }
  if (open !== undefined) return open.id;
  if (required) {
    const till = await tx.selectFrom('cash_point').select('name').where('id', '=', cashPointId).executeTakeFirst();
    throw new ShiftRequired(till?.name ?? 'this till');
  }
  return null;
}

/** End of day waits for every shift at the branch to be closed. */
export async function assertNoOpenShifts(tx: Tx, branchId: string): Promise<void> {
  const open = await tx
    .selectFrom('shift')
    .innerJoin('person', 'person.id', 'shift.cashier_id')
    .innerJoin('cash_point', 'cash_point.id', 'shift.cash_point_id')
    .select(['person.full_name as cashier', 'cash_point.name as till'])
    .where('shift.branch_id', '=', branchId)
    .where('shift.closed_at', 'is', null)
    .execute();
  if (open.length > 0) throw new ShiftsStillOpen(open);
}

// -- the report ------------------------------------------------------------------------------------------------

export async function shiftReport(db: Db, id: string) {
  const s = await sql<Record<string, unknown>>`
    SELECT sh.*, pe.full_name AS "cashierName", cp.name AS "tillName", b.name AS "branchName", cb.full_name AS "closedByName"
    FROM shift sh JOIN person pe ON pe.id = sh.cashier_id JOIN cash_point cp ON cp.id = sh.cash_point_id
    JOIN branch b ON b.id = sh.branch_id LEFT JOIN person cb ON cb.id = sh.closed_by
    WHERE sh.id = ${id}::uuid`.execute(db);
  const row = s.rows[0];
  if (row === undefined) return undefined;
  const openedAt = row['opened_at'] as Date;
  const closedAt = (row['closed_at'] as Date | null) ?? null;

  const [sales, byPayment, moves, nowOnHand] = await Promise.all([
    sql<{ receipts: number; net: number; first: string | null; last: string | null }>`
      SELECT count(*)::int AS receipts, coalesce(sum(net_total), 0) AS net, min(receipt_no) AS first, max(receipt_no) AS last
      FROM sale WHERE shift_id = ${id}::uuid`.execute(db),
    sql<{ name: string; receipts: number; amount: number }>`
      SELECT t.name, count(DISTINCT p.sale_id)::int AS receipts, coalesce(sum(p.amount), 0) AS amount
      FROM sale s JOIN sale_payment p ON p.sale_id = s.id JOIN payment_type t ON t.id = p.payment_type_id
      WHERE s.shift_id = ${id}::uuid GROUP BY t.name, t.sort_order ORDER BY t.sort_order`.execute(db),
    // Cash that moved through the till while the shift was open, by when it was RECORDED
    // (a supplier payment dated last week still left the till today). The shift's own
    // counting entries are not movements of the shift.
    sql<{ reason: string; amount: number }>`
      SELECT reason::text, sum(amount) AS amount FROM cash_movement
      WHERE cash_point_id = ${row['cash_point_id'] as string}::uuid
        AND recorded_at >= ${openedAt}
        AND (${closedAt}::timestamptz IS NULL OR recorded_at <= ${closedAt})
        AND (doc_id IS DISTINCT FROM ${id}::uuid)
      GROUP BY reason`.execute(db),
    cashOnHand(db, row['cash_point_id'] as string),
  ]);
  const cash = shiftCash(toCents(n(row['opening_counted'])), moves.rows.map((m) => ({ reason: m.reason, cents: toCents(n(m.amount)) })));
  // The ledger is the authority. If anything moved in a way the lines above cannot place, say so.
  const ledgerExpected = closedAt === null ? toCents(n(nowOnHand)) : toCents(n(row['closing_expected']));
  const unexplained = ledgerExpected - cash.expectedCents;
  const sm = sales.rows[0];
  return {
    id,
    shiftNo: row['shift_no'],
    branchId: row['branch_id'],
    branchName: row['branchName'],
    tillId: row['cash_point_id'],
    tillName: row['tillName'],
    cashierId: row['cashier_id'],
    cashierName: row['cashierName'],
    openedAt,
    closedAt,
    closedByName: row['closedByName'] ?? null,
    opening: { expected: n(row['opening_expected']), counted: n(row['opening_counted']), variance: n(row['opening_variance']) },
    closing: closedAt === null ? null : { expected: n(row['closing_expected']), counted: n(row['closing_counted']), variance: n(row['closing_variance']) },
    sales: { receipts: n(sm?.receipts), net: n(sm?.net), firstReceipt: sm?.first ?? null, lastReceipt: sm?.last ?? null },
    byPayment: byPayment.rows.map((p) => ({ name: p.name, receipts: n(p.receipts), amount: n(p.amount) })),
    cash: {
      opening: fromCents(cash.openingCents),
      lines: cash.lines,
      other: fromCents(unexplained),
      expected: fromCents(ledgerExpected),
    },
  };
}
