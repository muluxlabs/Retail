/**
 * Cashier shifts: open a till with a counted float, close it with a blind count,
 * and the shift report.
 *
 * A cashier never sees what the till should hold until their count is in: the
 * open shift's expected cash is only shown to supervisors and those who read sales.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { closeShift, openShift, shiftReport, shiftsRequired } from '../services/shifts.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const openBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  cashPointId: z.uuid(),
  cashierId: z.uuid().optional(),
  counted: z.number().min(0).max(100_000_000),
  note: z.string().trim().max(500).nullable().optional(),
});
const closeBody = z.object({
  counted: z.number().min(0).max(100_000_000),
  note: z.string().trim().max(500).nullable().optional(),
});
const tillsQuery = z.object({ branchId: z.uuid() });
const listQuery = z.object({
  branchId: z.uuid().optional(),
  status: z.enum(['open', 'closed', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const idParams = z.object({ id: z.uuid() });

const n = (v: unknown): number => Number(v ?? 0);

const denied = () => Object.assign(new Error('Your role does not allow that action.'), { statusCode: 403, code: 'NOT_PERMITTED' });

/** Supervisors, and those who may read sales (auditor, finance), see every shift. */
function oversees(request: FastifyRequest): boolean {
  const p = request.user?.permissions;
  return p !== undefined && (p.has('shift.manage') || p.has('sale.read'));
}

export async function registerShiftRoutes(app: FastifyInstance): Promise<void> {
  /** The signed-in cashier's open shift, if any, and whether tills need one. */
  app.get('/shifts/current', { onRequest: [app.requireAuth] }, async (request) => {
    const me = request.user!.personId;
    const r = await sql<Record<string, unknown>>`
      SELECT sh.id, sh.shift_no AS "shiftNo", sh.branch_id AS "branchId", b.name AS "branchName",
             sh.cash_point_id AS "tillId", cp.name AS "tillName", sh.opened_at AS "openedAt", sh.opening_counted AS "float",
             (SELECT count(*)::int FROM sale s WHERE s.shift_id = sh.id) AS receipts
      FROM shift sh JOIN branch b ON b.id = sh.branch_id JOIN cash_point cp ON cp.id = sh.cash_point_id
      WHERE sh.cashier_id = ${me}::uuid AND sh.closed_at IS NULL`.execute(app.db);
    const s = r.rows[0];
    return {
      required: await shiftsRequired(app.db),
      shift: s === undefined ? null : { ...s, float: n(s['float']), receipts: n(s['receipts']) },
    };
  });

  /** The tills at a branch and who is on each one right now. */
  app.get('/shifts/tills', { onRequest: [app.requirePermission('shift.open')] }, async (request) => {
    const q = parseQuery(tillsQuery, request.query);
    assertInScope(request, q.branchId);
    const r = await sql<Record<string, unknown>>`
      SELECT cp.id, cp.name, sh.id AS "shiftId", sh.shift_no AS "shiftNo", pe.id AS "cashierId", pe.full_name AS "cashierName", sh.opened_at AS "openedAt"
      FROM cash_point cp
      LEFT JOIN shift sh ON sh.cash_point_id = cp.id AND sh.closed_at IS NULL
      LEFT JOIN person pe ON pe.id = sh.cashier_id
      WHERE cp.branch_id = ${q.branchId}::uuid AND cp.kind = 'till' AND cp.is_active
      ORDER BY cp.name, cp.id`.execute(app.db);
    return { tills: r.rows };
  });

  app.post('/shifts/open', { onRequest: [app.requirePermission('shift.open')] }, async (request, reply) => {
    const b = parseBody(openBody, request.body);
    assertInScope(request, b.branchId);
    const me = request.user!.personId;
    const cashierId = b.cashierId ?? me;
    if (cashierId !== me && !request.user!.permissions.has('shift.manage')) throw denied();
    const r = await openShift(app.db, { ...b, cashierId, openedBy: me, note: b.note ?? null });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/shifts/:id/close', { onRequest: [app.requirePermission('shift.open')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const b = parseBody(closeBody, request.body);
    const s = await app.db.selectFrom('shift').select(['branch_id']).where('id', '=', id).executeTakeFirst();
    if (s !== undefined) assertInScope(request, s.branch_id);
    return closeShift(app.db, {
      shiftId: id, closedBy: request.user!.personId, counted: b.counted, note: b.note ?? null,
      canManage: request.user!.permissions.has('shift.manage'),
    });
  });

  app.get('/shifts', { onRequest: [app.requireAuth] }, async (request) => {
    if (!oversees(request)) throw denied();
    const q = parseQuery(listQuery, request.query);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const limitTo = scopedBranchIds(request);
    const rows = await sql<Record<string, unknown>>`
      SELECT sh.id, sh.shift_no AS "shiftNo", b.id AS "branchId", b.name AS "branchName", cp.name AS "tillName",
             pe.full_name AS "cashierName", sh.opened_at AS "openedAt", sh.closed_at AS "closedAt",
             sh.opening_counted AS "float", sh.opening_variance AS "openingVariance",
             sh.closing_expected AS "closingExpected", sh.closing_counted AS "closingCounted", sh.closing_variance AS "closingVariance",
             (SELECT count(*)::int FROM sale s WHERE s.shift_id = sh.id) AS receipts,
             (SELECT coalesce(sum(s.net_total), 0) FROM sale s WHERE s.shift_id = sh.id) AS net
      FROM shift sh JOIN branch b ON b.id = sh.branch_id JOIN cash_point cp ON cp.id = sh.cash_point_id JOIN person pe ON pe.id = sh.cashier_id
      WHERE (${q.branchId ?? null}::uuid IS NULL OR sh.branch_id = ${q.branchId ?? null}::uuid)
        AND (${limitTo === null}::boolean OR sh.branch_id = ANY(${limitTo ?? []}::uuid[]))
        AND (${q.status} = 'all' OR (${q.status} = 'open') = (sh.closed_at IS NULL))
      ORDER BY sh.opened_at DESC, sh.shift_no DESC
      LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    return {
      shifts: rows.rows.map((r) => ({
        ...r,
        float: n(r['float']),
        openingVariance: n(r['openingVariance']),
        closingExpected: r['closingExpected'] === null ? null : n(r['closingExpected']),
        closingCounted: r['closingCounted'] === null ? null : n(r['closingCounted']),
        closingVariance: r['closingVariance'] === null ? null : n(r['closingVariance']),
        receipts: n(r['receipts']),
        net: n(r['net']),
      })),
    };
  });

  /**
   * One shift's report. The cashier sees their own once it is closed; while it is
   * open only overseers see it, so the closing count stays blind.
   */
  app.get('/shifts/:id', { onRequest: [app.requireAuth] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const r = await shiftReport(app.db, id);
    if (r === undefined) throw Object.assign(new Error('No such shift.'), { statusCode: 404, code: 'NOT_FOUND' });
    assertInScope(request, r.branchId as string);
    const own = r.cashierId === request.user!.personId;
    if (!oversees(request) && !(own && r.closedAt !== null)) throw denied();
    return r;
  });
}
