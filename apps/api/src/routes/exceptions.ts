/**
 * The exception queue.
 *
 * AD-4: every override, unlisted scan, backdate and count variance lands here
 * as a work item, not a log line. Clearing one requires a named person and a
 * timestamp - the schema's CHECK constraint refuses a cleared row without
 * both, so this endpoint cannot be talked into a silent close.
 *
 * The previous platform had "Suspicious reports" that nobody read. The
 * difference between that and this is that a work item has an owner.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseBody, parseParams, parseQuery } from '../validation.js';

const KINDS = [
  'negative_stock_override',
  'unlisted_barcode_scan',
  'backdated_entry',
  'count_variance',
  'transit_loss',
  'cash_variance',
  'price_override',
  'void_after_tender',
] as const;

const STATES = ['open', 'acknowledged', 'cleared', 'escalated'] as const;

const listQuery = z.object({
  state: z.enum(STATES).optional(),
  kind: z.enum(KINDS).optional(),
  branchId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParams = z.object({ id: z.uuid() });

const clearBody = z.object({
  /** Who is taking responsibility. Not optional - that is the whole control. */
  clearedBy: z.uuid(),
  note: z.string().trim().min(3).max(1000),
});

const stateBody = z.object({
  state: z.enum(['acknowledged', 'escalated']),
  actorId: z.uuid(),
  note: z.string().trim().max(1000).optional(),
});

export async function registerExceptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/exceptions', async (request) => {
    const q = parseQuery(listQuery, request.query);

    let query = app.db
      .selectFrom('exception_event')
      .innerJoin('branch', 'branch.id', 'exception_event.branch_id')
      .leftJoin('person as actor', 'actor.id', 'exception_event.actor_id')
      .leftJoin('person as clearer', 'clearer.id', 'exception_event.cleared_by')
      .leftJoin('product', 'product.id', 'exception_event.product_id')
      .select([
        'exception_event.id',
        'exception_event.kind',
        'exception_event.state',
        'exception_event.detail',
        'exception_event.value_impact as valueImpact',
        'exception_event.currency',
        'exception_event.occurred_at as occurredAt',
        'exception_event.recorded_at as recordedAt',
        'exception_event.cleared_at as clearedAt',
        'exception_event.clearing_note as clearingNote',
        'branch.id as branchId',
        'branch.code as branchCode',
        'branch.name as branchName',
        'actor.full_name as actorName',
        'clearer.full_name as clearedByName',
        'product.id as productId',
        'product.name as productName',
        'product.sku as productSku',
      ]);

    if (q.state !== undefined) query = query.where('exception_event.state', '=', q.state);
    if (q.kind !== undefined) query = query.where('exception_event.kind', '=', q.kind);
    if (q.branchId !== undefined) query = query.where('exception_event.branch_id', '=', q.branchId);

    const items = await query
      .orderBy('exception_event.occurred_at', 'desc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    // Counts per state and per kind, so the UI can show the shape of the
    // backlog without a second round trip.
    const byState = await app.db
      .selectFrom('exception_event')
      .select(['state', ({ fn }) => fn.countAll<number>().as('n')])
      .groupBy('state')
      .execute();

    const byKind = await app.db
      .selectFrom('exception_event')
      .select(['kind', ({ fn }) => fn.countAll<number>().as('n')])
      .where('state', '=', 'open')
      .groupBy('kind')
      .execute();

    return { items, byState, byKind, limit: q.limit, offset: q.offset };
  });

  app.get('/exceptions/:id', async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const row = await app.db
      .selectFrom('exception_event')
      .innerJoin('branch', 'branch.id', 'exception_event.branch_id')
      .leftJoin('person as actor', 'actor.id', 'exception_event.actor_id')
      .leftJoin('product', 'product.id', 'exception_event.product_id')
      .selectAll('exception_event')
      .select([
        'branch.code as branchCode',
        'branch.name as branchName',
        'actor.full_name as actorName',
        'product.name as productName',
      ])
      .where('exception_event.id', '=', id)
      .executeTakeFirst();

    if (row === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No exception ${id}` } });
    }
    return row;
  });

  /**
   * Clear a work item.
   *
   * Requires the clearing person and a note. Already-cleared items are
   * refused rather than silently re-cleared, so the audit trail keeps one
   * clearing event per exception.
   */
  app.post('/exceptions/:id/clear', async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = parseBody(clearBody, request.body);

    const current = await app.db
      .selectFrom('exception_event')
      .select(['id', 'state', 'kind', 'branch_id', 'detail'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (current === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No exception ${id}` } });
    }
    if (current.state === 'cleared') {
      return reply.status(409).send({
        error: { code: 'ALREADY_CLEARED', message: 'That exception has already been cleared.' },
      });
    }

    const person = await app.db
      .selectFrom('person')
      .select(['id', 'full_name'])
      .where('id', '=', body.clearedBy)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (person === undefined) {
      return reply.status(422).send({
        error: {
          code: 'UNKNOWN_PERSON',
          message: 'An exception can only be cleared by an active person.',
        },
      });
    }

    const updated = await app.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('exception_event')
        .set({
          state: 'cleared',
          cleared_by: body.clearedBy,
          cleared_at: new Date(),
          clearing_note: body.note,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // The audit log is append-only and separate from the queue: clearing is
      // itself an action somebody may later need to account for.
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: 'EXCEPTION_CLEARED',
          actor_id: body.clearedBy,
          terminal_id: null,
          branch_id: current.branch_id,
          entity_type: 'exception_event',
          entity_id: id,
          state_before: JSON.stringify({ state: current.state }),
          state_after: JSON.stringify({ state: 'cleared', note: body.note }),
          occurred_at: new Date(),
        })
        .execute();

      return row;
    });

    return { ...updated, clearedByName: person.full_name };
  });

  /** Acknowledge or escalate without closing. */
  app.post('/exceptions/:id/state', async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = parseBody(stateBody, request.body);

    const current = await app.db
      .selectFrom('exception_event')
      .select(['id', 'state', 'branch_id'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (current === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No exception ${id}` } });
    }
    if (current.state === 'cleared') {
      return reply.status(409).send({
        error: { code: 'ALREADY_CLEARED', message: 'A cleared exception cannot be reopened here.' },
      });
    }

    const row = await app.db
      .updateTable('exception_event')
      .set({ state: body.state })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: `EXCEPTION_${body.state.toUpperCase()}`,
        actor_id: body.actorId,
        terminal_id: null,
        branch_id: current.branch_id,
        entity_type: 'exception_event',
        entity_id: id,
        state_before: JSON.stringify({ state: current.state }),
        state_after: JSON.stringify({ state: body.state, note: body.note ?? null }),
        occurred_at: new Date(),
      })
      .execute();

    return row;
  });
}
