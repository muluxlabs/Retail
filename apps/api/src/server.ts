/**
 * Fastify server assembly.
 *
 * `buildServer` takes its database as an argument rather than reaching for a
 * module-level singleton, so tests can hand it a transaction and roll back.
 */

import cors from '@fastify/cors';
import type { Database } from '@retail-ops/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { registerErrorHandler } from './errors.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerExceptionRoutes } from './routes/exceptions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMovementRoutes } from './routes/movements.js';
import { registerProductRoutes } from './routes/products.js';
import { registerReferenceRoutes } from './routes/reference.js';
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
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    // Trust the proxy for client IPs once this sits behind one in Johannesburg.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate('db', options.db);

  await app.register(cors, {
    origin: options.corsOrigins ?? true,
    credentials: true,
  });

  registerErrorHandler(app);

  await app.register(registerHealthRoutes);
  await app.register(
    async (api) => {
      await api.register(registerReferenceRoutes);
      await api.register(registerProductRoutes);
      await api.register(registerStockRoutes);
      await api.register(registerExceptionRoutes);
      await api.register(registerMovementRoutes);
      await api.register(registerDashboardRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
