/**
 * Branch scope.
 *
 * A person's roles can be tied to particular branches (`branchIds`); an empty
 * list means group-wide. Anything that reads or writes one branch's business -
 * a sale, a receipt, a reset - checks it here, once, so the rule is the same
 * everywhere and cannot be forgotten in one route.
 */

import { OutsideBranchScope } from '@retail-ops/domain';
import type { FastifyRequest } from 'fastify';

/** Refuse unless the caller may act at this branch. */
export function assertInScope(request: FastifyRequest, branchId: string): void {
  const scoped = request.user?.branchIds ?? [];
  if (scoped.length > 0 && !scoped.includes(branchId)) throw new OutsideBranchScope(branchId);
}

/** The branches a caller is limited to, or null when they can see all of them. */
export function scopedBranchIds(request: FastifyRequest): string[] | null {
  const scoped = request.user?.branchIds ?? [];
  return scoped.length > 0 ? scoped : null;
}
