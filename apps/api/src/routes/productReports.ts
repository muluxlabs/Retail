/**
 * Item analysis: what came in, what went out, and how fast.
 *
 * For every item over a period, in the layout of a stores ledger:
 *
 *   Opening stock  + Received from suppliers  +/- Transfers  +/- Adjustments  - Sold  =  Closing stock
 *
 * and from those the things a buyer actually asks:
 *
 *   Sell-through   how much of what was available (opening + received) was sold
 *   Sold per day   the pace it is selling at
 *   Days of cover  how long the stock on hand lasts at that pace
 *   Last sold      how long since anyone bought it
 *
 * Every quantity is drawn from the stock ledger, the same source and the same
 * reason grouping as the stock reconciliation, so the two can never disagree.
 * Revenue and profit for the item come from the sale documents.
 *
 * Each item also gets a plain-language status, worked out from the items in
 * the same report (so "fast" and "slow" are relative to this shop and this
 * period, not to a number someone guessed):
 *   out of stock  - sold in the period but none left
 *   not selling   - stock on hand and nothing sold in the whole period
 *   fast / slow   - the top fifth and bottom third of items that did sell, by units
 *   steady        - the rest
 *
 * Requires sale.read. A branch-scoped manager sees only their own branches.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { parseParams, parseQuery } from '../validation.js';

const DEFAULT_TIMEZONE = 'Africa/Harare';
const MAX_DAYS = 400;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-25.');

const listQuery = z.object({
  from: day,
  to: day,
  branchId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

const historyQuery = z.object({
  from: day,
  to: day,
  groupBy: z.enum(['day', 'week', 'month']).default('week'),
  branchId: z.uuid().optional(),
});

const idParams = z.object({ id: z.uuid() });

const dayNumber = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const round = (n: unknown, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(Number(n ?? 0) * f) / f;
};

export type ItemStatus = 'out_of_stock' | 'not_selling' | 'fast' | 'steady' | 'slow';

function checkRange(from: string, to: string): number {
  const span = dayNumber(to) - dayNumber(from) + 1;
  if (span < 1) throw Object.assign(new Error('The end date is before the start date.'), { statusCode: 422, code: 'VALIDATION_FAILED' });
  if (span > MAX_DAYS) throw Object.assign(new Error(`Pick at most ${MAX_DAYS} days at a time.`), { statusCode: 422, code: 'VALIDATION_FAILED' });
  return span;
}

/** Rank-based status, relative to the other items in the same report. */
export function classify(
  items: { closing: number; sold: number; perDay: number }[],
): ItemStatus[] {
  const sellers = items.filter((i) => i.sold > 0 && i.closing > 0).map((i) => i.perDay).sort((a, b) => a - b);
  // Too few items to say what "fast" means: call them steady rather than invent a ranking.
  const enough = sellers.length >= 5;
  const at = (p: number): number => sellers[Math.min(sellers.length - 1, Math.floor(p * sellers.length))] ?? 0;
  const slowCut = enough ? at(0.3) : -1;
  const fastCut = enough ? at(0.8) : Infinity;

  return items.map((i) => {
    if (i.sold > 0 && i.closing <= 0) return 'out_of_stock';
    if (i.sold <= 0 && i.closing > 0) return 'not_selling';
    if (i.sold <= 0) return 'not_selling';
    if (i.perDay >= fastCut) return 'fast';
    if (i.perDay < slowCut) return 'slow';
    return 'steady';
  });
}

export async function registerProductReportRoutes(app: FastifyInstance): Promise<void> {
  async function businessTimezone(): Promise<string> {
    const row = await app.db.selectFrom('system_setting').select('value').where('key', '=', 'business_timezone').executeTakeFirst();
    return row?.value.trim() || DEFAULT_TIMEZONE;
  }

  const startTs = (from: string, tz: string): RawBuilder<unknown> => sql`((${from}::date)::timestamp AT TIME ZONE ${tz})`;
  const endTs = (to: string, tz: string): RawBuilder<unknown> => sql`(((${to}::date + 1))::timestamp AT TIME ZONE ${tz})`;

  function branchClause(branchLimit: string[] | null, branchId: string | undefined, col: string): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    if (branchLimit !== null) parts.push(sql`AND ${sql.ref(col)} IN (${sql.join(branchLimit)})`);
    if (branchId !== undefined) parts.push(sql`AND ${sql.ref(col)} = ${branchId}`);
    return sql.join(parts, sql` `);
  }

  app.get('/reports/items', { onRequest: [app.requirePermission('sale.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const days = checkRange(q.from, q.to);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const branchLimit = scopedBranchIds(request);
    const tz = await businessTimezone();
    const start = startTs(q.from, tz);
    const end = endTs(q.to, tz);

    const { rows } = await sql<Record<string, unknown>>`
      WITH mv AS (
        SELECT m.product_id, m.qty_base, m.reason, m.occurred_at
        FROM stock_movement m
        WHERE m.occurred_at < ${end}
          ${branchClause(branchLimit, q.branchId, 'm.branch_id')}
      ),
      agg AS (
        SELECT product_id,
          coalesce(sum(qty_base) FILTER (WHERE occurred_at < ${start}), 0) AS opening,
          coalesce(sum(qty_base) FILTER (WHERE occurred_at >= ${start} AND reason IN ('grn', 'grn_reversal')), 0) AS received,
          coalesce(sum(-qty_base) FILTER (WHERE occurred_at >= ${start} AND reason IN ('sale', 'sale_refund')), 0) AS sold,
          coalesce(sum(qty_base) FILTER (WHERE occurred_at >= ${start} AND reason = 'transfer_in'), 0) AS "transfersIn",
          coalesce(sum(-qty_base) FILTER (WHERE occurred_at >= ${start} AND reason IN ('transfer_out', 'transfer_loss')), 0) AS "transfersOut",
          coalesce(sum(qty_base) FILTER (WHERE occurred_at >= ${start}
                AND reason NOT IN ('grn', 'grn_reversal', 'sale', 'sale_refund', 'transfer_in', 'transfer_out', 'transfer_loss')), 0) AS adjustments,
          coalesce(sum(qty_base), 0) AS closing,
          max(occurred_at) FILTER (WHERE reason = 'sale') AS "lastSoldAt"
        FROM mv GROUP BY product_id
      ),
      rev AS (
        SELECT l.product_id,
               coalesce(sum(l.line_total), 0) AS net,
               coalesce(sum(l.qty_base * l.unit_cost), 0) AS cost,
               coalesce(sum(l.line_total) FILTER (WHERE l.unit_cost IS NOT NULL), 0) AS "costedNet"
        FROM sale s JOIN sale_line l ON l.sale_id = s.id
        WHERE s.occurred_at >= ${start} AND s.occurred_at < ${end}
          ${branchClause(branchLimit, q.branchId, 's.branch_id')}
        GROUP BY l.product_id
      )
      SELECT p.id AS "productId", p.sku, p.name AS "productName", coalesce(c.name, 'Uncategorised') AS "categoryName",
             a.opening, a.received, a.sold, a."transfersIn", a."transfersOut", a.adjustments, a.closing,
             to_char(a."lastSoldAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS "lastSold",
             coalesce(r.net, 0) AS net, coalesce(r.cost, 0) AS cost, coalesce(r."costedNet", 0) AS "costedNet"
      FROM agg a
      JOIN product p ON p.id = a.product_id
      LEFT JOIN product_category c ON c.id = p.category_id
      LEFT JOIN rev r ON r.product_id = a.product_id
      WHERE p.merged_into_id IS NULL
        AND (a.opening <> 0 OR a.received <> 0 OR a.sold <> 0 OR a.closing <> 0)
        ${q.categoryId === undefined ? sql`` : sql`AND p.category_id = ${q.categoryId}`}
        ${q.search === undefined ? sql`` : sql`AND (p.name ILIKE ${'%' + q.search + '%'} OR p.sku ILIKE ${'%' + q.search + '%'})`}
      ORDER BY a.sold DESC, p.name
      LIMIT ${q.limit}
    `.execute(app.db);

    const items = rows.map((r) => {
      const opening = round(r['opening'], 4);
      const received = round(r['received'], 4);
      const sold = round(r['sold'], 4);
      const closing = round(r['closing'], 4);
      const available = opening + received;
      const perDay = sold / days;
      const profit = round(Number(r['costedNet']) - Number(r['cost']));
      const net = round(r['net']);
      return {
        productId: String(r['productId']),
        sku: String(r['sku']),
        productName: String(r['productName']),
        categoryName: String(r['categoryName']),
        opening,
        received,
        transfersIn: round(r['transfersIn'], 4),
        transfersOut: round(r['transfersOut'], 4),
        adjustments: round(r['adjustments'], 4),
        sold,
        closing,
        /** Share of what was available that was sold; null when nothing was available. */
        sellThroughPercent: available > 0 ? round((sold / available) * 100, 1) : null,
        perDay: round(perDay, 3),
        perWeek: round(perDay * 7, 2),
        /** How long today's stock lasts at this pace; null when it is not selling or nothing is left. */
        daysOfCover: closing > 0 && perDay > 0 ? round(closing / perDay, 1) : null,
        lastSold: (r['lastSold'] as string | null) ?? null,
        net,
        cost: round(r['cost']),
        grossProfit: profit,
        marginPercent: Number(r['costedNet']) > 0 ? round((profit / Number(r['costedNet'])) * 100, 1) : null,
      };
    });

    const statuses = classify(items.map((i) => ({ closing: i.closing, sold: i.sold, perDay: i.perDay })));
    const withStatus = items.map((i, n) => ({ ...i, status: statuses[n] as ItemStatus }));

    const count = (s: ItemStatus) => withStatus.filter((i) => i.status === s).length;
    const sum = (f: (i: (typeof withStatus)[number]) => number) => round(withStatus.reduce((t, i) => t + f(i), 0), 4);
    const available = sum((i) => i.opening + i.received);
    const soldTotal = sum((i) => i.sold);

    return {
      timezone: tz,
      period: { from: q.from, to: q.to, days },
      summary: {
        items: withStatus.length,
        itemsSold: withStatus.filter((i) => i.sold > 0).length,
        opening: sum((i) => i.opening),
        received: sum((i) => i.received),
        sold: soldTotal,
        closing: sum((i) => i.closing),
        sellThroughPercent: available > 0 ? round((soldTotal / available) * 100, 1) : null,
        outOfStock: count('out_of_stock'),
        notSelling: count('not_selling'),
        fast: count('fast'),
        steady: count('steady'),
        slow: count('slow'),
      },
      items: withStatus,
    };
  });

  /** One item's history: received, sold and stock on hand at the end of each week, month or day. */
  app.get('/reports/items/:id/history', { onRequest: [app.requirePermission('sale.read')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const q = parseQuery(historyQuery, request.query);
    checkRange(q.from, q.to);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const branchLimit = scopedBranchIds(request);
    const tz = await businessTimezone();
    const start = startTs(q.from, tz);
    const end = endTs(q.to, tz);

    const product = await app.db
      .selectFrom('product')
      .leftJoin('product_category', 'product_category.id', 'product.category_id')
      .select(['product.id', 'product.sku', 'product.name', 'product_category.name as categoryName'])
      .where('product.id', '=', id)
      .executeTakeFirst();
    if (product === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No product ${id}` } });

    const bucket =
      q.groupBy === 'day'
        ? sql<string>`to_char((m.occurred_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')`
        : q.groupBy === 'week'
          ? sql<string>`to_char(date_trunc('week', m.occurred_at AT TIME ZONE ${tz}), 'YYYY-MM-DD')`
          : sql<string>`to_char(date_trunc('month', m.occurred_at AT TIME ZONE ${tz}), 'YYYY-MM')`;

    const branchSql = branchClause(branchLimit, q.branchId, 'm.branch_id');

    const [opening, buckets, revenue] = await Promise.all([
      sql<{ opening: number }>`
        SELECT coalesce(sum(m.qty_base), 0) AS opening FROM stock_movement m
        WHERE m.product_id = ${id} AND m.occurred_at < ${start} ${branchSql}`.execute(app.db),
      sql<Record<string, unknown>>`
        SELECT ${bucket} AS bucket,
               coalesce(sum(m.qty_base) FILTER (WHERE m.reason IN ('grn', 'grn_reversal')), 0) AS received,
               coalesce(sum(-m.qty_base) FILTER (WHERE m.reason IN ('sale', 'sale_refund')), 0) AS sold,
               coalesce(sum(m.qty_base) FILTER (WHERE m.reason NOT IN ('grn', 'grn_reversal', 'sale', 'sale_refund')), 0) AS other,
               sum(m.qty_base) AS net_change
        FROM stock_movement m
        WHERE m.product_id = ${id} AND m.occurred_at >= ${start} AND m.occurred_at < ${end} ${branchSql}
        GROUP BY 1 ORDER BY 1`.execute(app.db),
      sql<{ net: number; cost: number; costedNet: number }>`
        SELECT coalesce(sum(l.line_total), 0) AS net, coalesce(sum(l.qty_base * l.unit_cost), 0) AS cost,
               coalesce(sum(l.line_total) FILTER (WHERE l.unit_cost IS NOT NULL), 0) AS "costedNet"
        FROM sale s JOIN sale_line l ON l.sale_id = s.id
        WHERE l.product_id = ${id} AND s.occurred_at >= ${start} AND s.occurred_at < ${end}
          ${branchClause(branchLimit, q.branchId, 's.branch_id')}`.execute(app.db),
    ]);

    let running = round(opening.rows[0]?.opening, 4);
    const series = buckets.rows.map((b) => {
      running = round(running + Number(b['net_change']), 4);
      return {
        bucket: String(b['bucket']),
        received: round(b['received'], 4),
        sold: round(b['sold'], 4),
        other: round(b['other'], 4),
        closing: running,
      };
    });
    const rev = revenue.rows[0];

    return {
      product: { productId: product.id, sku: product.sku, productName: product.name, categoryName: product.categoryName },
      timezone: tz,
      opening: round(opening.rows[0]?.opening, 4),
      series,
      totals: {
        received: round(series.reduce((t, s) => t + s.received, 0), 4),
        sold: round(series.reduce((t, s) => t + s.sold, 0), 4),
        net: round(rev?.net),
        cost: round(rev?.cost),
        grossProfit: round(Number(rev?.costedNet ?? 0) - Number(rev?.cost ?? 0)),
      },
    };
  });
}
