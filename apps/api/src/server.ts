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
import { registerProductRoutes } from './routes/products.js';
import { registerReferenceRoutes } from './routes/reference.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerSettingsRoutes } from './routes/settings.js';
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

  // Credentials must be allowed for the session cookie, and a wildcard origin
  // is invalid alongside credentials, so production must list real origins.
  await app.register(cors, {
    origin: options.corsOrigins ?? true,
    credentials: true,
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
    },
    { prefix: '/api' },
  );

  return app;
}
