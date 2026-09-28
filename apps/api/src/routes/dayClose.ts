/**
 * End of day: the X report (the day so far) and closing the day (the Z report).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { closeDay, previewDay } from '../services/dayClose.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const closeBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  note: z.string().trim().max(500).nullable().optional(),
  counts: z.array(z.object({ cashPointId: z.uuid(), counted: z.number().min(0).max(100_000_000) })).max(50),
});
const branchQuery = z.object({ branchId: z.uuid() });
const listQuery = z.object({
  branchId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const idParams = z.object({ id: z.uuid() });

const n = (v: unknown): number => Number(v ?? 0);

export async function registerDayCloseRoutes(app: FastifyInstance): Promise<void> {
  /** Reading closes: the people who close, and those who may read sales (auditor, finance). */
  const mayRead = async (request: FastifyRequest) => {
    const p = request.user?.permissions;
    if (p === undefined) throw Object.assign(new Error('Sign in.'), { statusCode: 401, code: 'NOT_AUTHENTICATED' });
    if (!p.has('day.close') && !p.has('sale.read')) {
      throw Object.assign(new Error('Your role does not allow that action.'), { statusCode: 403, code: 'NOT_PERMITTED' });
    }
  };

  app.get('/day-close/preview', { onRequest: [app.requirePermission('day.close')] }, async (request) => {
    const q = parseQuery(branchQuery, request.query);
    assertInScope(request, q.branchId);
    return previewDay(app.db, q.branchId);
  });

  app.post('/day-close', { onRequest: [app.requirePermission('day.close')] }, async (request, reply) => {
    const b = parseBody(closeBody, request.body);
    assertInScope(request, b.branchId);
    const r = await closeDay(app.db, { ...b, note: b.note ?? null, closedBy: request.user!.personId });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/day-close', { onRequest: [app.requireAuth, mayRead] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const limitTo = scopedBranchIds(request);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const rows = await sql<Record<string, unknown>>`
      SELECT d.id, d.close_no AS "closeNo", d.business_day::text AS "businessDay", d.period_from AS "periodFrom", d.period_to AS "periodTo",
             d.receipts, d.net_sales AS "net", d.cash_expected AS "cashExpected", d.cash_counted AS "cashCounted", d.cash_variance AS "cashVariance",
             b.id AS "branchId", b.name AS "branchName", pe.full_name AS "closedByName"
      FROM day_close d JOIN branch b ON b.id = d.branch_id JOIN person pe ON pe.id = d.closed_by
      WHERE true
        ${limitTo === null ? sql`` : sql`AND d.branch_id IN (${sql.join(limitTo)})`}
        ${q.branchId === undefined ? sql`` : sql`AND d.branch_id = ${q.branchId}`}
      ORDER BY d.period_to DESC LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    return {
      items: rows.rows.map((r) => ({ ...r, receipts: n(r['receipts']), net: n(r['net']), cashExpected: n(r['cashExpected']), cashCounted: n(r['cashCounted']), cashVariance: n(r['cashVariance']) })),
    };
  });

  app.get('/day-close/:id', { onRequest: [app.requireAuth, mayRead] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const r = await sql<Record<string, unknown>>`
      SELECT d.id, d.close_no AS "closeNo", d.business_day::text AS "businessDay", d.period_from AS "periodFrom", d.period_to AS "periodTo",
             d.from_receipt_no AS "fromReceiptNo", d.to_receipt_no AS "toReceiptNo", d.note,
             d.receipts, d.gross_sales AS gross, d.discounts, d.net_sales AS net, d.cost_of_sales AS cost,
             d.cash_expected AS "cashExpected", d.cash_counted AS "cashCounted", d.cash_variance AS "cashVariance", d.detail,
             b.id AS "branchId", b.name AS "branchName", b.code AS "branchCode", pe.full_name AS "closedByName"
      FROM day_close d JOIN branch b ON b.id = d.branch_id JOIN person pe ON pe.id = d.closed_by
      WHERE d.id = ${id}::uuid`.execute(app.db);
    const d = r.rows[0];
    if (d === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No Z report ${id}` } });
    assertInScope(request, String(d['branchId']));
    const num = ['receipts', 'gross', 'discounts', 'net', 'cost', 'cashExpected', 'cashCounted', 'cashVariance', 'fromReceiptNo', 'toReceiptNo'];
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, num.includes(k) ? n(v) : v]));
  });
}
