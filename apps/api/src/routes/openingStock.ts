/**
 * Opening stock documents: introduce stock at a branch, look back at what was introduced.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { postOpeningStock } from '../services/openingStock.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const unitCost = z
  .number()
  .min(0)
  .max(10_000_000)
  .refine((n) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, 'A cost has at most four decimal places.');

const postBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(z.object({ productId: z.uuid(), packId: z.uuid(), qtyPacks: z.number().positive().max(10_000_000), unitCost: unitCost.nullable() }))
    .min(1, 'Add at least one item.')
    .max(1000, 'At most 1,000 items in one document; post the rest as a second one.'),
});

const resolveBody = z.object({
  branchId: z.uuid(),
  codes: z.array(z.string().trim().min(1).max(64)).min(1).max(1000),
});

const branchQuery = z.object({ branchId: z.uuid() });
const listQuery = z.object({
  branchId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const idParams = z.object({ id: z.uuid() });

const n = (v: unknown): number => Number(v ?? 0);

export async function registerOpeningStockRoutes(app: FastifyInstance): Promise<void> {
  app.post('/opening-stock', { onRequest: [app.requirePermission('stock.opening')] }, async (request, reply) => {
    const b = parseBody(postBody, request.body);
    assertInScope(request, b.branchId);
    const r = await postOpeningStock(app.db, { ...b, note: b.note ?? null, enteredBy: request.user!.personId });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  /**
   * Match pasted SKUs or barcodes to items, with what each already has on hand
   * at the branch - so a list from a spreadsheet or an old system can be
   * checked before anything is posted.
   */
  app.post('/opening-stock/resolve', { onRequest: [app.requirePermission('stock.opening')] }, async (request) => {
    const b = parseBody(resolveBody, request.body);
    assertInScope(request, b.branchId);
    const codes = [...new Set(b.codes)];
    const rows = await sql<Record<string, unknown>>`
      WITH c(code) AS (SELECT unnest(${codes}::text[]))
      SELECT c.code,
             coalesce(bp.product_id, sp.id) AS "productId",
             coalesce(bp.pack_id, (SELECT pk.id FROM product_pack pk WHERE pk.product_id = sp.id ORDER BY pk.is_default_buy DESC, pk.qty_base LIMIT 1)) AS "packId"
      FROM c
      LEFT JOIN LATERAL (
        SELECT pk.product_id, pk.id AS pack_id FROM barcode bc JOIN product_pack pk ON pk.id = bc.pack_id WHERE bc.code = c.code LIMIT 1
      ) bp ON true
      LEFT JOIN LATERAL (
        SELECT p.id FROM product p WHERE lower(p.sku) = lower(c.code) AND p.merged_into_id IS NULL LIMIT 1
      ) sp ON bp.product_id IS NULL`.execute(app.db);

    const ids = [...new Set(rows.rows.map((r) => r['productId']).filter((x): x is string => typeof x === 'string'))];
    const products = ids.length === 0 ? [] : await app.db
      .selectFrom('product')
      .select(['id', 'sku', 'name', 'merged_into_id as merged'])
      .where('id', 'in', ids)
      .execute();
    const packs = ids.length === 0 ? [] : await app.db
      .selectFrom('product_pack')
      .select(['id', 'product_id as productId', 'label', 'qty_base as qtyBase', 'is_default_buy as isDefaultBuy'])
      .where('product_id', 'in', ids)
      .orderBy('qty_base')
      .execute();
    const onHand = ids.length === 0 ? [] : await app.db
      .selectFrom('stock_on_hand')
      .select(['product_id as productId', 'qty_base as qtyBase'])
      .where('branch_id', '=', b.branchId)
      .where('product_id', 'in', ids)
      .execute();
    const pById = new Map(products.map((p) => [p.id, p]));
    const ohById = new Map(onHand.map((o) => [o.productId, n(o.qtyBase)]));

    return {
      items: rows.rows.map((r) => {
        const pid = r['productId'] as string | null;
        const p = pid === null ? undefined : pById.get(pid);
        if (p === undefined || p.merged !== null) return { code: r['code'], match: null };
        return {
          code: r['code'],
          match: {
            productId: p.id,
            sku: p.sku,
            name: p.name,
            packId: r['packId'],
            packs: packs.filter((k) => k.productId === p.id).map((k) => ({ id: k.id, label: k.label, qtyBase: n(k.qtyBase) })),
            onHand: ohById.get(p.id) ?? 0,
          },
        };
      }),
    };
  });

  /** Items with something on hand at a branch: those cannot be opened again. */
  app.get('/opening-stock/positions', { onRequest: [app.requirePermission('stock.opening')] }, async (request) => {
    const q = parseQuery(branchQuery, request.query);
    assertInScope(request, q.branchId);
    const rows = await app.db
      .selectFrom('stock_on_hand')
      .select(['product_id as productId', 'qty_base as qtyBase'])
      .where('branch_id', '=', q.branchId)
      .where('qty_base', '!=', 0)
      .execute();
    return { items: rows.map((r) => ({ productId: r.productId, qtyBase: n(r.qtyBase) })) };
  });

  app.get('/opening-stock', { onRequest: [app.requirePermission('stock.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const limitTo = scopedBranchIds(request);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const rows = await sql<Record<string, unknown>>`
      SELECT o.id, o.doc_no AS "docNo", o.entered_at AS "enteredAt", o.total_cost AS "totalCost", o.note,
             b.id AS "branchId", b.name AS "branchName", pe.full_name AS "enteredByName",
             (SELECT count(*)::int FROM opening_stock_line l WHERE l.doc_id = o.id) AS lines,
             (SELECT count(*)::int FROM opening_stock_line l WHERE l.doc_id = o.id AND l.unit_cost IS NULL) AS "linesWithoutCost",
             (SELECT coalesce(sum(l.qty_base), 0) FROM opening_stock_line l WHERE l.doc_id = o.id) AS units
      FROM opening_stock o JOIN branch b ON b.id = o.branch_id JOIN person pe ON pe.id = o.entered_by
      WHERE true
        ${limitTo === null ? sql`` : sql`AND o.branch_id IN (${sql.join(limitTo)})`}
        ${q.branchId === undefined ? sql`` : sql`AND o.branch_id = ${q.branchId}`}
      ORDER BY o.entered_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    return { items: rows.rows.map((r) => ({ ...r, totalCost: n(r['totalCost']), units: n(r['units']) })) };
  });

  app.get('/opening-stock/:id', { onRequest: [app.requirePermission('stock.read')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const head = await sql<Record<string, unknown>>`
      SELECT o.id, o.doc_no AS "docNo", o.entered_at AS "enteredAt", o.total_cost AS "totalCost", o.note,
             b.id AS "branchId", b.name AS "branchName", b.code AS "branchCode", pe.full_name AS "enteredByName"
      FROM opening_stock o JOIN branch b ON b.id = o.branch_id JOIN person pe ON pe.id = o.entered_by
      WHERE o.id = ${id}::uuid`.execute(app.db);
    const h = head.rows[0];
    if (h === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No opening stock document ${id}` } });
    assertInScope(request, String(h['branchId']));
    const lines = await sql<Record<string, unknown>>`
      SELECT l.line_no AS "lineNo", l.product_id AS "productId", p.sku, p.name, pk.label AS "packLabel",
             l.qty_packs AS "qtyPacks", l.qty_base AS "qtyBase", l.unit_cost AS "unitCost", l.line_total AS "lineTotal"
      FROM opening_stock_line l JOIN product p ON p.id = l.product_id JOIN product_pack pk ON pk.id = l.pack_id
      WHERE l.doc_id = ${id}::uuid ORDER BY l.line_no`.execute(app.db);
    return {
      ...h,
      totalCost: n(h['totalCost']),
      lines: lines.rows.map((l) => ({
        ...l,
        qtyPacks: n(l['qtyPacks']),
        qtyBase: n(l['qtyBase']),
        unitCost: l['unitCost'] === null ? null : n(l['unitCost']),
        lineTotal: l['lineTotal'] === null ? null : n(l['lineTotal']),
      })),
    };
  });
}
