/**
 * Writes to the ledger.
 *
 * Every handler here delegates to `services/stock.ts`, which delegates its
 * rules to packages/domain. No rule is stated in this file.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseBody } from '../validation.js';
import { logUnlistedScan, postCount, postMovement, resolveBarcode, sell } from '../services/stock.js';

const REASONS = [
  'grn',
  'grn_reversal',
  'sale',
  'sale_refund',
  'transfer_out',
  'transfer_in',
  'transfer_loss',
  'count_adjustment',
  'write_off',
  'opening_balance',
] as const;

const movementBody = z.object({
  /** Client-generated, so a resynced offline batch is a no-op. */
  eventId: z.uuid().optional(),
  productId: z.uuid(),
  branchId: z.uuid(),
  qtyBase: z.number().refine((n) => n !== 0, 'A movement must carry a non-zero quantity'),
  reason: z.enum(REASONS),
  actorId: z.uuid(),
  unitCost: z.number().nonnegative().nullable().default(null),
  docType: z.string().trim().max(32).nullable().default(null),
  docId: z.uuid().nullable().default(null),
  terminalId: z.uuid().nullable().default(null),
  occurredAt: z.coerce.date().optional(),
  // Deliberately NOT a field here. allowNegative bypasses the negative-stock
  // guard entirely, and /api/sales is the only place a client is allowed to
  // ask for that - gated on stock.override, and logged as an exception when
  // used. Internal callers that legitimately need it (postCount's shortage
  // adjustments, cancelTransfer's reversal) call postMovement/postMovementInTx
  // directly in TypeScript, never through this HTTP route, so they are
  // unaffected by its absence here. A generic movement.post holder posting
  // straight through this endpoint gets exactly the same block an
  // overselling till does, with no way to lift it - that used to not be
  // true, and it was a real hole: confirmed live, a cashier with no
  // stock.override could drive stock to -999,895 through this endpoint
  // alone, bypassing the same control /api/sales correctly enforces.
});

const sellBody = z.object({
  eventId: z.uuid().optional(),
  barcode: z.string().trim().min(1).max(32),
  qtyPacks: z.number().positive(),
  branchId: z.uuid(),
  actorId: z.uuid(),
  terminalId: z.uuid().nullable().default(null),
  overrideNegative: z.boolean().default(false),
  overrideBy: z.uuid().nullable().default(null),
});

const unlistedScanBody = z.object({
  code: z.string().trim().min(1).max(32),
  branchId: z.uuid(),
  actorId: z.uuid(),
  terminalId: z.uuid().nullable().default(null),
});

const countBody = z.object({
  branchId: z.uuid(),
  actorId: z.uuid(),
  docId: z.uuid().optional(),
  occurredAt: z.coerce.date().optional(),
  lines: z
    .array(z.object({ productId: z.uuid(), countedBase: z.number().nonnegative() }))
    .min(1, 'A count needs at least one line.'),
});

export async function registerMovementRoutes(app: FastifyInstance): Promise<void> {
  /** Post one movement. Idempotent on eventId. */
  app.post('/movements', { onRequest: [app.requirePermission('movement.post')] }, async (request, reply) => {
    const body = parseBody(movementBody, request.body);
    const result = await postMovement(app.db, body);
    // A replay is a success, but it is not a creation.
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /** A till sale, by barcode, in packs. */
  app.post('/sales', { onRequest: [app.requirePermission('movement.post')] }, async (request, reply) => {
    const body = parseBody(sellBody, request.body);

    // Overriding the negative-stock guard is a separate capability from making
    // a sale. Their stated problem is cashiers overriding "to their own
    // benefit"; a cashier holding movement.post must not be able to do it
    // alone, so the override is refused unless the caller also holds
    // stock.override.
    if (body.overrideNegative && request.user?.permissions.has('stock.override') !== true) {
      return reply.status(403).send({
        error: {
          code: 'NOT_PERMITTED',
          message: 'Overriding negative stock requires manager authorisation.',
          detail: { permission: 'stock.override' },
        },
      });
    }

    const result = await sell(app.db, body);
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /**
   * Post a stock count.
   *
   * Posting is the point: an unposted count changes nothing, which is how
   * four counts sat "In progress" while the variance never cleared.
   */
  app.post('/counts', { onRequest: [app.requirePermission('stock.adjust')] }, async (request, reply) => {
    const body = parseBody(countBody, request.body);
    const result = await postCount(app.db, body);
    const varianceLines = result.lines.filter((l) => l.variance !== 0);
    return reply.status(201).send({
      ...result,
      summary: {
        lines: result.lines.length,
        reconciled: result.lines.length - varianceLines.length,
        variances: varianceLines.length,
        netUnits: result.lines.reduce((sum, l) => sum + l.variance, 0),
        netValue: Number(
          result.lines.reduce((sum, l) => sum + (l.valueImpact ?? 0), 0).toFixed(2),
        ),
      },
    });
  });

  /**
   * Resolve a scan.
   *
   * An unresolved code returns 404 via `UnlistedBarcode`; the till is expected
   * to follow that with an exception, which is what makes the scan evidence.
   */
  app.get('/barcodes/:code', { onRequest: [app.requirePermission('product.read')] }, async (request) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(32) }).parse(request.params);
    return resolveBarcode(app.db, code);
  });

  /**
   * Log a scan that did not resolve to anything.
   *
   * This is the endpoint the route comment above always assumed existed. It
   * didn't: resolveBarcode returning 404 was a dead end with nothing writing
   * the exception it promised. Under-the-counter selling stays invisible
   * exactly as long as this gap does.
   */
  app.post(
    '/scans/unlisted',
    { onRequest: [app.requirePermission('movement.post')] },
    async (request, reply) => {
      const body = parseBody(unlistedScanBody, request.body);
      const result = await logUnlistedScan(app.db, body);
      return reply.status(201).send(result);
    },
  );
}
