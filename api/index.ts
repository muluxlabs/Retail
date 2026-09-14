/**
 * Vercel serverless entry point.
 *
 * Wraps the Fastify app in a single catch-all function. Fastify expects a
 * long-running server; Vercel gives us one invocation per request. The bridge
 * is `app.server.emit('request', ...)`, which hands the raw Node request to
 * Fastify's own router.
 *
 * The instance is cached on the module scope so a warm invocation reuses the
 * built app and its connection pool. Cold invocations pay the build cost once.
 */

import { connect, loadEnv } from '@retail-ops/db';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildServer } from '../apps/api/src/server.js';

loadEnv();

type App = Awaited<ReturnType<typeof buildServer>>;
let cached: Promise<App> | null = null;

function start(): Promise<App> {
  // One connection per invocation. Vercel runs each request in its own
  // instance, so a large pool here multiplies by concurrency and exhausts
  // Postgres. The Neon POOLED connection string does the real pooling.
  const { db } = connect({ max: 1 });

  return buildServer({
    db,
    // Same origin on Vercel, so no cross-origin list is needed unless the
    // frontend is split onto its own domain.
    ...(process.env['CORS_ORIGINS'] === undefined
      ? {}
      : { corsOrigins: process.env['CORS_ORIGINS'].split(',').map((o) => o.trim()) }),
    // Vercel captures stdout; Fastify's own logger is the useful one here.
    logger: true,
  }).then(async (app) => {
    await app.ready();
    return app;
  });
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  cached ??= start();
  const app = await cached;
  app.server.emit('request', request, response);
}
