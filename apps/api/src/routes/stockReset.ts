/**
 * Start a branch fresh (set every product's stock there to zero).
 *
 * Two endpoints: a read-only preview of exactly what would be zeroed, and the
 * reset itself. Both require stock.reset (branch manager and administrator)
 * AND that the caller is allowed at that branch: a person scoped to one branch
 * cannot touch another's, and the check lives here, at the edge, in one place.
 *
 * The reset is deliberately hard to do by accident. It needs the branch code
 * typed back, a written reason, and the position count from the preview the
 * person actually looked at.
 */

import { OutsideBranchScope, StockResetNotConfirmed } from '@retail-ops/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { previewBranchReset, resetBranchStock } from '../services/stockReset.js';
import { parseBody, parseParams } from '../validation.js';

const idParams = z.object({ id: z.uuid() });

const resetBody = z.object({
  /** The branch code, typed by the person. Must match exactly (case aside). */
  confirmCode: z.string().trim().min(1).max(32),
  /** Why. Kept on the exception and the audit log, so it has to say something. */
  reason: z.string().trim().min(10, 'Say why - at least a short sentence.').max(500),
  /** `resettable` from the preview they confirmed. */
  expectedPositions: z.number().int().min(0),
});

/** Empty branchIds means group-wide; otherwise the branch must be one of theirs. */
function assertInScope(request: FastifyRequest, branchId: string): void {
  const scoped = request.user?.branchIds ?? [];
  if (scoped.length > 0 && !scoped.includes(branchId)) throw new OutsideBranchScope(branchId);
}

export async function registerStockResetRoutes(app: FastifyInstance): Promise<void> {
  async function loadBranch(id: string) {
    return app.db
      .selectFrom('branch')
      .select(['id', 'code', 'name'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  app.get(
    '/branches/:id/stock-reset/preview',
    { onRequest: [app.requirePermission('stock.reset')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      assertInScope(request, id);

      const branch = await loadBranch(id);
      if (branch === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No branch ${id}` } });
      }
      return { branchId: branch.id, branchCode: branch.code, branchName: branch.name, ...(await previewBranchReset(app.db, id)) };
    },
  );

  app.post(
    '/branches/:id/stock-reset',
    { onRequest: [app.requirePermission('stock.reset')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const body = parseBody(resetBody, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }
      assertInScope(request, id);

      const branch = await loadBranch(id);
      if (branch === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No branch ${id}` } });
      }
      if (body.confirmCode.toUpperCase() !== branch.code.toUpperCase()) {
        throw new StockResetNotConfirmed();
      }

      const result = await resetBranchStock(app.db, {
        branchId: branch.id,
        branchCode: branch.code,
        branchName: branch.name,
        actorId: actor.personId,
        reason: body.reason,
        expectedPositions: body.expectedPositions,
      });
      return { branchId: branch.id, branchCode: branch.code, branchName: branch.name, ...result };
    },
  );
}
