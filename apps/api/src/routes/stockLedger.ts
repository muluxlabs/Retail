/**
 * The stock ledger in the form an accountant reads it.
 *
 * The raw movement list (GET /movements) is the audit trail as stored. This is
 * the same data presented as a stores ledger - a bin card - with the four
 * things every accountant looks for: an OPENING BALANCE brought forward,
 * dated RECEIPTS and ISSUES with a running balance, a CLOSING BALANCE carried
 * forward, and proof that the closing balance agrees to stock on hand.
 *
 * Why this exists: an experienced auditor could not make sense of the old
 * Ledger screen, because "opening balance" appeared in it as an ordinary row -
 * a movement dated whenever the stock happened to be loaded - rather than as
 * what the words mean in accounts: the balance at the START of a period.
 * Here the two are kept apart. A period's opening balance is computed from
 * everything before it; a movement that introduced opening stock is shown as
 * a receipt, under its own name.
 *
 * Ordering is by business date (occurred_at), then posting order (seq) - the
 * order in which things HAPPENED, which is what a ledger is read in. An entry
 * recorded late still lands on the date it belongs to; the late-recording gap
 * is shown beside it rather than hidden.
 *
 * Every figure is summed from the movements on each request. Nothing stored.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Database } from '@retail-ops/db';
import type { Kysely } from 'kysely';

import { businessTimezone } from '../services/purchasing.js';
import { parseQuery } from '../validation.js';

/** Inclusive calendar dates in, a half-open [from, toExclusive) interval out. */
const periodQuery = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/**
 * The period on the BUSINESS calendar: a day starts at midnight in the business
 * time zone, not at midnight UTC, so a sale at 00:30 in Harare is on the day the
 * shop thinks it is - the same day the sales and item reports put it on.
 */
async function resolvePeriod(db: Kysely<Database>, from: Date | undefined, to: Date | undefined) {
  const tz = await businessTimezone(db);
  const { rows } = await sql<{ today: string; monthStart: string }>`
    SELECT to_char((now() AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS today,
           to_char(date_trunc('month', now() AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS "monthStart"`.execute(db);
  const fromDay = from?.toISOString().slice(0, 10) ?? rows[0]!.monthStart;
  const toDay = to?.toISOString().slice(0, 10) ?? rows[0]!.today;
  const bounds = await sql<{ start: Date; toExclusive: Date }>`
    SELECT ((${fromDay}::date)::timestamp AT TIME ZONE ${tz}) AS start,
           (((${toDay}::date + 1))::timestamp AT TIME ZONE ${tz}) AS "toExclusive"`.execute(db);
  const start = bounds.rows[0]!.start;
  const toExclusive = bounds.rows[0]!.toExclusive;
  return { start, fromDay, toDay, toExclusive, reachesToday: toExclusive.getTime() > Date.now() };
}

const binCardQuery = z.object({
  branchId: z.uuid(),
  productId: z.uuid(),
  ...periodQuery,
});

const reconciliationQuery = z.object({
  branchId: z.uuid(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
  ...periodQuery,
});

/** Below this a difference is rounding in a numeric(14,4), not a real gap. */
const EPSILON = 0.00005;

interface BinRow {
  seq: number;
  occurredAt: string;
  recordedAt: string;
  reason: string;
  docType: string | null;
  reference: string | null;
  qtyIn: number;
  qtyOut: number;
  balance: number;
  unitCost: number | null;
  actorName: string | null;
  lateHours: number;
}

/**
 * One line of the reconciliation schedule, in the columns the client's own
 * inventory summary uses: starting quantity, then each kind of movement, then
 * closing. Signed: what came in is positive, what went out is negative, so the
 * columns simply add up to the closing figure.
 */
interface ReconRow {
  productId: string;
  sku: string;
  productName: string;
  baseUom: string;
  opening: number;
  purchases: number;
  transfersIn: number;
  transfersOut: number;
  sales: number;
  openingStock: number;
  adjustments: number;
  closing: number;
  onHand: number;
}

export async function registerStockLedgerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One product at one branch over a period: the bin card.
   */
  app.get('/stock-ledger', { onRequest: [app.requirePermission('stock.read')] }, async (request, reply) => {
    const q = parseQuery(binCardQuery, request.query);
    const { start, fromDay, toDay, toExclusive, reachesToday } = await resolvePeriod(app.db, q.from, q.to);

    const [branch, product] = await Promise.all([
      app.db.selectFrom('branch').select(['id', 'code', 'name']).where('id', '=', q.branchId).executeTakeFirst(),
      app.db
        .selectFrom('product')
        .select(['id', 'sku', 'name', 'base_uom as baseUom'])
        .where('id', '=', q.productId)
        .executeTakeFirst(),
    ]);
    if (branch === undefined || product === undefined) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: branch === undefined ? `No branch ${q.branchId}` : `No product ${q.productId}` },
      });
    }

    const { rows: openingRows } = await sql<{ qty: number }>`
      SELECT coalesce(sum(qty_base), 0) AS qty
      FROM stock_movement
      WHERE product_id = ${q.productId}::uuid AND branch_id = ${q.branchId}::uuid AND occurred_at < ${start}
    `.execute(app.db);
    const opening = Number(openingRows[0]?.qty ?? 0);

    const { rows } = await sql<BinRow>`
      SELECT m.seq,
             m.occurred_at AS "occurredAt",
             m.recorded_at AS "recordedAt",
             m.reason,
             m.doc_type    AS "docType",
             t.reference   AS "reference",
             greatest(m.qty_base, 0)  AS "qtyIn",
             greatest(-m.qty_base, 0) AS "qtyOut",
             ${opening}::numeric + sum(m.qty_base) OVER (ORDER BY m.occurred_at, m.seq) AS "balance",
             m.unit_cost   AS "unitCost",
             a.full_name   AS "actorName",
             round(extract(epoch FROM (m.recorded_at - m.occurred_at)) / 3600, 1) AS "lateHours"
      FROM stock_movement m
      LEFT JOIN person a ON a.id = m.actor_id
      LEFT JOIN transfer t ON t.id = m.doc_id AND m.doc_type IN ('TRANSFER', 'TRANSFER_CANCEL')
      WHERE m.product_id = ${q.productId}::uuid
        AND m.branch_id  = ${q.branchId}::uuid
        AND m.occurred_at >= ${start}
        AND m.occurred_at <  ${toExclusive}
      ORDER BY m.occurred_at, m.seq
    `.execute(app.db);

    const receipts = rows.reduce((s, r) => s + Number(r.qtyIn), 0);
    const issues = rows.reduce((s, r) => s + Number(r.qtyOut), 0);
    const closing = opening + receipts - issues;

    const onHandRow = await app.db
      .selectFrom('stock_on_hand')
      .select('qty_base')
      .where('product_id', '=', q.productId)
      .where('branch_id', '=', q.branchId)
      .executeTakeFirst();
    const onHandNow = onHandRow?.qty_base ?? 0;

    return {
      branch,
      product,
      from: fromDay,
      to: toDay,
      opening: Number(opening.toFixed(4)),
      receipts: Number(receipts.toFixed(4)),
      issues: Number(issues.toFixed(4)),
      closing: Number(closing.toFixed(4)),
      rows: rows.map((r) => ({ ...r, qtyIn: Number(r.qtyIn), qtyOut: Number(r.qtyOut), balance: Number(r.balance) })),
      onHandNow,
      // Only meaningful when the period runs up to now: an earlier period's
      // closing balance is a historical figure with nothing to be compared to.
      agreesToStockOnHand: reachesToday ? Math.abs(closing - onHandNow) < EPSILON : null,
    };
  });

  /**
   * Every product at a branch over a period, one line each:
   * opening b/f + receipts - issues = closing c/f, against stock on hand.
   */
  app.get(
    '/stock-reconciliation',
    { onRequest: [app.requirePermission('stock.read')] },
    async (request, reply) => {
      const q = parseQuery(reconciliationQuery, request.query);
      const { start, fromDay, toDay, toExclusive, reachesToday } = await resolvePeriod(app.db, q.from, q.to);

      const branch = await app.db
        .selectFrom('branch')
        .select(['id', 'code', 'name'])
        .where('id', '=', q.branchId)
        .executeTakeFirst();
      if (branch === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No branch ${q.branchId}` } });
      }

      const like = q.search === undefined ? null : `%${q.search}%`;

      // The reasons in each column; every reason lands in exactly one, which is
      // what makes the row foot. Opening stock introduced is its own column and
      // is NOT an adjustment: an auditor reading "adjustments +1,849" would
      // rightly ask what was adjusted, when the answer is that trading began.
      const inPeriod = sql`m.occurred_at >= ${start} AND m.occurred_at < ${toExclusive}`;
      const { rows } = await sql<ReconRow>`
        SELECT p.id AS "productId", p.sku, p.name AS "productName", p.base_uom AS "baseUom",
               coalesce(sum(m.qty_base) FILTER (WHERE m.occurred_at < ${start}), 0) AS "opening",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason IN ('grn', 'grn_reversal')), 0) AS "purchases",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason = 'transfer_in'), 0) AS "transfersIn",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason IN ('transfer_out', 'transfer_loss')), 0) AS "transfersOut",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason IN ('sale', 'sale_refund')), 0) AS "sales",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason = 'opening_balance'), 0) AS "openingStock",
               coalesce(sum(m.qty_base) FILTER (WHERE ${inPeriod} AND m.reason NOT IN
                 ('grn', 'grn_reversal', 'transfer_in', 'transfer_out', 'transfer_loss', 'sale', 'sale_refund', 'opening_balance')), 0) AS "adjustments",
               coalesce(sum(m.qty_base) FILTER (WHERE m.occurred_at < ${toExclusive}), 0) AS "closing",
               coalesce(max(soh.qty_base), 0) AS "onHand"
        FROM stock_movement m
        JOIN product p ON p.id = m.product_id
        LEFT JOIN stock_on_hand soh ON soh.product_id = m.product_id AND soh.branch_id = m.branch_id
        WHERE m.branch_id = ${q.branchId}::uuid
          AND (${like}::text IS NULL OR p.name ILIKE ${like} OR p.sku ILIKE ${like})
        GROUP BY p.id, p.sku, p.name, p.base_uom
        HAVING coalesce(sum(m.qty_base) FILTER (WHERE m.occurred_at < ${start}), 0) <> 0
            OR count(*) FILTER (WHERE ${inPeriod}) > 0
        ORDER BY p.name
        LIMIT ${q.limit} OFFSET ${q.offset}
      `.execute(app.db);

      const lines = rows.map((r) => {
        const opening = Number(r.opening);
        const purchases = Number(r.purchases);
        const transfersIn = Number(r.transfersIn);
        const transfersOut = Number(r.transfersOut);
        const sales = Number(r.sales);
        const openingStock = Number(r.openingStock);
        const adjustments = Number(r.adjustments);
        const closing = Number(r.closing);
        const onHand = Number(r.onHand);
        return {
          ...r,
          opening,
          purchases,
          transfersIn,
          transfersOut,
          sales,
          openingStock,
          adjustments,
          closing,
          onHand,
          // Opening plus every column must equal closing, by construction. This
          // is the check that would catch a movement reason that fell between
          // the columns, not a bad ledger.
          balanced:
            Math.abs(opening + purchases + transfersIn + transfersOut + sales + openingStock + adjustments - closing) < EPSILON,
          agreesToStockOnHand: reachesToday ? Math.abs(closing - onHand) < EPSILON : null,
        };
      });

      return {
        branch,
        from: fromDay,
        to: toDay,
        reachesToday,
        lines,
        limit: q.limit,
        offset: q.offset,
        allBalanced: lines.every((l) => l.balanced),
        allAgreeToStockOnHand: reachesToday ? lines.every((l) => l.agreesToStockOnHand === true) : null,
      };
    },
  );
}
