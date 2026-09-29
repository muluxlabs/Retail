/**
 * Fastify server assembly.
 *
 * `buildServer` takes its database as an argument rather than reaching for a
 * module-level singleton, so tests can hand it a transaction and roll back.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Database } from '@retail-ops/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { registerErrorHandler } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerExceptionRoutes } from './routes/exceptions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMovementRoutes } from './routes/movements.js';
import { registerCashRoutes } from './routes/cash.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerPriceRoutes } from './routes/prices.js';
import { registerProductRoutes } from './routes/products.js';
import { registerReferenceRoutes } from './routes/reference.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerProductReportRoutes } from './routes/productReports.js';
import { registerSalesReportRoutes } from './routes/salesReports.js';
import { registerSupplierRoutes } from './routes/suppliers.js';
import { registerOpeningStockRoutes } from './routes/openingStock.js';
import { registerDayCloseRoutes } from './routes/dayClose.js';
import { registerShiftRoutes } from './routes/shifts.js';
import { registerSupplierPriceRoutes } from './routes/supplierPrices.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerItemImportRoutes } from './routes/itemImport.js';
import { registerRecordImportRoutes } from './routes/recordImport.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerSaleRoutes } from './routes/sales.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStockLedgerRoutes } from './routes/stockLedger.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerReorderRoutes } from './routes/reorder.js';
import { registerNotMovingRoutes } from './routes/notMoving.js';
import { registerProductRemovalRoutes } from './routes/productRemoval.js';
import { registerStockResetRoutes } from './routes/stockReset.js';
import { registerStockRoutes } from './routes/stock.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
  }
}

export interface ServerOptions {
  db: Kysely<Database>;
  corsOrigins?: string[];
  logger?: boolean;
  /** Signs session cookies. Must be set to a real secret in production. */
  cookieSecret?: string;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    // Trust the proxy for client IPs once this sits behind one in Johannesburg.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate('db', options.db);

  // Credentials must be allowed for the session cookie, so only the origins
  // listed may call the API from a browser. With none listed (production on
  // Vercel, where the page and the API share one origin) no cross-origin call
  // is allowed at all - reflecting any origin with credentials would let any
  // website act as whoever is signed in.
  await app.register(cors, {
    origin: options.corsOrigins ?? false,
    credentials: true,
  });

  // Headers every response carries: never framed (clickjacking), never
  // content-sniffed, no referrer leaking ids off-site, and API data never
  // cached by a shared browser or proxy unless a route says otherwise.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    if (request.url.startsWith('/api/') && reply.getHeader('Cache-Control') === undefined) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  await app.register(cookie, {
    secret: options.cookieSecret ?? process.env['SESSION_SECRET'] ?? '',
  });

  await app.register(authPlugin);

  registerErrorHandler(app);

  await app.register(registerHealthRoutes);
  await app.register(
    async (api) => {
      await api.register(registerAuthRoutes);
      await api.register(registerUserRoutes);
      await api.register(registerReferenceRoutes);
      await api.register(registerProductRoutes);
      await api.register(registerStockRoutes);
      await api.register(registerExceptionRoutes);
      await api.register(registerMovementRoutes);
      await api.register(registerTransferRoutes);
      await api.register(registerCashRoutes);
      await api.register(registerDashboardRoutes);
      await api.register(registerSettingsRoutes);
      await api.register(registerReportRoutes);
      await api.register(registerStockResetRoutes);
      await api.register(registerStockLedgerRoutes);
      await api.register(registerExportRoutes);
      await api.register(registerReorderRoutes);
      await api.register(registerNotMovingRoutes);
      await api.register(registerProductRemovalRoutes);
      await api.register(registerSaleRoutes);
      await api.register(registerSalesReportRoutes);
      await api.register(registerProductReportRoutes);
      await api.register(registerSupplierRoutes);
      await api.register(registerOpeningStockRoutes);
      await api.register(registerDayCloseRoutes);
      await api.register(registerShiftRoutes);
      await api.register(registerSupplierPriceRoutes);
      await api.register(registerAuditRoutes);
      await api.register(registerItemImportRoutes);
      await api.register(registerRecordImportRoutes);
      await api.register(registerCustomerRoutes);
      await api.register(registerPriceRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
