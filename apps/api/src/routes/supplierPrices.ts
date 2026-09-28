/**
 * Supplier price lists: preview a pasted list, apply it, read past imports,
 * and what each supplier currently charges for each pack.
 *
 * Importing changes selling prices, so it needs price.write; it also shows a
 * supplier's costs, so it needs supplier.read as well.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { applyPriceList, previewPriceList } from '../services/supplierPrices.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const step = z.union([z.literal(0.01), z.literal(0.05), z.literal(0.1), z.literal(0.5), z.literal(1)]);
const ruleBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep_margin'), roundTo: step.default(0.05) }),
  z.object({ mode: z.literal('markup'), markupPercent: z.number().min(0).max(1000), roundTo: step.default(0.05) }),
  z.object({ mode: z.literal('costs_only') }),
]);
type RuleBody = z.infer<typeof ruleBody>;
const toRule = (r: RuleBody) =>
  r.mode === 'costs_only'
    ? { mode: 'costs_only' as const }
    : r.mode === 'markup'
      ? { mode: 'markup' as const, markupPercent: r.markupPercent, roundToCents: Math.round(r.roundTo * 100) }
      : { mode: 'keep_margin' as const, roundToCents: Math.round(r.roundTo * 100) };

const cost = z.number().positive().max(10_000_000).refine((n) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, 'A cost has at most four decimals.');
const sell = z.number().positive().max(10_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'A price has at most two decimals.');

const previewBody = z.object({
  supplierId: z.uuid(),
  text: z.string().max(1_000_000),
  rule: ruleBody,
  /** Codes on the list the importer linked to an item themselves: code -> pack id. */
  links: z.record(z.string().max(60), z.uuid()).default({}),
});
const applyBody = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  rule: ruleBody,
  note: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(z.object({ packId: z.uuid(), supplierCode: z.string().trim().max(60).nullable(), cost, newSell: sell.nullable() }))
    .min(1)
    .max(5_000),
});
const listQuery = z.object({ supplierId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const idParams = z.object({ id: z.uuid() });

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function registerSupplierPriceRoutes(app: FastifyInstance): Promise<void> {
  const needsSupplierRead = async (request: FastifyRequest) => {
    if (!request.user?.permissions.has('supplier.read')) {
      throw Object.assign(new Error('Your role does not allow that action.'), { statusCode: 403, code: 'NOT_PERMITTED' });
    }
  };

  app.post('/supplier-price-lists/preview', { onRequest: [app.requirePermission('price.write'), needsSupplierRead] }, async (request) => {
    const b = parseBody(previewBody, request.body);
    return previewPriceList(app.db, { supplierId: b.supplierId, text: b.text, rule: toRule(b.rule), links: b.links });
  });

  app.post('/supplier-price-lists', { onRequest: [app.requirePermission('price.write'), needsSupplierRead] }, async (request, reply) => {
    const b = parseBody(applyBody, request.body);
    const r = await applyPriceList(app.db, {
      id: b.id, supplierId: b.supplierId, rule: toRule(b.rule), note: b.note ?? null, lines: b.lines, actorId: request.user!.personId,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/supplier-price-lists', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const r = await sql<Record<string, unknown>>`
      SELECT l.id, l.list_no AS "listNo", l.supplier_id AS "supplierId", s.name AS "supplierName", l.lines, l.prices_changed AS "pricesChanged",
             l.rule, l.note, l.created_at AS "createdAt", p.full_name AS "byName"
      FROM supplier_price_list l JOIN supplier s ON s.id = l.supplier_id JOIN person p ON p.id = l.created_by
      WHERE (${q.supplierId ?? null}::uuid IS NULL OR l.supplier_id = ${q.supplierId ?? null}::uuid)
      ORDER BY l.created_at DESC LIMIT ${q.limit}`.execute(app.db);
    return { items: r.rows };
  });

  app.get('/supplier-price-lists/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const h = await sql<Record<string, unknown>>`
      SELECT l.id, l.list_no AS "listNo", l.supplier_id AS "supplierId", s.name AS "supplierName", l.lines, l.prices_changed AS "pricesChanged",
             l.rule, l.note, l.created_at AS "createdAt", p.full_name AS "byName"
      FROM supplier_price_list l JOIN supplier s ON s.id = l.supplier_id JOIN person p ON p.id = l.created_by
      WHERE l.id = ${id}::uuid`.execute(app.db);
    const head = h.rows[0];
    if (head === undefined) throw Object.assign(new Error('No such price list.'), { statusCode: 404, code: 'NOT_FOUND' });
    const lines = await sql<Record<string, unknown>>`
      SELECT ln.line_no AS "lineNo", ln.pack_id AS "packId", pr.id AS "productId", pr.name, pr.sku, pk.label AS "packLabel",
             ln.supplier_code AS "supplierCode", ln.cost, ln.old_cost AS "oldCost", ln.old_sell AS "oldSell", ln.new_sell AS "newSell"
      FROM supplier_price_list_line ln JOIN product_pack pk ON pk.id = ln.pack_id JOIN product pr ON pr.id = pk.product_id
      WHERE ln.list_id = ${id}::uuid ORDER BY ln.line_no`.execute(app.db);
    return {
      ...head,
      items: lines.rows.map((l) => ({ ...l, cost: n(l['cost']), oldCost: n(l['oldCost']), oldSell: n(l['oldSell']), newSell: n(l['newSell']) })),
    };
  });

  /** What this supplier currently charges for each pack (fills in the price on a new order). */
  app.get('/suppliers/:id/items', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const r = await sql<Record<string, unknown>>`
      SELECT si.pack_id AS "packId", pr.id AS "productId", pr.name, pr.sku, pk.label AS "packLabel", si.supplier_code AS "supplierCode",
             si.cost, pk.sell_price AS "sellPrice", si.updated_at AS "updatedAt", l.list_no AS "listNo", l.id AS "listId"
      FROM supplier_item si JOIN product_pack pk ON pk.id = si.pack_id JOIN product pr ON pr.id = pk.product_id
      JOIN supplier_price_list l ON l.id = si.list_id
      WHERE si.supplier_id = ${id}::uuid ORDER BY pr.name, pk.qty_base`.execute(app.db);
    return { items: r.rows.map((x) => ({ ...x, cost: n(x['cost']), sellPrice: n(x['sellPrice']) })) };
  });
}
