/**
 * Stock positions, read from the ledger views.
 *
 * Every number on these endpoints is derived. There is no quantity column to
 * read and nothing here is cached, so a stock figure cannot drift away from
 * the movements that produced it (AD-1).
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { parseQuery } from '../validation.js';

const stockQuery = z.object({
  branchId: z.uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  /** Only rows at or below zero - the "selling negative" investigation. */
  negativeOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const movementQuery = z.object({
  branchId: z.uuid().optional(),
  productId: z.uuid().optional(),
  reason: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function registerStockRoutes(app: FastifyInstance): Promise<void> {
  /** Stock on hand, valued at weighted-average cost. */
  app.get('/stock', async (request) => {
    const q = parseQuery(stockQuery, request.query);

    let query = app.db
      .selectFrom('stock_on_hand')
      .innerJoin('product', 'product.id', 'stock_on_hand.product_id')
      .innerJoin('branch', 'branch.id', 'stock_on_hand.branch_id')
      .leftJoin('product_wac', (join) =>
        join
          .onRef('product_wac.product_id', '=', 'stock_on_hand.product_id')
          .onRef('product_wac.branch_id', '=', 'stock_on_hand.branch_id'),
      )
      .select([
        'stock_on_hand.product_id as productId',
        'stock_on_hand.branch_id as branchId',
        'stock_on_hand.qty_base as qtyBase',
        'product.sku',
        'product.name as productName',
        'product.base_uom as baseUom',
        'branch.code as branchCode',
        'branch.name as branchName',
        'product_wac.wac',
        // Valuation is computed here rather than stored, for the same reason
        // stock is: a stored value is a value that can go stale.
        sql<number>`round(stock_on_hand.qty_base * coalesce(product_wac.wac, 0), 2)`.as('value'),
      ]);

    if (q.branchId !== undefined) query = query.where('stock_on_hand.branch_id', '=', q.branchId);
    if (q.negativeOnly) query = query.where('stock_on_hand.qty_base', '<=', 0);
    if (q.search !== undefined) {
      const term = `%${q.search}%`;
      query = query.where((eb) =>
        eb.or([eb('product.name', 'ilike', term), eb('product.sku', 'ilike', term)]),
      );
    }

    const items = await query
      .orderBy('product.name', 'asc')
      .orderBy('branch.name', 'asc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    return { items, limit: q.limit, offset: q.offset };
  });

  /** Stock totals per branch, for the branch picker and the dashboard. */
  app.get('/stock/by-branch', async () => {
    const rows = await app.db
      .selectFrom('branch')
      .leftJoin('stock_on_hand', 'stock_on_hand.branch_id', 'branch.id')
      .leftJoin('product_wac', (join) =>
        join
          .onRef('product_wac.product_id', '=', 'stock_on_hand.product_id')
          .onRef('product_wac.branch_id', '=', 'stock_on_hand.branch_id'),
      )
      .select([
        'branch.id as branchId',
        'branch.code as branchCode',
        'branch.name as branchName',
        'branch.kind',
        sql<number>`count(stock_on_hand.product_id)`.as('lines'),
        sql<number>`coalesce(sum(stock_on_hand.qty_base), 0)`.as('units'),
        sql<number>`round(coalesce(sum(stock_on_hand.qty_base * coalesce(product_wac.wac, 0)), 0), 2)`.as(
          'value',
        ),
        sql<number>`count(*) filter (where stock_on_hand.qty_base < 0)`.as('negativeLines'),
      ])
      .where('branch.is_active', '=', true)
      .groupBy(['branch.id', 'branch.code', 'branch.name', 'branch.kind'])
      .orderBy('branch.kind', 'desc')
      .orderBy('branch.name', 'asc')
      .execute();
    return rows;
  });

  /** The raw ledger. This is the audit trail, and it is the storage format. */
  app.get('/movements', async (request) => {
    const q = parseQuery(movementQuery, request.query);

    let query = app.db
      .selectFrom('stock_movement')
      .innerJoin('product', 'product.id', 'stock_movement.product_id')
      .innerJoin('branch', 'branch.id', 'stock_movement.branch_id')
      .leftJoin('person', 'person.id', 'stock_movement.actor_id')
      .select([
        'stock_movement.seq',
        'stock_movement.event_id as eventId',
        'stock_movement.qty_base as qtyBase',
        'stock_movement.unit_cost as unitCost',
        'stock_movement.reason',
        'stock_movement.doc_type as docType',
        'stock_movement.occurred_at as occurredAt',
        'stock_movement.recorded_at as recordedAt',
        'stock_movement.reverses_seq as reversesSeq',
        'product.sku',
        'product.name as productName',
        'branch.code as branchCode',
        'person.full_name as actorName',
        // The gap between business time and server time is data, not metadata.
        sql<number>`round(extract(epoch from (stock_movement.recorded_at - stock_movement.occurred_at)) / 3600, 1)`.as(
          'backdateGapHours',
        ),
      ]);

    if (q.branchId !== undefined) query = query.where('stock_movement.branch_id', '=', q.branchId);
    if (q.productId !== undefined) query = query.where('stock_movement.product_id', '=', q.productId);

    const items = await query
      .orderBy('stock_movement.seq', 'desc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    return { items, limit: q.limit, offset: q.offset };
  });

  /** Movements recorded well after they happened. The backdating report. */
  app.get('/movements/backdated', async () =>
    app.db
      .selectFrom('backdated_movement')
      .innerJoin('product', 'product.id', 'backdated_movement.product_id')
      .innerJoin('branch', 'branch.id', 'backdated_movement.branch_id')
      .leftJoin('person', 'person.id', 'backdated_movement.actor_id')
      .select([
        'backdated_movement.seq',
        'backdated_movement.occurred_at as occurredAt',
        'backdated_movement.recorded_at as recordedAt',
        'product.sku',
        'product.name as productName',
        'branch.code as branchCode',
        'person.full_name as actorName',
        sql<number>`round(extract(epoch from backdated_movement.backdate_gap) / 86400, 1)`.as('gapDays'),
      ])
      .orderBy('backdated_movement.seq', 'desc')
      .limit(200)
      .execute(),
  );
}
