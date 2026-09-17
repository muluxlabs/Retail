/**
 * Branch-to-branch transfers.
 *
 * Dispatch and receipt are gated on separate permissions - transfer.dispatch
 * and transfer.receive - so the person who sent stock out is never, by
 * construction, the only person able to confirm it arrived. See migration
 * 004 for the role grants and packages/api/src/services/transfer.ts for the
 * workflow itself; nothing here states a rule beyond routing and shape.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  cancelTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
} from '../services/transfer.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  branchId: z.uuid().optional(),
  state: z.enum(['dispatched', 'received', 'cancelled']).optional(),
});

const dispatchBody = z.object({
  originBranchId: z.uuid(),
  destinationBranchId: z.uuid(),
  notes: z.string().trim().max(1000).nullable().optional(),
  lines: z
    .array(z.object({ productId: z.uuid(), qtyDispatched: z.number().positive() }))
    .min(1, 'A transfer needs at least one line.'),
});

const receiveBody = z.object({
  lines: z
    .array(z.object({ productId: z.uuid(), qtyReceived: z.number().nonnegative() }))
    .min(1, 'Receiving needs at least one line.'),
});

const cancelBody = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transfers', { onRequest: [app.requirePermission('transfer.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    return { items: await listTransfers(app.db, q) };
  });

  app.get(
    '/transfers/:id',
    { onRequest: [app.requirePermission('transfer.read')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const transfer = await getTransfer(app.db, id);
      if (transfer === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No transfer ${id}` } });
      }
      return transfer;
    },
  );

  /**
   * Dispatch stock to another branch. Each line posts a transfer_out
   * movement at the origin through the same negative-stock guard every
   * other write path shares - dispatching more than is on hand fails the
   * same way overselling a till does.
   */
  app.post(
    '/transfers',
    { onRequest: [app.requirePermission('transfer.dispatch')] },
    async (request, reply) => {
      const body = parseBody(dispatchBody, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }
      const created = await dispatchTransfer(app.db, { ...body, actorId: actor.personId });
      return reply.status(201).send(created);
    },
  );

  /**
   * Confirm receipt. A separate permission from dispatch - see the file
   * header - and the destination is credited for exactly what this call
   * says arrived, never for what was dispatched.
   */
  app.post(
    '/transfers/:id/receive',
    { onRequest: [app.requirePermission('transfer.receive')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(receiveBody, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }
      const result = await receiveTransfer(app.db, id, { actorId: actor.personId, lines: body.lines });
      return result;
    },
  );

  /** Cancel a transfer still in transit. Reverses the dispatch, never edits it. */
  app.post(
    '/transfers/:id/cancel',
    { onRequest: [app.requirePermission('transfer.receive')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(cancelBody, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }
      const result = await cancelTransfer(app.db, id, { actorId: actor.personId, ...body });
      return result;
    },
  );
}
