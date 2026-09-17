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

const packParams = z.object({ id: z.uuid(), packId: z.uuid() });

const updateProduct = z.object({
  sku: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  baseUom: z.string().trim().min(1).max(16).optional(),
  categoryId: z.uuid().nullable().optional(),
  isWeighed: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const createPack = z.object({
  label: z.string().trim().min(1).max(64),
  qtyBase: z.number().positive(),
  isDefaultSell: z.boolean().default(false),
  isDefaultBuy: z.boolean().default(false),
  barcode: z.string().trim().min(1).max(32).optional(),
});

const updatePack = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  qtyBase: z.number().positive().optional(),
  isDefaultSell: z.boolean().optional(),
  isDefaultBuy: z.boolean().optional(),
});

const attachBarcode = z.object({
  code: z.string().trim().min(1).max(32),
  symbology: z.enum(['ean13', 'ean8', 'upca', 'internal', 'embedded_weight']).default('ean13'),
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
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

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

      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: 'PRODUCT_CREATED',
          actor_id: actor.personId,
          terminal_id: null,
          branch_id: null,
          entity_type: 'product',
          entity_id: product.id,
          state_before: null,
          state_after: JSON.stringify({ sku: body.sku, name: body.name, packs: body.packs.length }),
          occurred_at: new Date(),
        })
        .execute();

      return product;
    });

    return reply.status(201).send(created);
  });

  /**
   * Amend a product's core fields.
   *
   * Deliberately narrow: this is master-data cleanse (rename, recategorise,
   * correct the base unit, retire a product), not a stock operation. Nothing
   * here touches the ledger.
   */
  app.patch('/products/:id', { onRequest: [app.requirePermission('product.write')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = parseBody(updateProduct, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

    const before = await app.db
      .selectFrom('product')
      .select(['id', 'sku', 'name', 'base_uom', 'category_id', 'is_weighed', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (before === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No product ${id}` } });
    }

    const updated = await app.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('product')
        .set({
          ...(body.sku !== undefined ? { sku: body.sku } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.baseUom !== undefined ? { base_uom: body.baseUom } : {}),
          ...(body.categoryId !== undefined ? { category_id: body.categoryId } : {}),
          ...(body.isWeighed !== undefined ? { is_weighed: body.isWeighed } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: 'PRODUCT_UPDATED',
          actor_id: actor.personId,
          terminal_id: null,
          branch_id: null,
          entity_type: 'product',
          entity_id: id,
          state_before: JSON.stringify(before),
          state_after: JSON.stringify(body),
          occurred_at: new Date(),
        })
        .execute();

      return row;
    });

    return updated;
  });

  /**
   * Add a pack to an existing product.
   *
   * The routine cleanse operation: the item master already has "Charhons
   * 500g" and someone realises the warehouse also receives a case of 10.
   * Adding the pack here, rather than creating a second product record, is
   * the whole point of the pack hierarchy (HANDOFF section 2.3).
   */
  app.post(
    '/products/:id/packs',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(createPack, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const product = await app.db
        .selectFrom('product')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (product === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No product ${id}` } });
      }

      const created = await app.db.transaction().execute(async (tx) => {
        const pack = await tx
          .insertInto('product_pack')
          .values({
            product_id: id,
            label: body.label,
            qty_base: body.qtyBase,
            is_default_sell: body.isDefaultSell,
            is_default_buy: body.isDefaultBuy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        if (body.barcode !== undefined) {
          await tx
            .insertInto('barcode')
            .values({ code: body.barcode, pack_id: pack.id, symbology: 'ean13' })
            .execute();
        }

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PACK_ADDED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'product_pack',
            entity_id: pack.id,
            state_before: null,
            state_after: JSON.stringify({ productId: id, label: body.label, qtyBase: body.qtyBase }),
            occurred_at: new Date(),
          })
          .execute();

        return pack;
      });

      return reply.status(201).send(created);
    },
  );

  /**
   * Amend a pack - its label, its conversion factor, or which pack is the
   * default sell/buy unit.
   *
   * Changing qtyBase does not touch history: every posted movement already
   * carries its quantity in base units, so correcting "case of 10" to "case
   * of 12" only changes how FUTURE receipts and sales convert.
   */
  app.patch(
    '/products/:id/packs/:packId',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { id, packId } = parseParams(packParams, request.params);
      const body = parseBody(updatePack, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const before = await app.db
        .selectFrom('product_pack')
        .selectAll()
        .where('id', '=', packId)
        .where('product_id', '=', id)
        .executeTakeFirst();

      if (before === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No pack ${packId}` } });
      }

      const updated = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('product_pack')
          .set({
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.qtyBase !== undefined ? { qty_base: body.qtyBase } : {}),
            ...(body.isDefaultSell !== undefined ? { is_default_sell: body.isDefaultSell } : {}),
            ...(body.isDefaultBuy !== undefined ? { is_default_buy: body.isDefaultBuy } : {}),
          })
          .where('id', '=', packId)
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PACK_UPDATED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'product_pack',
            entity_id: packId,
            state_before: JSON.stringify(before),
            state_after: JSON.stringify(body),
            occurred_at: new Date(),
          })
          .execute();

        return row;
      });

      return updated;
    },
  );

  /**
   * Attach an additional barcode to a pack.
   *
   * A pack may legitimately have more than one code - old packaging and new
   * packaging both scanning to the same product and multiplier is normal.
   * What the schema forbids is the reverse: one code resolving to more than
   * one pack. That is enforced by `barcode.code` being the primary key, so a
   * duplicate here fails at the database, not in application code.
   */
  app.post(
    '/products/:id/packs/:packId/barcodes',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { id, packId } = parseParams(packParams, request.params);
      const body = parseBody(attachBarcode, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const pack = await app.db
        .selectFrom('product_pack')
        .select('id')
        .where('id', '=', packId)
        .where('product_id', '=', id)
        .executeTakeFirst();
      if (pack === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No pack ${packId}` } });
      }

      const created = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('barcode')
          .values({ code: body.code, pack_id: packId, symbology: body.symbology })
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'BARCODE_ATTACHED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'barcode',
            entity_id: null,
            state_before: null,
            state_after: JSON.stringify({ code: body.code, packId }),
            occurred_at: new Date(),
          })
          .execute();

        return row;
      });

      return reply.status(201).send(created);
    },
  );

  /**
   * Unbind a barcode.
   *
   * A genuine delete, not a reversal: a barcode is a lookup, not a business
   * event, so it carries no history of its own to preserve. The removal
   * itself is still written to the audit log, because a barcode disappearing
   * from the master is exactly the kind of change an auditor asks about.
   */
  app.delete(
    '/barcodes/:code',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { code } = z.object({ code: z.string().trim().min(1).max(32) }).parse(request.params);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const existing = await app.db
        .selectFrom('barcode')
        .select(['code', 'pack_id'])
        .where('code', '=', code)
        .executeTakeFirst();

      if (existing === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No barcode ${code}` } });
      }

      await app.db.transaction().execute(async (tx) => {
        await tx.deleteFrom('barcode').where('code', '=', code).execute();
        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'BARCODE_REMOVED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'barcode',
            entity_id: null,
            state_before: JSON.stringify(existing),
            state_after: null,
            occurred_at: new Date(),
          })
          .execute();
      });

      return reply.status(204).send();
    },
  );

  /** Categories, for the filter control. */
  app.get('/categories', { onRequest: [app.requirePermission('product.read')] }, async () =>
    app.db
      .selectFrom('product_category')
      .select(['id', 'name', 'parent_id as parentId'])
      .orderBy('name', 'asc')
      .execute(),
  );
}
