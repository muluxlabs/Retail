/**
 * Cash custody.
 *
 * See services/cash.ts for the actual model. Nothing here states a rule
 * beyond routing and shape - the same discipline as every other write path.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { cashLedger, listCashPoints, moveCash, openCashPoint, postCashCount } from '../services/cash.js';
import { parseBody, parseQuery } from '../validation.js';

const listQuery = z.object({ branchId: z.uuid().optional() });

const ledgerQuery = z.object({
  cashPointId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const openBody = z.object({ cashPointId: z.uuid(), amount: z.number().positive() });

const moveBody = z.object({
  fromCashPointId: z.uuid(),
  toCashPointId: z.uuid(),
  amount: z.number().positive(),
  reason: z.enum(['float_issue', 'float_return', 'bank_deposit']),
});

const countBody = z.object({ cashPointId: z.uuid(), countedAmount: z.number().nonnegative() });

export async function registerCashRoutes(app: FastifyInstance): Promise<void> {
  /** Custody points with their current balance. */
  app.get('/cash', { onRequest: [app.requirePermission('cash.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    return { items: await listCashPoints(app.db, q) };
  });

  /**
   * Names only, no balance - what a blind count needs to pick a point.
   * Separate from GET /cash (which requires cash.read) so a cashier who
   * holds only cash.count can still choose which till they are counting
   * without ever being shown what the system expects first.
   */
  app.get('/cash/points', { onRequest: [app.requirePermission('cash.count')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const items = await listCashPoints(app.db, q);
    return {
      items: items.map(({ id, branchId, branchCode, kind, name, terminalId }) => ({
        id,
        branchId,
        branchCode,
        kind,
        name,
        terminalId,
      })),
    };
  });

  app.get('/cash/ledger', { onRequest: [app.requirePermission('cash.read')] }, async (request) => {
    const q = parseQuery(ledgerQuery, request.query);
    return { items: await cashLedger(app.db, q) };
  });

  /** Seed a custody point's opening balance. Refuses to run twice. */
  app.post('/cash/open', { onRequest: [app.requirePermission('cash.move')] }, async (request, reply) => {
    const body = parseBody(openBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }
    const result = await openCashPoint(app.db, { ...body, actorId: actor.personId });
    return reply.status(201).send(result);
  });

  /** Float out, float back, or a bank deposit - one custody point to another. */
  app.post('/cash/move', { onRequest: [app.requirePermission('cash.move')] }, async (request, reply) => {
    const body = parseBody(moveBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }
    const result = await moveCash(app.db, { ...body, actorId: actor.personId });
    return reply.status(201).send(result);
  });

  /**
   * The blind count. Deliberately takes only countedAmount - this route
   * never reads or returns `expected` until after posting, which is what
   * makes it blind rather than a confirmation dialog.
   */
  app.post('/cash/count', { onRequest: [app.requirePermission('cash.count')] }, async (request, reply) => {
    const body = parseBody(countBody, request.body);
    const actor = request.user;
    if (actor === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }
    const result = await postCashCount(app.db, { ...body, actorId: actor.personId });
    return reply.status(201).send(result);
  });
}
