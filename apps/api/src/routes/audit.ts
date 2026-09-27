/**
 * The audit log: every change to how the business is set up, and every
 * sign-in, with who, when, and the value before and after.
 *
 * The log itself is append-only (the database refuses edits and deletes);
 * this is its reading side. Staff tied to a branch see only that branch's
 * entries; group-wide readers see everything, including entries that belong
 * to no branch (settings, staff, prices).
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { businessTimezone } from '../services/purchasing.js';
import { parseQuery } from '../validation.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day is YYYY-MM-DD.');
const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  /** Comma-separated action codes. */
  actions: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[A-Z_,]*$/, 'Action codes are capital letters and underscores.')
    .optional(),
  actorId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', { onRequest: [app.requirePermission('audit.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const scope = scopedBranchIds(request);
    const tz = await businessTimezone(app.db);
    const actions = q.actions === undefined || q.actions === '' ? null : q.actions.split(',').filter((a) => a !== '');
    const like = q.q === undefined ? null : `%${q.q}%`;

    const where = sql`
      (${q.from ?? null}::date IS NULL OR a.occurred_at >= (${q.from ?? null}::date::timestamp AT TIME ZONE ${tz}))
      AND (${q.to ?? null}::date IS NULL OR a.occurred_at < ((${q.to ?? null}::date + 1)::timestamp AT TIME ZONE ${tz}))
      AND (${actions}::text[] IS NULL OR a.action_code = ANY(${actions}::text[]))
      AND (${q.actorId ?? null}::uuid IS NULL OR a.actor_id = ${q.actorId ?? null}::uuid)
      AND (${q.branchId ?? null}::uuid IS NULL OR a.branch_id = ${q.branchId ?? null}::uuid)
      AND (${q.entityType ?? null}::text IS NULL OR a.entity_type = ${q.entityType ?? null})
      AND (${q.entityId ?? null}::uuid IS NULL OR a.entity_id = ${q.entityId ?? null}::uuid)
      AND (${scope === null}::boolean OR a.branch_id = ANY(${scope ?? []}::uuid[]))
      AND (${like}::text IS NULL
           OR a.action_code ILIKE ${like}
           OR a.state_after::text ILIKE ${like}
           OR a.state_before::text ILIKE ${like}
           OR p.full_name ILIKE ${like})`;

    const [rows, total] = await Promise.all([
      sql<Record<string, unknown>>`
        SELECT a.seq, a.occurred_at AS "at", a.recorded_at AS "recordedAt", a.action_code AS "action",
               a.actor_id AS "actorId", p.full_name AS "actorName", a.branch_id AS "branchId", b.name AS "branchName",
               a.entity_type AS "entityType", a.entity_id AS "entityId", a.state_before AS "before", a.state_after AS "after",
               -- A readable name for what was changed, where one exists.
               CASE a.entity_type
                 WHEN 'product' THEN (SELECT name FROM product WHERE id = a.entity_id)
                 WHEN 'product_pack' THEN (SELECT pr.name || ' · ' || pk.label FROM product_pack pk JOIN product pr ON pr.id = pk.product_id WHERE pk.id = a.entity_id)
                 WHEN 'person' THEN (SELECT full_name FROM person WHERE id = a.entity_id)
                 WHEN 'supplier' THEN (SELECT name FROM supplier WHERE id = a.entity_id)
                 WHEN 'customer' THEN (SELECT name FROM customer WHERE id = a.entity_id)
                 WHEN 'branch' THEN (SELECT name FROM branch WHERE id = a.entity_id)
                 WHEN 'purchase_order' THEN (SELECT po_no FROM purchase_order WHERE id = a.entity_id)
                 WHEN 'goods_received' THEN (SELECT grn_no FROM goods_received WHERE id = a.entity_id)
                 WHEN 'purchase_return' THEN (SELECT prn_no FROM purchase_return WHERE id = a.entity_id)
                 WHEN 'opening_stock' THEN (SELECT doc_no FROM opening_stock WHERE id = a.entity_id)
                 WHEN 'customer_payment' THEN (SELECT receipt_no FROM customer_payment WHERE id = a.entity_id)
                 WHEN 'supplier_payment' THEN (SELECT payment_no FROM supplier_payment WHERE id = a.entity_id)
                 WHEN 'supplier_price_list' THEN (SELECT list_no FROM supplier_price_list WHERE id = a.entity_id)
                 WHEN 'shift' THEN (SELECT shift_no FROM shift WHERE id = a.entity_id)
                 WHEN 'day_close' THEN (SELECT close_no FROM day_close WHERE id = a.entity_id)
                 ELSE NULL
               END AS "entityName"
        FROM audit_log a
        LEFT JOIN person p ON p.id = a.actor_id
        LEFT JOIN branch b ON b.id = a.branch_id
        WHERE ${where}
        ORDER BY a.occurred_at DESC, a.seq DESC
        LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db),
      sql<{ n: number }>`
        SELECT count(*)::int AS n FROM audit_log a LEFT JOIN person p ON p.id = a.actor_id WHERE ${where}`.execute(app.db),
    ]);
    return { items: rows.rows, total: total.rows[0]?.n ?? 0, limit: q.limit, offset: q.offset };
  });

  /** What there is to filter by: the kinds of change recorded, and the people who made them. */
  app.get('/audit/facets', { onRequest: [app.requirePermission('audit.read')] }, async (request) => {
    const scope = scopedBranchIds(request);
    const [actions, people] = await Promise.all([
      sql<{ action: string; n: number }>`
        SELECT action_code AS action, count(*)::int AS n FROM audit_log
        WHERE (${scope === null}::boolean OR branch_id = ANY(${scope ?? []}::uuid[]))
        GROUP BY action_code ORDER BY action_code`.execute(app.db),
      sql<{ id: string; name: string; n: number }>`
        SELECT p.id, p.full_name AS name, count(*)::int AS n FROM audit_log a JOIN person p ON p.id = a.actor_id
        WHERE (${scope === null}::boolean OR a.branch_id = ANY(${scope ?? []}::uuid[]))
        GROUP BY p.id, p.full_name ORDER BY p.full_name`.execute(app.db),
    ]);
    return { actions: actions.rows, people: people.rows };
  });
}
