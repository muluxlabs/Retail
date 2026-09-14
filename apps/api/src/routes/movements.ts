/**
 * Writes to the ledger.
 *
 * Every handler here delegates to `services/stock.ts`, which delegates its
 * rules to packages/domain. No rule is stated in this file.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseBody } from '../validation.js';
import { postCount, postMovement, resolveBarcode, sell } from '../services/stock.js';

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
  allowNegative: z.boolean().default(false),
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
  app.post('/movements', async (request, reply) => {
    const body = parseBody(movementBody, request.body);
    const result = await postMovement(app.db, body);
    // A replay is a success, but it is not a creation.
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /** A till sale, by barcode, in packs. */
  app.post('/sales', async (request, reply) => {
    const body = parseBody(sellBody, request.body);
    const result = await sell(app.db, body);
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /**
   * Post a stock count.
   *
   * Posting is the point: an unposted count changes nothing, which is how
   * four counts sat "In progress" while the variance never cleared.
   */
  app.post('/counts', async (request, reply) => {
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
  app.get('/barcodes/:code', async (request) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(32) }).parse(request.params);
    return resolveBarcode(app.db, code);
  });
}
