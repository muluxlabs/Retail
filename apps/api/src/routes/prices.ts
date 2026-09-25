/**
 * The price list: every pack, its cost, its selling price, its margin.
 *
 * A catalogue with thousands of products and no prices is the state every new
 * branch starts in, so pricing has to be quick in bulk: edit many in one
 * save, or fill every unpriced pack from its cost plus a markup in one action.
 * Every change is written to the audit log with the old and new price, because
 * a price change is one of the first things an auditor asks about.
 *
 * Requires price.write (stock controller, branch manager, administrator).
 */

import { isMoney } from '@retail-ops/domain';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { parseBody, parseQuery, queryBool } from '../validation.js';

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(),
  missingOnly: queryBool,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const price = z.number().min(0).refine(isMoney, 'A price has at most two decimal places.');

const changeBody = z.object({
  changes: z
    .array(z.object({ packId: z.uuid(), sellPrice: price.nullable() }))
    .min(1)
    .max(500),
});

const fillBody = z.object({
  markupPercent: z.number().min(0).max(1000),
  /** Round UP to this step, so a price never ends up below the markup asked for. */
  roundTo: z.union([z.literal(0.01), z.literal(0.05), z.literal(0.1), z.literal(0.5), z.literal(1)]).default(0.05),
});

interface PriceRow {
  packId: string;
  packLabel: string;
  qtyBase: number;
  sellPrice: number | null;
  productId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  barcode: string | null;
  costPerPack: number | null;
}

/**
 * Cost of one pack: the group-wide weighted-average cost of a base unit
 * (from every costed receipt) times the units in the pack. NULL when nothing
 * costed has ever been received - a price cannot be worked out from nothing.
 */
const COST_PER_PACK = sql<number | null>`(
  SELECT sum(m.qty_base * m.unit_cost) / nullif(sum(m.qty_base), 0)
  FROM stock_movement m
  WHERE m.product_id = p.id
    AND m.reason IN ('grn', 'opening_balance', 'transfer_in')
    AND m.unit_cost IS NOT NULL
) * pk.qty_base`;

export async function registerPriceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/price-list', { onRequest: [app.requirePermission('price.write')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const like = q.search === undefined ? null : `%${q.search}%`;

    const rows = await sql<PriceRow>`
      SELECT pk.id AS "packId", pk.label AS "packLabel", pk.qty_base AS "qtyBase", pk.sell_price AS "sellPrice",
             p.id AS "productId", p.sku, p.name, c.name AS "categoryName",
             (SELECT b.code FROM barcode b WHERE b.pack_id = pk.id ORDER BY b.created_at LIMIT 1) AS "barcode",
             ${COST_PER_PACK} AS "costPerPack"
      FROM product_pack pk
      JOIN product p ON p.id = pk.product_id
      LEFT JOIN product_category c ON c.id = p.category_id
      WHERE p.is_active AND p.merged_into_id IS NULL
        AND (${like}::text IS NULL OR p.name ILIKE ${like} OR p.sku ILIKE ${like})
        AND (${q.categoryId ?? null}::uuid IS NULL OR p.category_id = ${q.categoryId ?? null}::uuid)
        AND (NOT ${q.missingOnly} OR pk.sell_price IS NULL)
      ORDER BY p.name, pk.qty_base
      LIMIT ${q.limit} OFFSET ${q.offset}
    `.execute(app.db);

    // `total` follows the filters (it drives paging); `catalogue` and `unpriced` are the whole catalogue.
    const total = await sql<{ n: number; matching: number; missing: number }>`
      SELECT count(*) AS n,
             count(*) FILTER (
               WHERE (${like}::text IS NULL OR p.name ILIKE ${like} OR p.sku ILIKE ${like})
                 AND (${q.categoryId ?? null}::uuid IS NULL OR p.category_id = ${q.categoryId ?? null}::uuid)
                 AND (NOT ${q.missingOnly} OR pk.sell_price IS NULL)
             ) AS matching,
             count(*) FILTER (WHERE pk.sell_price IS NULL) AS missing
      FROM product_pack pk JOIN product p ON p.id = pk.product_id
      WHERE p.is_active AND p.merged_into_id IS NULL
    `.execute(app.db);

    return {
      items: rows.rows.map((r) => ({
        ...r,
        qtyBase: Number(r.qtyBase),
        sellPrice: r.sellPrice === null ? null : Number(r.sellPrice),
        costPerPack: r.costPerPack === null ? null : Number(r.costPerPack),
      })),
      total: Number(total.rows[0]?.matching ?? 0),
      catalogue: Number(total.rows[0]?.n ?? 0),
      unpriced: Number(total.rows[0]?.missing ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  /** Save a batch of price edits. Only prices that actually changed are written, and each is audited. */
  app.put('/price-list', { onRequest: [app.requirePermission('price.write')] }, async (request, reply) => {
    const body = parseBody(changeBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

    const result = await app.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('product_pack')
        .select(['id', 'sell_price'])
        .where('id', 'in', body.changes.map((c) => c.packId))
        .execute();
      const before = new Map(current.map((r) => [r.id, r.sell_price === null ? null : Number(r.sell_price)]));

      let updated = 0;
      for (const c of body.changes) {
        if (!before.has(c.packId)) continue;
        const old = before.get(c.packId) ?? null;
        if (old === c.sellPrice) continue;
        // Track what was just written: the same pack twice in one save must be
        // compared against the price it now has, not the one it started with.
        before.set(c.packId, c.sellPrice);

        await tx.updateTable('product_pack').set({ sell_price: c.sellPrice }).where('id', '=', c.packId).execute();
        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PRICE_CHANGED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'product_pack',
            entity_id: c.packId,
            state_before: JSON.stringify({ sellPrice: old }),
            state_after: JSON.stringify({ sellPrice: c.sellPrice }),
            occurred_at: new Date(),
          })
          .execute();
        updated += 1;
      }
      return { updated, unchanged: body.changes.length - updated };
    });

    return result;
  });

  /**
   * Price every unpriced pack from its cost plus a markup, rounded UP.
   *
   * A starting point for a fresh catalogue, not a pricing policy: it leaves any
   * price already set alone, and skips packs with no known cost (it will not
   * guess), reporting how many.
   */
  app.post('/price-list/fill-missing', { onRequest: [app.requirePermission('price.write')] }, async (request, reply) => {
    const body = parseBody(fillBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

    const { rows } = await sql<{ packId: string; costPerPack: number | null }>`
      SELECT pk.id AS "packId", ${COST_PER_PACK} AS "costPerPack"
      FROM product_pack pk
      JOIN product p ON p.id = pk.product_id
      WHERE pk.sell_price IS NULL AND p.is_active AND p.merged_into_id IS NULL
      LIMIT 20000
    `.execute(app.db);

    const step = body.roundTo;
    const priced = rows.flatMap((r) => {
      const cost = r.costPerPack === null ? null : Number(r.costPerPack);
      if (cost === null || !(cost > 0)) return [];
      const raw = cost * (1 + body.markupPercent / 100);
      // Round up to the step, in whole cents to dodge floating point.
      const cents = Math.round(step * 100);
      const up = Math.ceil(Math.round(raw * 100 * 1e6) / 1e6 / cents) * cents;
      return [{ packId: r.packId, sellPrice: Number((up / 100).toFixed(2)) }];
    });

    await app.db.transaction().execute(async (tx) => {
      for (const p of priced) {
        await tx.updateTable('product_pack').set({ sell_price: p.sellPrice }).where('id', '=', p.packId).execute();
        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'PRICE_CHANGED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'product_pack',
            entity_id: p.packId,
            state_before: JSON.stringify({ sellPrice: null }),
            state_after: JSON.stringify({ sellPrice: p.sellPrice, basis: `cost + ${body.markupPercent}%, rounded up to ${step}` }),
            occurred_at: new Date(),
          })
          .execute();
      }
    });

    return { updated: priced.length, skippedNoCost: rows.length - priced.length };
  });
}
