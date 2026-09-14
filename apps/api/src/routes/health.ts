/** Liveness and readiness. Readiness answers for the database, not for itself. */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/ready', async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(app.db);
      return { status: 'ready', database: 'up' };
    } catch {
      // A process that cannot reach its database is not ready to take traffic.
      return reply.status(503).send({ status: 'not-ready', database: 'down' });
    }
  });
}
