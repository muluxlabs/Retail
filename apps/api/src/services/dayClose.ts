/**
 * End of day: the X report (the day so far) and the Z report (closing it).
 *
 * A close covers the receipts numbered after the previous close's last one, up
 * to the branch's receipt counter at the moment of closing - read under the
 * same lock checkout takes to number a sale, so no receipt can fall between two
 * closes. Every till is counted blind in the same transaction: the expected
 * cash is read only after the counts are in hand, any over or short is posted
 * to the till and raised as a cash variance, and the Z document records it all.
 */

import { fromCents, InvalidDayClose, reconcileTills, toCents } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { onHand as cashOnHand, post as postCash } from './cash.js';
import { branchNumber, businessTimezone, dayIn } from './purchasing.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

const n = (v: unknown): number => Number(v ?? 0);
const r2 = (v: unknown): number => Math.round(n(v) * 100) / 100;

export interface DayFigures {
  fromReceiptNo: number;
  toReceiptNo: number;
  firstReceipt: string | null;
  lastReceipt: string | null;
  receipts: number;
  gross: number;
  discounts: number;
  net: number;
  cost: number;
  grossProfit: number;
  uncostedNet: number;
  cashTaken: number;
  byPayment: { paymentTypeId: string; name: string; receipts: number; amount: number }[];
  byCashier: { cashierId: string; name: string; receipts: number; net: number }[];
}

/** Sales on receipts numbered after `fromNo` up to `toNo` at a branch. */
export async function dayFigures(db: Db | Tx, branchId: string, fromNo: number, toNo: number): Promise<DayFigures> {
  const inRange = sql`s.branch_id = ${branchId}::uuid
    AND substring(s.receipt_no from '(\\d+)$')::bigint > ${fromNo}
    AND substring(s.receipt_no from '(\\d+)$')::bigint <= ${toNo}`;
  const [tot, pay, cashier, ends] = await Promise.all([
    sql<Record<string, unknown>>`
      SELECT count(DISTINCT s.id)::int AS receipts,
             coalesce(sum(l.line_total + l.discount), 0) AS gross,
             coalesce(sum(l.discount), 0) AS discounts,
             coalesce(sum(l.line_total), 0) AS net,
             coalesce(sum(round(l.qty_base * l.unit_cost, 2)), 0) AS cost,
             coalesce(sum(l.line_total) FILTER (WHERE l.unit_cost IS NOT NULL), 0) AS "costedNet",
             coalesce(sum(l.line_total) FILTER (WHERE l.unit_cost IS NULL), 0) AS "uncostedNet"
      FROM sale s JOIN sale_line l ON l.sale_id = s.id WHERE ${inRange}`.execute(db),
    sql<Record<string, unknown>>`
      SELECT t.id AS "paymentTypeId", t.name, t.is_cash AS "isCash", count(DISTINCT p.sale_id)::int AS receipts, coalesce(sum(p.amount), 0) AS amount
      FROM sale s JOIN sale_payment p ON p.sale_id = s.id JOIN payment_type t ON t.id = p.payment_type_id
      WHERE ${inRange} GROUP BY t.id, t.name, t.is_cash, t.sort_order ORDER BY t.sort_order`.execute(db),
    sql<Record<string, unknown>>`
      SELECT pe.id AS "cashierId", pe.full_name AS name, count(*)::int AS receipts, coalesce(sum(s.net_total), 0) AS net
      FROM sale s JOIN person pe ON pe.id = s.cashier_id WHERE ${inRange}
      GROUP BY pe.id, pe.full_name ORDER BY sum(s.net_total) DESC`.execute(db),
    sql<{ first: string | null; last: string | null }>`
      SELECT (SELECT s.receipt_no FROM sale s WHERE ${inRange} ORDER BY substring(s.receipt_no from '(\\d+)$')::bigint ASC LIMIT 1) AS first,
             (SELECT s.receipt_no FROM sale s WHERE ${inRange} ORDER BY substring(s.receipt_no from '(\\d+)$')::bigint DESC LIMIT 1) AS last`.execute(db),
  ]);
  const t = tot.rows[0] ?? {};
  const byPayment = pay.rows.map((p) => ({ paymentTypeId: String(p['paymentTypeId']), name: String(p['name']), receipts: n(p['receipts']), amount: r2(p['amount']), isCash: Boolean(p['isCash']) }));
  return {
    fromReceiptNo: fromNo,
    toReceiptNo: toNo,
    firstReceipt: ends.rows[0]?.first ?? null,
    lastReceipt: ends.rows[0]?.last ?? null,
    receipts: n(t['receipts']),
    gross: r2(t['gross']),
    discounts: r2(t['discounts']),
    net: r2(t['net']),
    cost: r2(t['cost']),
    grossProfit: r2(n(t['costedNet']) - n(t['cost'])),
    uncostedNet: r2(t['uncostedNet']),
    cashTaken: r2(byPayment.filter((p) => p.isCash).reduce((s, p) => s + p.amount, 0)),
    byPayment: byPayment.map(({ isCash: _c, ...rest }) => rest),
    byCashier: cashier.rows.map((c) => ({ cashierId: String(c['cashierId']), name: String(c['name']), receipts: n(c['receipts']), net: r2(c['net']) })),
  };
}

interface LastClose {
  id: string;
  closeNo: string;
  periodTo: Date;
  toReceiptNo: number;
}

async function lastClose(db: Db | Tx, branchId: string): Promise<LastClose | null> {
  const r = await sql<LastClose>`
    SELECT id, close_no AS "closeNo", period_to AS "periodTo", to_receipt_no AS "toReceiptNo"
    FROM day_close WHERE branch_id = ${branchId}::uuid ORDER BY period_to DESC LIMIT 1`.execute(db);
  const row = r.rows[0];
  return row === undefined ? null : { ...row, toReceiptNo: n(row.toReceiptNo) };
}

async function receiptCounter(db: Db | Tx, branchId: string, lock: boolean): Promise<number> {
  const r = lock
    ? await sql<{ n: number }>`SELECT last_no AS n FROM document_counter WHERE branch_id = ${branchId}::uuid AND doc_kind = 'SALE' FOR UPDATE`.execute(db)
    : await sql<{ n: number }>`SELECT last_no AS n FROM document_counter WHERE branch_id = ${branchId}::uuid AND doc_kind = 'SALE'`.execute(db);
  return n(r.rows[0]?.n);
}

async function tills(db: Db | Tx, branchId: string): Promise<{ id: string; name: string }[]> {
  return db.selectFrom('cash_point').select(['id', 'name']).where('branch_id', '=', branchId).where('kind', '=', 'till').where('is_active', '=', true).orderBy('name').execute();
}

/** The X report: the day so far, since the last close. Shows no expected cash, so counts stay blind. */
export async function previewDay(db: Db, branchId: string) {
  const prev = await lastClose(db, branchId);
  const to = await receiptCounter(db, branchId, false);
  return {
    lastClose: prev === null ? null : { id: prev.id, closeNo: prev.closeNo, at: prev.periodTo },
    since: prev?.periodTo ?? null,
    figures: await dayFigures(db, branchId, prev?.toReceiptNo ?? 0, to),
    tills: await tills(db, branchId),
  };
}

export interface CloseInput {
  id: string;
  branchId: string;
  closedBy: string;
  note?: string | null;
  counts: { cashPointId: string; counted: number }[];
}

export async function closeDay(db: Db, input: CloseInput): Promise<{ id: string; closeNo: string; replayed: boolean }> {
  const done = await db.selectFrom('day_close').select(['id', 'close_no']).where('id', '=', input.id).executeTakeFirst();
  if (done !== undefined) return { id: done.id, closeNo: done.close_no, replayed: true };
  try {
    const r = await db.transaction().execute((tx) => runClose(tx, input));
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && (e.constraint === 'day_close_pkey' || e.constraint === 'day_close_one_start')) {
      const won = await db.selectFrom('day_close').select(['id', 'close_no']).where('id', '=', input.id).executeTakeFirst();
      if (won !== undefined) return { id: won.id, closeNo: won.close_no, replayed: true };
      throw new InvalidDayClose('Someone else closed the day at this branch at the same moment. Open the latest Z report.');
    }
    throw error;
  }
}

async function runClose(tx: Tx, input: CloseInput): Promise<{ id: string; closeNo: string }> {
  const branch = await tx.selectFrom('branch').select(['id', 'code', 'name', 'is_active']).where('id', '=', input.branchId).executeTakeFirst();
  if (branch === undefined || !branch.is_active) throw new InvalidDayClose('That branch is not available.');

  // One close at a time per branch, and no sale can take a number while we read the counter.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'day_close' + input.branchId}, 0))`.execute(tx);
  const toNo = await receiptCounter(tx, input.branchId, true);
  const prev = await lastClose(tx, input.branchId);
  const fromNo = prev?.toReceiptNo ?? 0;
  const now = new Date();

  // Count first; only then read what the books expect (the count is blind).
  const tillList = await tills(tx, input.branchId);
  for (const t of tillList) await sql`SELECT id FROM cash_point WHERE id = ${t.id}::uuid FOR UPDATE`.execute(tx);
  const counts = input.counts.map((c) => {
    if (!(c.counted >= 0) || Math.abs(c.counted * 100 - Math.round(c.counted * 100)) > 1e-6) {
      throw new InvalidDayClose('A count is an amount of money: zero or more, at most two decimal places.');
    }
    return { cashPointId: c.cashPointId, countedCents: toCents(c.counted) };
  });
  const expected = [];
  for (const t of tillList) expected.push({ id: t.id, name: t.name, expectedCents: toCents(n(await cashOnHand(tx, t.id))) });
  const rec = reconcileTills(expected, counts);

  const closeNo = await branchNumber(tx, input.branchId, 'Z', branch.code);
  for (const t of rec) {
    if (t.varianceCents === 0) continue;
    const posted = await postCash(tx, {
      cashPointId: t.id,
      amount: fromCents(t.varianceCents),
      reason: 'cash_variance',
      actorId: input.closedBy,
      docType: 'DAY_CLOSE',
      docId: input.id,
      occurredAt: now,
    });
    await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'cash_variance',
        branch_id: input.branchId,
        terminal_id: null,
        actor_id: input.closedBy,
        product_id: null,
        detail: JSON.stringify({
          cashPointId: t.id,
          till: t.name,
          expected: fromCents(t.expectedCents),
          counted: fromCents(t.countedCents),
          variance: fromCents(t.varianceCents),
          movementSeq: posted.seq,
          closeNo,
        }),
        value_impact: fromCents(t.varianceCents),
        currency: 'USD',
        occurred_at: now,
      })
      .execute();
  }

  const f = await dayFigures(tx, input.branchId, fromNo, toNo);
  const exceptions = await sql<{ kind: string; n: number }>`
    SELECT kind::text, count(*)::int AS n FROM exception_event
    WHERE branch_id = ${input.branchId}::uuid AND occurred_at > ${prev?.periodTo ?? new Date(0)} AND occurred_at <= ${now}
    GROUP BY kind ORDER BY kind`.execute(tx);
  const sum = (k: 'expectedCents' | 'countedCents' | 'varianceCents') => rec.reduce((s, t) => s + t[k], 0);
  const tz = await businessTimezone(tx);

  await tx
    .insertInto('day_close')
    .values({
      id: input.id,
      close_no: closeNo,
      branch_id: input.branchId,
      business_day: dayIn(tz, now),
      period_from: prev?.periodTo ?? null,
      period_to: now,
      from_receipt_no: fromNo,
      to_receipt_no: toNo,
      closed_by: input.closedBy,
      note: input.note ?? null,
      receipts: f.receipts,
      gross_sales: f.gross,
      discounts: f.discounts,
      net_sales: f.net,
      cost_of_sales: f.cost,
      cash_expected: fromCents(sum('expectedCents')),
      cash_counted: fromCents(sum('countedCents')),
      cash_variance: fromCents(sum('varianceCents')),
      detail: JSON.stringify({
        figures: f,
        tills: rec.map((t) => ({ id: t.id, name: t.name, expected: fromCents(t.expectedCents), counted: fromCents(t.countedCents), variance: fromCents(t.varianceCents) })),
        exceptions: exceptions.rows.map((e) => ({ kind: e.kind, count: n(e.n) })),
        previousClose: prev === null ? null : { id: prev.id, closeNo: prev.closeNo },
      }),
    })
    .execute();
  await tx
    .insertInto('audit_log')
    .values({
      event_id: crypto.randomUUID(),
      action_code: 'DAY_CLOSED',
      actor_id: input.closedBy,
      terminal_id: null,
      branch_id: input.branchId,
      entity_type: 'day_close',
      entity_id: input.id,
      state_before: null,
      state_after: JSON.stringify({ closeNo, receipts: f.receipts, net: f.net, cashVariance: fromCents(sum('varianceCents')) }),
      occurred_at: now,
    })
    .execute();
  return { id: input.id, closeNo };
}
