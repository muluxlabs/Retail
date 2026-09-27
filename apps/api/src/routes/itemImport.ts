/**
 * Importing items from a spreadsheet. The browser reads the file (Excel or
 * CSV) into rows of heading → text and sends them; the server checks them
 * against the item master, and imports. Adding items needs product.write;
 * setting their prices on the way in also needs price.write.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope } from '../scope.js';
import { checkImport, runImport } from '../services/itemImport.js';
import { parseBody } from '../validation.js';

const MAX_ROWS = 5_000;
const rowsBody = {
  headings: z.array(z.string().max(100)).min(1).max(60),
  rows: z
    .array(z.record(z.string().max(100), z.union([z.string().max(500), z.number(), z.null()]).transform((v) => (v === null ? '' : String(v)))))
    .min(1, 'The file has no rows under its heading.')
    .max(MAX_ROWS, `Up to ${MAX_ROWS.toLocaleString('en')} rows at a time: split the file.`),
};
const checkBody = z.object(rowsBody);
const importBody = z.object({
  id: z.uuid(),
  fileName: z.string().trim().max(200).nullable().optional(),
  /** Look-alike items (by key) to create anyway. */
  confirmSimilar: z.array(z.string().max(300)).max(MAX_ROWS).default([]),
  /** The branch the file's stock on hand is at; null to leave the stock out. */
  stockBranchId: z.uuid().nullable().default(null),
  ...rowsBody,
});

export async function registerItemImportRoutes(app: FastifyInstance): Promise<void> {
  const big = { bodyLimit: 8 * 1024 * 1024 };

  app.post('/products/import/check', { onRequest: [app.requirePermission('product.write')], ...big }, async (request) => {
    const b = parseBody(checkBody, request.body);
    const r = await checkImport(app.db, b.rows, b.headings);
    return { ...r, mayPrice: request.user!.permissions.has('price.write'), mayOpenStock: request.user!.permissions.has('stock.opening') };
  });

  app.post('/products/import', { onRequest: [app.requirePermission('product.write')], ...big }, async (request, reply) => {
    const b = parseBody(importBody, request.body);
    if (b.stockBranchId !== null) {
      // Bringing stock in is opening stock: its own permission, at a branch this person works for.
      if (!request.user!.permissions.has('stock.opening')) {
        throw Object.assign(new Error('Bringing in stock needs the opening stock permission: import without the stock, or ask someone who has it.'), { statusCode: 403, code: 'NOT_PERMITTED' });
      }
      assertInScope(request, b.stockBranchId);
    }
    const r = await runImport(app.db, {
      id: b.id, fileName: b.fileName ?? null, rows: b.rows, headings: b.headings, actorId: request.user!.personId,
      mayPrice: request.user!.permissions.has('price.write'), confirmSimilar: b.confirmSimilar, stockBranchId: b.stockBranchId,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/products/imports', { onRequest: [app.requirePermission('product.read')] }, async () => {
    const r = await sql<Record<string, unknown>>`
      SELECT i.id, i.import_no AS "importNo", i.file_name AS "fileName", i.items_created AS "itemsCreated", i.packs_created AS "packsCreated",
             i.categories_created AS "categoriesCreated", i.rows_skipped AS "rowsSkipped", i.prices_set AS "pricesSet",
             i.created_at AS "createdAt", p.full_name AS "byName"
      FROM item_import i JOIN person p ON p.id = i.created_by ORDER BY i.created_at DESC LIMIT 50`.execute(app.db);
    return { items: r.rows };
  });
}
