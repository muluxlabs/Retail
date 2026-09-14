/**
 * Item master.
 *
 * A product is returned WITH its pack hierarchy and barcodes, because the
 * pack hierarchy is the thing their current master lacks and the reason a
 * case and a single became unrelated records. Showing a product without its
 * packs would reproduce the view that hid the defect.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseQuery, parseParams, parseBody } from '../validation.js';

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(),
  includeInactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParams = z.object({ id: z.uuid() });

const createProduct = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  baseUom: z.string().trim().min(1).max(16).default('each'),
  categoryId: z.uuid().nullable().default(null),
  isWeighed: z.boolean().default(false),
  packs: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(64),
        qtyBase: z.number().positive(),
        isDefaultSell: z.boolean().default(false),
        isDefaultBuy: z.boolean().default(false),
        barcode: z.string().trim().min(1).max(32).optional(),
      }),
    )
    .min(1, 'A product needs at least one pack, even if it is just a single.'),
});

export async function registerProductRoutes(app: FastifyInstance): Promise<void> {
  /** List the item master, newest first, with pack and barcode counts. */
  app.get('/products', { onRequest: [app.requirePermission('product.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);

    let query = app.db
      .selectFrom('product')
      .leftJoin('product_category', 'product_category.id', 'product.category_id')
      .select([
        'product.id',
        'product.sku',
        'product.name',
        'product.base_uom as baseUom',
        'product.is_weighed as isWeighed',
        'product.is_active as isActive',
        'product.merged_into_id as mergedIntoId',
        'product.created_at as createdAt',
        'product_category.name as categoryName',
      ]);

    if (q.includeInactive !== true) query = query.where('product.is_active', '=', true);
    if (q.categoryId !== undefined) query = query.where('product.category_id', '=', q.categoryId);
    if (q.search !== undefined) {
      const term = `%${q.search}%`;
      query = query.where((eb) =>
        eb.or([eb('product.name', 'ilike', term), eb('product.sku', 'ilike', term)]),
      );
    }

    const rows = await query
      .orderBy('product.name', 'asc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    const ids = rows.map((r) => r.id);
    const packs =
      ids.length === 0
        ? []
        : await app.db
            .selectFrom('product_pack')
            .leftJoin('barcode', 'barcode.pack_id', 'product_pack.id')
            .select([
              'product_pack.id',
              'product_pack.product_id as productId',
              'product_pack.label',
              'product_pack.qty_base as qtyBase',
              'product_pack.is_default_sell as isDefaultSell',
              'product_pack.is_default_buy as isDefaultBuy',
              'barcode.code as barcode',
            ])
            .where('product_pack.product_id', 'in', ids)
            .orderBy('product_pack.qty_base', 'asc')
            .execute();

    const byProduct = new Map<string, typeof packs>();
    for (const p of packs) {
      const list = byProduct.get(p.productId) ?? [];
      list.push(p);
      byProduct.set(p.productId, list);
    }

    const total = await app.db
      .selectFrom('product')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .$if(q.includeInactive !== true, (qb) => qb.where('is_active', '=', true))
      .executeTakeFirst();

    return {
      items: rows.map((r) => ({ ...r, packs: byProduct.get(r.id) ?? [] })),
      total: total?.n ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  /** One product with packs, barcodes, and its stock position per branch. */
  app.get('/products/:id', { onRequest: [app.requirePermission('product.read')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);

    const product = await app.db
      .selectFrom('product')
      .leftJoin('product_category', 'product_category.id', 'product.category_id')
      .select([
        'product.id',
        'product.sku',
        'product.name',
        'product.base_uom as baseUom',
        'product.is_weighed as isWeighed',
        'product.is_active as isActive',
        'product.merged_into_id as mergedIntoId',
        'product.created_at as createdAt',
        'product_category.name as categoryName',
      ])
      .where('product.id', '=', id)
      .executeTakeFirst();

    if (product === undefined) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `No product ${id}` },
      });
    }

    const packs = await app.db
      .selectFrom('product_pack')
      .leftJoin('barcode', 'barcode.pack_id', 'product_pack.id')
      .select([
        'product_pack.id',
        'product_pack.label',
        'product_pack.qty_base as qtyBase',
        'product_pack.is_default_sell as isDefaultSell',
        'product_pack.is_default_buy as isDefaultBuy',
        'barcode.code as barcode',
        'barcode.symbology',
      ])
      .where('product_pack.product_id', '=', id)
      .orderBy('product_pack.qty_base', 'asc')
      .execute();

    // Stock is a view over the ledger. There is no quantity column to read.
    const stock = await app.db
      .selectFrom('stock_on_hand')
      .innerJoin('branch', 'branch.id', 'stock_on_hand.branch_id')
      .leftJoin('product_wac', (join) =>
        join
          .onRef('product_wac.product_id', '=', 'stock_on_hand.product_id')
          .onRef('product_wac.branch_id', '=', 'stock_on_hand.branch_id'),
      )
      .select([
        'branch.id as branchId',
        'branch.code as branchCode',
        'branch.name as branchName',
        'stock_on_hand.qty_base as qtyBase',
        'product_wac.wac',
      ])
      .where('stock_on_hand.product_id', '=', id)
      .orderBy('branch.name', 'asc')
      .execute();

    const movements = await app.db
      .selectFrom('stock_movement')
      .innerJoin('branch', 'branch.id', 'stock_movement.branch_id')
      .leftJoin('person', 'person.id', 'stock_movement.actor_id')
      .select([
        'stock_movement.seq',
        'stock_movement.qty_base as qtyBase',
        'stock_movement.unit_cost as unitCost',
        'stock_movement.reason',
        'stock_movement.doc_type as docType',
        'stock_movement.occurred_at as occurredAt',
        'stock_movement.recorded_at as recordedAt',
        'branch.code as branchCode',
        'person.full_name as actorName',
      ])
      .where('stock_movement.product_id', '=', id)
      .orderBy('stock_movement.seq', 'desc')
      .limit(50)
      .execute();

    return { ...product, packs, stock, movements };
  });

  /**
   * Create a product together with its packs and barcodes, in one
   * transaction. Packs are not optional: a product without a pack cannot be
   * bought or sold, and a product whose case is a separate record is the
   * defect this whole model exists to prevent.
   */
  app.post('/products', { onRequest: [app.requirePermission('product.write')] }, async (request, reply) => {
    const body = parseBody(createProduct, request.body);

    const created = await app.db.transaction().execute(async (tx) => {
      const product = await tx
        .insertInto('product')
        .values({
          sku: body.sku,
          name: body.name,
          base_uom: body.baseUom,
          category_id: body.categoryId,
          is_weighed: body.isWeighed,
          merged_into_id: null,
        })
        .returning(['id', 'sku', 'name'])
        .executeTakeFirstOrThrow();

      for (const pack of body.packs) {
        const packRow = await tx
          .insertInto('product_pack')
          .values({
            product_id: product.id,
            label: pack.label,
            qty_base: pack.qtyBase,
            is_default_sell: pack.isDefaultSell,
            is_default_buy: pack.isDefaultBuy,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        if (pack.barcode !== undefined) {
          // Shape and uniqueness are enforced by CHECK constraints and the
          // primary key; a bad code fails here rather than being stored.
          await tx
            .insertInto('barcode')
            .values({ code: pack.barcode, pack_id: packRow.id, symbology: 'ean13' })
            .execute();
        }
      }

      return product;
    });

    return reply.status(201).send(created);
  });

  /** Categories, for the filter control. */
  app.get('/categories', { onRequest: [app.requirePermission('product.read')] }, async () =>
    app.db
      .selectFrom('product_category')
      .select(['id', 'name', 'parent_id as parentId'])
      .orderBy('name', 'asc')
      .execute(),
  );
}
