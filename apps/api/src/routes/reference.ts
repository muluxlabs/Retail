/**
 * Reference data: branches, people, roles.
 *
 * Branches are the one entity here with real write operations - adding and
 * editing them is gated on branch.manage, granted to administrator only
 * (migration 006). A hard cap on active branches is enforced at creation,
 * read from system_setting rather than hardcoded, because raising it for a
 * client whose plan has grown is meant to be an operator action, not a
 * deploy.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseBody, parseParams, parseQuery } from '../validation.js';

const DEFAULT_BRANCH_CAP = 20;

const listBranchesQuery = z.object({
  includeInactive: z.coerce.boolean().default(false),
});

const idParams = z.object({ id: z.uuid() });

const createBranchBody = z.object({
  code: z.string().trim().min(1).max(16),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['store', 'warehouse']).default('store'),
});

const updateBranchBody = z.object({
  code: z.string().trim().min(1).max(16).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(['store', 'warehouse']).optional(),
  isActive: z.boolean().optional(),
});

async function branchCapacity(app: FastifyInstance): Promise<{ activeCount: number; limit: number }> {
  const [row, count] = await Promise.all([
    app.db.selectFrom('system_setting').select('value').where('key', '=', 'max_active_branches').executeTakeFirst(),
    app.db.selectFrom('branch').select(({ fn }) => fn.countAll<number>().as('n')).where('is_active', '=', true).executeTakeFirst(),
  ]);
  const parsed = row === undefined ? NaN : Number(row.value);
  return { activeCount: count?.n ?? 0, limit: Number.isFinite(parsed) ? parsed : DEFAULT_BRANCH_CAP };
}

export async function registerReferenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/branches', { onRequest: [app.requireAuth] }, async (request) => {
    const q = parseQuery(listBranchesQuery, request.query);
    let query = app.db.selectFrom('branch').select(['id', 'code', 'name', 'kind', 'is_active as isActive']);
    if (!q.includeInactive) query = query.where('is_active', '=', true);
    return query.orderBy('kind', 'desc').orderBy('name', 'asc').execute();
  });

  /** How many of the cap are used. Shown on the branch management screen. */
  app.get('/branches/capacity', { onRequest: [app.requirePermission('branch.manage')] }, async () =>
    branchCapacity(app),
  );

  /**
   * Add a branch. Refused once active branches reach the cap - the client's
   * own framing was that more branches means more stock, more items, more
   * database, and that the price should scale with that, so the limit is a
   * real refusal here, not a suggestion the UI merely discourages.
   */
  app.post('/branches', { onRequest: [app.requirePermission('branch.manage')] }, async (request, reply) => {
    const body = parseBody(createBranchBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

    const { activeCount, limit } = await branchCapacity(app);
    if (activeCount >= limit) {
      return reply.status(409).send({
        error: {
          code: 'BRANCH_LIMIT_REACHED',
          message: `This deployment is licensed for ${limit} active branches and already has ${activeCount}. Contact the developer to raise the limit.`,
          detail: { activeCount, limit },
        },
      });
    }

    const created = await app.db
      .insertInto('branch')
      .values({ code: body.code, name: body.name, kind: body.kind })
      .returning(['id', 'code', 'name', 'kind', 'is_active as isActive'])
      .executeTakeFirstOrThrow();

    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: 'BRANCH_CREATED',
        actor_id: actor.personId,
        terminal_id: null,
        branch_id: created.id,
        entity_type: 'branch',
        entity_id: created.id,
        state_before: null,
        state_after: JSON.stringify(body),
        occurred_at: new Date(),
      })
      .execute();

    return reply.status(201).send(created);
  });

  /**
   * Amend a branch, including reactivating one. Reactivating counts against
   * the cap exactly like creating - a deactivated branch does not sit there
   * blocking a slot, but bringing it back does check the limit again.
   */
  app.patch('/branches/:id', { onRequest: [app.requirePermission('branch.manage')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = parseBody(updateBranchBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }

    const before = await app.db
      .selectFrom('branch')
      .select(['id', 'code', 'name', 'kind', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (before === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No branch ${id}` } });
    }

    if (body.isActive === true && !before.is_active) {
      const { activeCount, limit } = await branchCapacity(app);
      if (activeCount >= limit) {
        return reply.status(409).send({
          error: {
            code: 'BRANCH_LIMIT_REACHED',
            message: `This deployment is licensed for ${limit} active branches and already has ${activeCount}. Contact the developer to raise the limit.`,
            detail: { activeCount, limit },
          },
        });
      }
    }

    const updated = await app.db
      .updateTable('branch')
      .set({
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
      })
      .where('id', '=', id)
      .returning(['id', 'code', 'name', 'kind', 'is_active as isActive'])
      .executeTakeFirstOrThrow();

    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: 'BRANCH_UPDATED',
        actor_id: actor.personId,
        terminal_id: null,
        branch_id: id,
        entity_type: 'branch',
        entity_id: id,
        state_before: JSON.stringify(before),
        state_after: JSON.stringify(body),
        occurred_at: new Date(),
      })
      .execute();

    return updated;
  });

  app.get('/people', { onRequest: [app.requireAuth] }, async () =>
    app.db
      .selectFrom('person')
      .select(['id', 'full_name as fullName', 'phone', 'email', 'is_active as isActive'])
      .where('is_active', '=', true)
      .orderBy('full_name', 'asc')
      .execute(),
  );

  app.get('/roles', { onRequest: [app.requireAuth] }, async () =>
    app.db.selectFrom('role').select(['id', 'name']).orderBy('name', 'asc').execute(),
  );
}
