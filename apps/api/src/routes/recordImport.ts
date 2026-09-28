/**
 * Importing customers and suppliers from a spreadsheet. The browser reads the
 * file (Excel or CSV) into rows of heading → text; the server checks them
 * against what is on file, and imports.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { checkCustomers, checkSuppliers, importCustomers, importSuppliers } from '../services/recordImport.js';
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
  confirmSimilar: z.array(z.string().max(40)).max(MAX_ROWS).default([]),
  ...rowsBody,
});

export async function registerRecordImportRoutes(app: FastifyInstance): Promise<void> {
  const big = { bodyLimit: 8 * 1024 * 1024 };

  app.post('/customers/import/check', { onRequest: [app.requirePermission('customer.write')], ...big }, async (request) => {
    const b = parseBody(checkBody, request.body);
    return checkCustomers(app.db, b.rows, b.headings);
  });
  app.post('/customers/import', { onRequest: [app.requirePermission('customer.write')], ...big }, async (request, reply) => {
    const b = parseBody(importBody, request.body);
    const r = await importCustomers(app.db, {
      id: b.id, fileName: b.fileName ?? null, rows: b.rows, headings: b.headings, confirmSimilar: b.confirmSimilar,
      actorId: request.user!.personId, actorBranchId: request.user!.branchIds[0] ?? null,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/suppliers/import/check', { onRequest: [app.requirePermission('supplier.write')], ...big }, async (request) => {
    const b = parseBody(checkBody, request.body);
    return checkSuppliers(app.db, b.rows, b.headings);
  });
  app.post('/suppliers/import', { onRequest: [app.requirePermission('supplier.write')], ...big }, async (request, reply) => {
    const b = parseBody(importBody, request.body);
    const r = await importSuppliers(app.db, {
      id: b.id, fileName: b.fileName ?? null, rows: b.rows, headings: b.headings, confirmSimilar: b.confirmSimilar, actorId: request.user!.personId,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });
}
