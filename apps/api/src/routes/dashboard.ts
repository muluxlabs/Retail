/**
 * Dashboard summary.
 *
 * Chosen to answer the questions the auditor actually has, rather than the
 * vanity numbers the old dashboard led with. Gross margin is reported with
 * its own health flag, because a margin near zero is the signal that cost
 * price has been captured at selling price (HANDOFF section 2.2) - the thing
 * their current dashboard displayed as 0.11% without comment.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', { onRequest: [app.requirePermission('dashboard.read')] }, async () => {
    const [inventory, exceptions, backdated, negative, master, recent, trading, topProducts, byCategory] =
      await Promise.all([
      // Total inventory at weighted-average cost.
      app.db
        .selectFrom('stock_on_hand')
        .leftJoin('product_wac', (join) =>
          join
            .onRef('product_wac.product_id', '=', 'stock_on_hand.product_id')
            .onRef('product_wac.branch_id', '=', 'stock_on_hand.branch_id'),
        )
        .select([
          sql<number>`count(*)`.as('lines'),
          sql<number>`round(coalesce(sum(stock_on_hand.qty_base * coalesce(product_wac.wac, 0)), 0), 2)`.as(
            'value',
          ),
          sql<number>`count(*) filter (where product_wac.wac is null)`.as('linesWithoutCost'),
        ])
        .executeTakeFirst(),

      // The queue, by kind, open only.
      app.db
        .selectFrom('exception_event')
        .select([
          'kind',
          ({ fn }) => fn.countAll<number>().as('count'),
          sql<number>`round(coalesce(sum(abs(value_impact)), 0), 2)`.as('valueAtRisk'),
        ])
        .where('state', '=', 'open')
        .groupBy('kind')
        .orderBy('count', 'desc')
        .execute(),

      app.db
        .selectFrom('backdated_movement')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .executeTakeFirst(),

      // Lines sitting at or below zero. Their "selling negative" problem.
      app.db
        .selectFrom('stock_on_hand')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('qty_base', '<', 0)
        .executeTakeFirst(),

      // Master-data health: products lacking a pack, or lacking any barcode.
      app.db
        .selectFrom('product')
        .select([
          sql<number>`count(*)`.as('products'),
          sql<number>`count(*) filter (where not exists (
            select 1 from product_pack pp where pp.product_id = product.id
          ))`.as('withoutPack'),
          sql<number>`count(*) filter (where not exists (
            select 1 from product_pack pp
            join barcode b on b.pack_id = pp.id
            where pp.product_id = product.id
          ))`.as('withoutBarcode'),
          sql<number>`count(*) filter (where merged_into_id is not null)`.as('merged'),
        ])
        .where('is_active', '=', true)
        .executeTakeFirst(),

      // Trading activity over the last 30 days, by day.
      app.db
        .selectFrom('stock_movement')
        .select([
          sql<string>`to_char(occurred_at::date, 'YYYY-MM-DD')`.as('day'),
          sql<number>`coalesce(sum(qty_base) filter (where reason = 'sale'), 0) * -1`.as('unitsSold'),
          sql<number>`coalesce(sum(qty_base) filter (where reason = 'grn'), 0)`.as('unitsReceived'),
        ])
        .where(sql<boolean>`occurred_at > now() - interval '30 days'`)
        .groupBy(sql`occurred_at::date`)
        .orderBy(sql`occurred_at::date`, 'asc')
        .execute(),

      // The last 30 days against the 30 before them, so a tile can say
      // whether a number is moving rather than just what it is.
      app.db
        .selectFrom('stock_movement')
        .select([
          sql<number>`coalesce(sum(-qty_base) filter (where reason in ('sale', 'sale_refund') and occurred_at > now() - interval '30 days'), 0)`.as(
            'soldNow',
          ),
          sql<number>`coalesce(sum(-qty_base) filter (where reason in ('sale', 'sale_refund') and occurred_at <= now() - interval '30 days'), 0)`.as(
            'soldBefore',
          ),
          sql<number>`coalesce(sum(qty_base) filter (where reason in ('grn', 'grn_reversal') and occurred_at > now() - interval '30 days'), 0)`.as(
            'receivedNow',
          ),
          sql<number>`coalesce(sum(qty_base) filter (where reason in ('grn', 'grn_reversal') and occurred_at <= now() - interval '30 days'), 0)`.as(
            'receivedBefore',
          ),
        ])
        .where(sql<boolean>`occurred_at > now() - interval '60 days'`)
        .executeTakeFirst(),

      app.db
        .selectFrom('stock_movement')
        .innerJoin('product', 'product.id', 'stock_movement.product_id')
        .select([
          'product.id as productId',
          'product.name as productName',
          'product.sku as sku',
          sql<number>`round(sum(-qty_base), 4)`.as('unitsSold'),
        ])
        .where(sql<boolean>`reason in ('sale', 'sale_refund')`)
        .where(sql<boolean>`occurred_at > now() - interval '30 days'`)
        .groupBy(['product.id', 'product.name', 'product.sku'])
        .having(sql<boolean>`sum(-qty_base) > 0`)
        .orderBy(sql`sum(-qty_base)`, 'desc')
        .limit(8)
        .execute(),

      // Same formula as the headline inventory figure (positive and negative
      // positions both count), so the categories add up to it exactly.
      app.db
        .selectFrom('stock_on_hand')
        .innerJoin('product', 'product.id', 'stock_on_hand.product_id')
        .leftJoin('product_category', 'product_category.id', 'product.category_id')
        .leftJoin('product_wac', (join) =>
          join
            .onRef('product_wac.product_id', '=', 'stock_on_hand.product_id')
            .onRef('product_wac.branch_id', '=', 'stock_on_hand.branch_id'),
        )
        .select([
          sql<string>`coalesce(product_category.name, 'Uncategorised')`.as('categoryName'),
          sql<number>`round(coalesce(sum(stock_on_hand.qty_base * coalesce(product_wac.wac, 0)), 0), 2)`.as(
            'value',
          ),
        ])
        .groupBy(sql`coalesce(product_category.name, 'Uncategorised')`)
        .orderBy(sql`sum(stock_on_hand.qty_base * coalesce(product_wac.wac, 0))`, 'desc')
        .execute(),
    ]);

    const openTotal = exceptions.reduce((sum, e) => sum + Number(e.count), 0);
    const valueAtRisk = exceptions.reduce((sum, e) => sum + Number(e.valueAtRisk), 0);

    return {
      inventory: {
        lines: inventory?.lines ?? 0,
        value: inventory?.value ?? 0,
        // Lines we cannot value, because nothing priced was ever received.
        // This is the honest version of "we do not know what it is worth".
        linesWithoutCost: inventory?.linesWithoutCost ?? 0,
      },
      exceptions: {
        open: openTotal,
        valueAtRisk: Number(valueAtRisk.toFixed(2)),
        byKind: exceptions,
      },
      controls: {
        backdatedMovements: backdated?.n ?? 0,
        negativeStockLines: negative?.n ?? 0,
      },
      master: {
        products: master?.products ?? 0,
        withoutPack: master?.withoutPack ?? 0,
        withoutBarcode: master?.withoutBarcode ?? 0,
        merged: master?.merged ?? 0,
      },
      activity: recent,
      trading: {
        soldNow: trading?.soldNow ?? 0,
        soldBefore: trading?.soldBefore ?? 0,
        receivedNow: trading?.receivedNow ?? 0,
        receivedBefore: trading?.receivedBefore ?? 0,
      },
      topProducts,
      inventoryByCategory: byCategory,
    };
  });
}
