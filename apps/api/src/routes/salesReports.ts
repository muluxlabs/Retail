/**
 * Sales and profit reporting.
 *
 * Every figure comes from the sale documents (sale, sale_line, sale_payment),
 * never from stock movements, so each number is real money at the price the
 * customer paid and the cost the business carried at that moment.
 *
 * The accounting, stated once (this is the vocabulary an auditor expects):
 *
 *   Total sales (gross)   what the items were priced at, before discounts
 *   - Discounts           reductions given on the till
 *   = Net sales           what the customers were actually charged
 *   - Cost of sales       what the goods sold had cost the business
 *   = Gross profit        net sales less cost of sales
 *   Gross margin          gross profit / net sales
 *
 * Cost of sales uses the weighted-average cost captured on each sale line when
 * it was sold. A line whose cost was not known (nothing costed had ever been
 * received) has NULL cost, and is NOT treated as free: gross profit and margin
 * are worked out on the costed lines only, and the value of the uncosted ones
 * is reported beside them, so nobody mistakes an unknown cost for a 100% margin.
 *
 * "Today", "this week" and the hour of a sale are the BUSINESS's day, in the
 * business_timezone setting - not the server's UTC day - so a sale at 00:30 in
 * Harare belongs to the day the shop thinks it does.
 *
 * Requires sale.read. A branch-scoped manager sees only their own branches.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { parseQuery } from '../validation.js';

const DEFAULT_TIMEZONE = 'Africa/Harare';
const MAX_DAYS = 400;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-25.');

const salesQuery = z.object({
  from: day,
  to: day,
  groupBy: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  branchId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  productId: z.uuid().optional(),
  paymentTypeId: z.string().trim().min(1).max(32).optional(),
  /** Hours of the business day, 0-23, inclusive: 8 to 12 is 08:00 up to 12:59. */
  fromHour: z.coerce.number().int().min(0).max(23).optional(),
  toHour: z.coerce.number().int().min(0).max(23).optional(),
});

type Filters = z.infer<typeof salesQuery>;

const dayNumber = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const dayString = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

const round2 = (n: number | null | undefined): number => Math.round(Number(n ?? 0) * 100) / 100;

interface Totals {
  receipts: number;
  units: number;
  gross: number;
  discounts: number;
  net: number;
  cost: number;
  costedNet: number;
  uncostedNet: number;
  uncostedLines: number;
}

/** The figures every cut shares. */
const AGG = sql`
  count(DISTINCT sale_id)::int                              AS receipts,
  coalesce(sum(qty_base), 0)                                AS units,
  coalesce(sum(gross), 0)                                   AS gross,
  coalesce(sum(discount), 0)                                AS discounts,
  coalesce(sum(line_total), 0)                              AS net,
  coalesce(sum(cost), 0)                                    AS cost,
  coalesce(sum(line_total) FILTER (WHERE cost IS NOT NULL), 0) AS "costedNet",
  coalesce(sum(line_total) FILTER (WHERE cost IS NULL), 0)  AS "uncostedNet",
  (count(*) FILTER (WHERE cost IS NULL))::int               AS "uncostedLines"
`;

/** Raw aggregates to the accounting statement, with profit and margin worked out. */
function statement(t: Totals) {
  const profit = round2(Number(t.costedNet) - Number(t.cost));
  const costedNet = round2(t.costedNet);
  return {
    receipts: Number(t.receipts),
    units: Number(t.units),
    gross: round2(t.gross),
    discounts: round2(t.discounts),
    net: round2(t.net),
    cost: round2(t.cost),
    grossProfit: profit,
    // On costed sales only; null when there is nothing to divide by.
    marginPercent: costedNet > 0 ? Math.round((profit / costedNet) * 10_000) / 100 : null,
    avgBasket: Number(t.receipts) > 0 ? round2(Number(t.net) / Number(t.receipts)) : 0,
    uncostedNet: round2(t.uncostedNet),
    uncostedLines: Number(t.uncostedLines),
  };
}

export async function registerSalesReportRoutes(app: FastifyInstance): Promise<void> {
  async function businessTimezone(): Promise<string> {
    const row = await app.db
      .selectFrom('system_setting')
      .select('value')
      .where('key', '=', 'business_timezone')
      .executeTakeFirst();
    return row?.value.trim() || DEFAULT_TIMEZONE;
  }

  /** The line-level rows for a period and filter set. Everything else aggregates this. */
  function linesCte(f: Filters, from: string, to: string, tz: string, branchLimit: string[] | null): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    if (branchLimit !== null) parts.push(sql`AND s.branch_id IN (${sql.join(branchLimit)})`);
    if (f.branchId !== undefined) parts.push(sql`AND s.branch_id = ${f.branchId}`);
    if (f.cashierId !== undefined) parts.push(sql`AND s.cashier_id = ${f.cashierId}`);
    if (f.categoryId !== undefined) parts.push(sql`AND p.category_id = ${f.categoryId}`);
    if (f.productId !== undefined) parts.push(sql`AND l.product_id = ${f.productId}`);
    if (f.paymentTypeId !== undefined) {
      parts.push(sql`AND EXISTS (SELECT 1 FROM sale_payment sp WHERE sp.sale_id = s.id AND sp.payment_type_id = ${f.paymentTypeId})`);
    }
    if (f.fromHour !== undefined) parts.push(sql`AND extract(hour FROM s.occurred_at AT TIME ZONE ${tz}) >= ${f.fromHour}`);
    if (f.toHour !== undefined) parts.push(sql`AND extract(hour FROM s.occurred_at AT TIME ZONE ${tz}) <= ${f.toHour}`);

    return sql`
      SELECT s.id AS sale_id, s.branch_id, s.cashier_id, s.occurred_at,
             (s.occurred_at AT TIME ZONE ${tz}) AS local_at,
             l.product_id, l.qty_base, l.line_total, l.discount,
             (l.line_total + l.discount) AS gross,
             CASE WHEN l.unit_cost IS NULL THEN NULL ELSE l.qty_base * l.unit_cost END AS cost,
             p.category_id
      FROM sale s
      JOIN sale_line l ON l.sale_id = s.id
      JOIN product p ON p.id = l.product_id
      WHERE s.occurred_at >= (${from}::date)::timestamp AT TIME ZONE ${tz}
        AND s.occurred_at <  ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
        ${sql.join(parts, sql` `)}
    `;
  }

  /**
   * The business's calendar day, so a screen asking for "today" does not have to
   * guess the shop's time zone from a browser that may be set anywhere.
   */
  app.get('/business/today', { onRequest: [app.requireAuth] }, async () => {
    const tz = await businessTimezone();
    const { rows } = await sql<{ today: string }>`SELECT to_char((now() AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS today`.execute(app.db);
    return { timezone: tz, today: rows[0]?.today ?? new Date().toISOString().slice(0, 10) };
  });

  app.get('/reports/sales', { onRequest: [app.requirePermission('sale.read')] }, async (request) => {
    const q = parseQuery(salesQuery, request.query);
    const fromN = dayNumber(q.from);
    const toN = dayNumber(q.to);
    if (toN < fromN) throw Object.assign(new Error('The end date is before the start date.'), { statusCode: 422, code: 'VALIDATION_FAILED' });
    if (toN - fromN + 1 > MAX_DAYS) {
      throw Object.assign(new Error(`Pick at most ${MAX_DAYS} days at a time.`), { statusCode: 422, code: 'VALIDATION_FAILED' });
    }
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const branchLimit = scopedBranchIds(request);
    const tz = await businessTimezone();

    // The period straight before, as long as this one, for "compared with".
    const span = toN - fromN + 1;
    const prevFrom = dayString(fromN - span);
    const prevTo = dayString(fromN - 1);

    const cur = linesCte(q, q.from, q.to, tz, branchLimit);
    const prev = linesCte(q, prevFrom, prevTo, tz, branchLimit);

    const bucket =
      q.groupBy === 'hour'
        ? sql<string>`to_char(date_trunc('hour', local_at), 'YYYY-MM-DD HH24":00"')`
        : q.groupBy === 'day'
          ? sql<string>`to_char(local_at::date, 'YYYY-MM-DD')`
          : q.groupBy === 'week'
            ? sql<string>`to_char(date_trunc('week', local_at), 'YYYY-MM-DD')`
            : sql<string>`to_char(date_trunc('month', local_at), 'YYYY-MM')`;

    /** One cut of the period: the shared figures, grouped by whatever the caller names. */
    const cut = async (
      cols: RawBuilder<unknown>,
      from: RawBuilder<unknown>,
      group: RawBuilder<unknown>,
      order: RawBuilder<unknown>,
      limit = 200,
    ) =>
      (
        await sql<Record<string, unknown>>`
          WITH x AS (${cur})
          SELECT ${cols}, ${AGG} FROM ${from}
          GROUP BY ${group}
          ORDER BY ${order} LIMIT ${limit}
        `.execute(app.db)
      ).rows;

    const decorate = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, ...statement(r as unknown as Totals) }));

    const [total, before, series, byBranch, byCategory, byProduct, byCashier, byHour, byPayment] = await Promise.all([
      sql<Totals>`WITH x AS (${cur}) SELECT ${AGG} FROM x`.execute(app.db),
      sql<Totals>`WITH x AS (${prev}) SELECT ${AGG} FROM x`.execute(app.db),

      cut(sql`${bucket} AS bucket`, sql`x`, bucket, sql`1`, 1000),

      cut(
        sql`b.id AS "branchId", b.code AS "branchCode", b.name AS "branchName"`,
        sql`x JOIN branch b ON b.id = x.branch_id`,
        sql`b.id, b.code, b.name`,
        sql`sum(line_total) DESC`,
      ),

      cut(
        sql`coalesce(c.name, 'Uncategorised') AS "categoryName"`,
        sql`x LEFT JOIN product_category c ON c.id = x.category_id`,
        sql`coalesce(c.name, 'Uncategorised')`,
        sql`sum(line_total) DESC`,
      ),

      cut(
        sql`p.id AS "productId", p.sku, p.name AS "productName"`,
        sql`x JOIN product p ON p.id = x.product_id`,
        sql`p.id, p.sku, p.name`,
        sql`sum(line_total) DESC`,
        100,
      ),

      cut(
        sql`pe.id AS "cashierId", pe.full_name AS "cashierName"`,
        sql`x JOIN person pe ON pe.id = x.cashier_id`,
        sql`pe.id, pe.full_name`,
        sql`sum(line_total) DESC`,
      ),

      // The shape of the trading day, in business hours, over the whole period.
      cut(
        sql`extract(hour FROM local_at)::int AS hour`,
        sql`x`,
        sql`extract(hour FROM local_at)`,
        sql`1`,
        24,
      ),

      // What the receipts were paid with. Receipt-level: the amount applied to
      // the bill on each tender, for every receipt that has an item in scope.
      sql<{ paymentTypeId: string; name: string; receipts: number; amount: number }>`
        WITH x AS (${cur})
        SELECT t.id AS "paymentTypeId", t.name, count(DISTINCT sp.sale_id)::int AS receipts,
               coalesce(sum(sp.amount), 0) AS amount
        FROM sale_payment sp
        JOIN payment_type t ON t.id = sp.payment_type_id
        WHERE sp.sale_id IN (SELECT sale_id FROM x)
        GROUP BY t.id, t.name, t.sort_order
        ORDER BY sum(sp.amount) DESC
      `
        .execute(app.db)
        .then((r) => r.rows),
    ]);

    return {
      timezone: tz,
      period: { from: q.from, to: q.to, days: span },
      previousPeriod: { from: prevFrom, to: prevTo },
      summary: statement(total.rows[0] as Totals),
      previous: statement(before.rows[0] as Totals),
      series: decorate(series),
      byBranch: decorate(byBranch),
      byCategory: decorate(byCategory),
      byProduct: decorate(byProduct),
      byCashier: decorate(byCashier),
      byHour: decorate(byHour),
      byPayment: byPayment.map((r) => ({ ...r, amount: round2(r.amount) })),
    };
  });
}
