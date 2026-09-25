/**
 * Item master.
 *
 * A product is returned WITH its pack hierarchy and barcodes, because the
 * pack hierarchy is the thing their current master lacks and the reason a
 * case and a single became unrelated records. Showing a product without its
 * packs would reproduce the view that hid the defect.
 */

import type { Database } from '@retail-ops/db';
import { isMoney } from '@retail-ops/domain';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import { parseQuery, parseParams, parseBody, queryBool } from '../validation.js';

/**
 * Clear the `unreviewed_product` exception this product's quick-add raised,
 * if it is still open. Approve and merge both resolve the product itself;
 * this is what closes the matching work item in the same step, so a
 * reviewed product does not also sit in the queue looking unresolved.
 * Silently a no-op if none is found - an admin-created product was never
 * pending in the first place and never raised one.
 */
async function clearReviewException(
  tx: Transaction<Database>,
  productId: string,
  clearedBy: string,
  note: string,
): Promise<void> {
  const exception = await tx
    .selectFrom('exception_event')
    .select('id')
    .where('product_id', '=', productId)
    .where('kind', '=', 'unreviewed_product')
    .where('state', '!=', 'cleared')
    .executeTakeFirst();

  if (exception === undefined) return;

  await tx
    .updateTable('exception_event')
    .set({ state: 'cleared', cleared_by: clearedBy, cleared_at: new Date(), clearing_note: note })
    .where('id', '=', exception.id)
    .execute();
}

/** A selling price: real money, or null to say "not priced". */
const price = z
  .number()
  .min(0)
  .refine(isMoney, 'A price has at most two decimal places.')
  .nullable();

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(),
  includeInactive: queryBool,
  reviewState: z.enum(['approved', 'pending']).optional(),
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
        sellPrice: price.optional(),
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
  sellPrice: price.optional(),
});

const updatePack = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  qtyBase: z.number().positive().optional(),
  isDefaultSell: z.boolean().optional(),
  isDefaultBuy: z.boolean().optional(),
  sellPrice: price.optional(),
});

const attachBarcode = z.object({
  code: z.string().trim().min(1).max(32),
  symbology: z.enum(['ean13', 'ean8', 'upca', 'internal', 'embedded_weight']).default('ean13'),
});

const quickAddProduct = z.object({
  name: z.string().trim().min(1).max(200),
  /** What the customer is being charged. The manager reviewing the item confirms or corrects it. */
  sellPrice: price.optional(),
  barcode: z.string().trim().min(1).max(32).optional(),
  branchId: z.uuid(),
  terminalId: z.uuid().nullable().default(null),
});

const approveProduct = z.object({
  categoryId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  baseUom: z.string().trim().min(1).max(16).optional(),
  isWeighed: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
});

const mergeProduct = z.object({
  targetProductId: z.uuid(),
  note: z.string().trim().max(1000).optional(),
});

/** Setting a price is its own capability, on top of being allowed to edit products. */
function assertMayPrice(request: { user: { permissions: Set<string> } | null }, wants: boolean): void {
  if (wants && request.user?.permissions.has('price.write') !== true) {
    throw new NotPermittedPrice();
  }
}

class NotPermittedPrice extends Error {
  readonly statusCode = 403;
  readonly code = 'NOT_PERMITTED';
  constructor() {
    super('Setting a selling price needs the price.write permission.');
  }
}

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
        'product.review_state as reviewState',
        'product.created_at as createdAt',
        'product_category.name as categoryName',
      ]);

    if (q.includeInactive !== true) query = query.where('product.is_active', '=', true);
    if (q.categoryId !== undefined) query = query.where('product.category_id', '=', q.categoryId);
    if (q.reviewState !== undefined) query = query.where('product.review_state', '=', q.reviewState);
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
              'product_pack.sell_price as sellPrice',
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
        'product.review_state as reviewState',
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
        'product_pack.sell_price as sellPrice',
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
    assertMayPrice(request, body.packs.some((p) => p.sellPrice !== undefined && p.sellPrice !== null));

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
          // Built through the full item-master form, by someone who holds
          // product.write - trusted the moment it is created, unlike a
          // till quick-add.
          review_state: 'approved',
          created_by: actor.personId,
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
            sell_price: pack.sellPrice ?? null,
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
      assertMayPrice(request, body.sellPrice !== undefined && body.sellPrice !== null);

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
            sell_price: body.sellPrice ?? null,
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
      assertMayPrice(request, body.sellPrice !== undefined);

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
            ...(body.sellPrice !== undefined ? { sell_price: body.sellPrice } : {}),
          })
          .where('id', '=', packId)
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            // A price change is the one edit an auditor asks about by name.
            action_code: body.sellPrice !== undefined && body.sellPrice !== (before.sell_price === null ? null : Number(before.sell_price)) ? 'PRICE_CHANGED' : 'PACK_UPDATED',
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

  /**
   * A cashier or receiver adds a product on the fly, mid-transaction,
   * because it has no barcode match and is not in the searchable list.
   *
   * This is deliberately the narrowest possible create: a name, an optional
   * code, one pack (a single, sellable and buyable). It lands as
   * review_state='pending' and raises an `unreviewed_product` exception in
   * the same queue every other override lands in - a branch manager or
   * admin reviews it from there, same as anything else. The product is
   * still fully real and sellable the instant it is created: the cashier
   * needs to finish the sale now, not wait on a review.
   */
  app.post(
    '/products/quick-add',
    { onRequest: [app.requirePermission('product.quickadd')] },
    async (request, reply) => {
      const body = parseBody(quickAddProduct, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      // A real SKU is master-data work for whoever reviews this; until then
      // it only needs to be unique.
      const sku = `QA-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

      const created = await app.db.transaction().execute(async (tx) => {
        const product = await tx
          .insertInto('product')
          .values({
            sku,
            name: body.name,
            base_uom: 'each',
            category_id: null,
            is_weighed: false,
            merged_into_id: null,
            review_state: 'pending',
            created_by: actor.personId,
          })
          .returning(['id', 'sku', 'name'])
          .executeTakeFirstOrThrow();

        const pack = await tx
          .insertInto('product_pack')
          .values({
            product_id: product.id,
            label: 'single',
            qty_base: 1,
            is_default_sell: true,
            is_default_buy: true,
            sell_price: body.sellPrice ?? null,
          })
          .returning(['id', 'qty_base'])
          .executeTakeFirstOrThrow();

        if (body.barcode !== undefined) {
          await tx
            .insertInto('barcode')
            .values({ code: body.barcode, pack_id: pack.id, symbology: 'ean13' })
            .execute();
        }

        const exception = await tx
          .insertInto('exception_event')
          .values({
            event_id: crypto.randomUUID(),
            kind: 'unreviewed_product',
            branch_id: body.branchId,
            terminal_id: body.terminalId,
            actor_id: actor.personId,
            product_id: product.id,
            detail: JSON.stringify({ name: body.name, barcode: body.barcode ?? null, sku }),
            value_impact: null,
            currency: null,
            occurred_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PRODUCT_QUICKADDED',
            actor_id: actor.personId,
            terminal_id: body.terminalId,
            branch_id: body.branchId,
            entity_type: 'product',
            entity_id: product.id,
            state_before: null,
            state_after: JSON.stringify({ sku, name: body.name, barcode: body.barcode ?? null }),
            occurred_at: new Date(),
          })
          .execute();

        return { product, pack, exceptionId: exception.id };
      });

      return reply.status(201).send({
        id: created.product.id,
        sku: created.product.sku,
        name: created.product.name,
        packId: created.pack.id,
        qtyBase: created.pack.qty_base,
        barcode: body.barcode ?? null,
        exceptionId: created.exceptionId,
      });
    },
  );

  /**
   * Accept a pending product into the real item master: assign it a proper
   * category (and correct anything else about it), and clear it.
   *
   * This is the "it genuinely didn't exist" resolution. The companion path
   * for "it did exist, the cashier just didn't find it" is merge, below.
   */
  app.post(
    '/products/:id/approve',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(approveProduct, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const before = await app.db
        .selectFrom('product')
        .select(['id', 'sku', 'name', 'category_id', 'base_uom', 'is_weighed', 'review_state'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (before === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No product ${id}` } });
      }
      if (before.review_state !== 'pending') {
        return reply.status(409).send({
          error: { code: 'NOT_PENDING', message: 'This product is not awaiting review.' },
        });
      }

      const updated = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('product')
          .set({
            review_state: 'approved',
            ...(body.categoryId !== undefined ? { category_id: body.categoryId } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.sku !== undefined ? { sku: body.sku } : {}),
            ...(body.baseUom !== undefined ? { base_uom: body.baseUom } : {}),
            ...(body.isWeighed !== undefined ? { is_weighed: body.isWeighed } : {}),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PRODUCT_APPROVED',
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

        await clearReviewException(tx, id, actor.personId, body.note ?? `Approved into the item master.`);

        return row;
      });

      return updated;
    },
  );

  /**
   * The other resolution: a pending product turns out to be a duplicate of
   * something already in the master, created only because the cashier
   * could not find the existing one. Points it at the real product via the
   * same merged_into_id the cleanse workflow already uses - it keeps its
   * own history, stops accepting new movements, and its barcode (if it
   * scanned one) moves to the target's default-sell pack so the code
   * resolves correctly from here on.
   */
  app.post(
    '/products/:id/merge',
    { onRequest: [app.requirePermission('product.write')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(mergeProduct, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }
      if (body.targetProductId === id) {
        return reply.status(422).send({
          error: { code: 'INVALID_MERGE', message: 'A product cannot be merged into itself.' },
        });
      }

      const [source, target] = await Promise.all([
        app.db
          .selectFrom('product')
          .select(['id', 'name', 'review_state', 'merged_into_id'])
          .where('id', '=', id)
          .executeTakeFirst(),
        app.db
          .selectFrom('product')
          .select(['id', 'name', 'merged_into_id'])
          .where('id', '=', body.targetProductId)
          .executeTakeFirst(),
      ]);

      if (source === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No product ${id}` } });
      }
      if (target === undefined) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `No product ${body.targetProductId}` },
        });
      }
      if (target.merged_into_id !== null) {
        return reply.status(422).send({
          error: {
            code: 'INVALID_MERGE',
            message: 'The target product is itself merged into another product.',
          },
        });
      }

      const updated = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('product')
          .set({ merged_into_id: body.targetProductId, review_state: 'approved' })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Redirect the source's barcodes, if it has any, onto the target's
        // default-sell pack so a future scan of the same code resolves to
        // the product it was actually merged into.
        const targetPack = await tx
          .selectFrom('product_pack')
          .select('id')
          .where('product_id', '=', body.targetProductId)
          .where('is_default_sell', '=', true)
          .executeTakeFirst();

        if (targetPack !== undefined) {
          await tx
            .updateTable('barcode')
            .set({ pack_id: targetPack.id })
            .where(
              'pack_id',
              'in',
              tx.selectFrom('product_pack').select('id').where('product_id', '=', id),
            )
            .execute();
        }

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PRODUCT_MERGED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'product',
            entity_id: id,
            state_before: JSON.stringify({ mergedIntoId: null }),
            state_after: JSON.stringify({ mergedIntoId: body.targetProductId }),
            occurred_at: new Date(),
          })
          .execute();

        await clearReviewException(
          tx,
          id,
          actor.personId,
          body.note ?? `Merged into ${target.name}.`,
        );

        return row;
      });

      return updated;
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
