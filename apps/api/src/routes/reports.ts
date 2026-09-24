/**
 * Reporting: sales, purchases and general stock activity, by period.
 *
 * One endpoint, not three, because "sales report", "purchases report" and
 * "product history" (the client's own three names) are the same underlying
 * question asked with different filters and a different slice of the same
 * reason column - AD-6 says shared rules live in one place, and this is
 * that place for reporting instead of duplicating the aggregation three
 * times.
 *
 * Deliberately absent: a dollar figure for sales. Nothing in this system
 * ever records a selling price - a sale only ever posts a quantity - so
 * "revenue" is not a number this system can produce honestly. The Dashboard
 * already only ever reports units sold, never a sale value, for exactly
 * this reason; this follows the same rule rather than inventing one.
 * Purchases DO carry a real unit cost (Receive posts it), so that figure is
 * real money, not an estimate.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { parseQuery } from '../validation.js';

const GROUP_BY_EXPR = {
  day: sql<string>`to_char(occurred_at::date, 'YYYY-MM-DD')`,
  week: sql<string>`to_char(date_trunc('week', occurred_at), 'YYYY-MM-DD')`,
  month: sql<string>`to_char(date_trunc('month', occurred_at), 'YYYY-MM')`,
  year: sql<string>`to_char(date_trunc('year', occurred_at), 'YYYY')`,
};

const reportQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  branchId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  productId: z.uuid().optional(),
  groupBy: z.enum(['day', 'week', 'month', 'year']).default('day'),
});

/** The same seven figures, whatever the query groups by. */
function aggregates() {
  return [
    sql<number>`round(coalesce(sum(-qty_base) filter (where reason in ('sale', 'sale_refund')), 0), 4)`.as(
      'unitsSold',
    ),
    sql<number>`round(coalesce(sum(qty_base) filter (where reason in ('grn', 'grn_reversal')), 0), 4)`.as(
      'unitsReceived',
    ),
    sql<number>`round(coalesce(sum(qty_base * unit_cost) filter (where reason in ('grn', 'grn_reversal') and unit_cost is not null), 0), 2)`.as(
      'costReceived',
    ),
    sql<number>`round(coalesce(sum(-qty_base) filter (where reason = 'transfer_out'), 0), 4)`.as(
      'unitsTransferredOut',
    ),
    sql<number>`round(coalesce(sum(qty_base) filter (where reason = 'transfer_in'), 0), 4)`.as(
      'unitsTransferredIn',
    ),
    sql<number>`round(coalesce(sum(-qty_base) filter (where reason = 'write_off'), 0), 4)`.as('unitsWrittenOff'),
    sql<number>`round(coalesce(sum(qty_base) filter (where reason = 'count_adjustment'), 0), 4)`.as(
      'unitsAdjustedNet',
    ),
    // A branch started fresh. Signed, like a count adjustment: mostly negative
    // (stock zeroed out), occasionally positive (negative positions raised to
    // zero). Kept apart from write-offs so a fresh start never reads as loss.
    sql<number>`round(coalesce(sum(qty_base) filter (where reason = 'stock_reset'), 0), 4)`.as(
      'unitsResetNet',
    ),
  ] as const;
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/movements', { onRequest: [app.requirePermission('stock.read')] }, async (request) => {
    const q = parseQuery(reportQuery, request.query);

    // `to` is a calendar day, inclusive - the till day it names is meant to
    // be in range, not excluded by a bare `< to` at midnight.
    const toExclusive = new Date(q.to);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

    const base = app.db
      .selectFrom('stock_movement')
      .where('occurred_at', '>=', q.from)
      .where('occurred_at', '<', toExclusive)
      .$if(q.branchId !== undefined, (qb) => qb.where('branch_id', '=', q.branchId as string))
      .$if(q.productId !== undefined, (qb) => qb.where('product_id', '=', q.productId as string))
      .$if(q.categoryId !== undefined, (qb) =>
        qb.where('product_id', 'in', (eb) =>
          eb.selectFrom('product').select('id').where('category_id', '=', q.categoryId as string),
        ),
      );

    const bucketExpr = GROUP_BY_EXPR[q.groupBy];

    // ISO weekday, 1 = Monday .. 7 = Sunday.
    const weekdayExpr = sql<number>`extract(isodow from occurred_at)::int`;

    const [summary, buckets, byProduct, byBranch, byCategory, byWeekday, topSellers] = await Promise.all([
      base.select(aggregates()).executeTakeFirst(),

      base
        .select([bucketExpr.as('bucket'), ...aggregates()])
        .groupBy(bucketExpr)
        .orderBy(bucketExpr, 'asc')
        .execute(),

      base
        .innerJoin('product', 'product.id', 'stock_movement.product_id')
        .select([
          'product.id as productId',
          'product.sku as sku',
          'product.name as productName',
          ...aggregates(),
        ])
        .groupBy(['product.id', 'product.sku', 'product.name'])
        .orderBy(sql`sum(abs(qty_base))`, 'desc')
        .limit(q.productId !== undefined ? 1 : 100)
        .execute(),

      // The same seven figures again, cut three more ways. Same filters as
      // everything above, so each cut sums back to the summary - the charts
      // built on them can never disagree with the headline numbers.
      base
        .innerJoin('branch', 'branch.id', 'stock_movement.branch_id')
        .select(['branch.id as branchId', 'branch.name as branchName', ...aggregates()])
        .groupBy(['branch.id', 'branch.name'])
        .orderBy(sql`sum(abs(qty_base))`, 'desc')
        .execute(),

      base
        .innerJoin('product', 'product.id', 'stock_movement.product_id')
        .leftJoin('product_category', 'product_category.id', 'product.category_id')
        .select([
          sql<string>`coalesce(product_category.name, 'Uncategorised')`.as('categoryName'),
          ...aggregates(),
        ])
        .groupBy(sql`coalesce(product_category.name, 'Uncategorised')`)
        .orderBy(sql`sum(abs(qty_base))`, 'desc')
        .execute(),

      base
        .select([weekdayExpr.as('weekday'), ...aggregates()])
        .groupBy(weekdayExpr)
        .orderBy(weekdayExpr, 'asc')
        .execute(),

      // Ranked by what was SOLD. `byProduct` above is ranked by total
      // activity (sold, received and adjusted together) and capped at 100, so
      // it cannot be trusted to contain the true top sellers.
      base
        .innerJoin('product', 'product.id', 'stock_movement.product_id')
        .select(['product.id as productId', 'product.sku as sku', 'product.name as productName', ...aggregates()])
        .groupBy(['product.id', 'product.sku', 'product.name'])
        .having(sql<boolean>`sum(-qty_base) filter (where reason in ('sale', 'sale_refund')) > 0`)
        .orderBy(sql`sum(-qty_base) filter (where reason in ('sale', 'sale_refund'))`, 'desc')
        .limit(10)
        .execute(),
    ]);

    return {
      from: q.from.toISOString().slice(0, 10),
      to: q.to.toISOString().slice(0, 10),
      groupBy: q.groupBy,
      summary: summary ?? {
        unitsSold: 0,
        unitsReceived: 0,
        costReceived: 0,
        unitsTransferredOut: 0,
        unitsTransferredIn: 0,
        unitsWrittenOff: 0,
        unitsAdjustedNet: 0,
        unitsResetNet: 0,
      },
      buckets,
      byProduct,
      topSellers,
      byBranch,
      byCategory,
      byWeekday,
    };
  });
}
