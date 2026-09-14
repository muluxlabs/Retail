/** Reference data: branches, people, roles. Read-only for this slice. */

import type { FastifyInstance } from 'fastify';

export async function registerReferenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/branches', { onRequest: [app.requireAuth] }, async () =>
    app.db
      .selectFrom('branch')
      .select(['id', 'code', 'name', 'kind', 'is_active as isActive'])
      .where('is_active', '=', true)
      .orderBy('kind', 'desc')
      .orderBy('name', 'asc')
      .execute(),
  );

  app.get('/people', { onRequest: [app.requireAuth] }, async () =>
    app.db
      .selectFrom('person')
      .select(['id', 'full_name as fullName', 'phone', 'email', 'is_active as isActive'])
      .where('is_active', '=', true)
      .orderBy('full_name', 'asc')
      .execute(),
  );

  app.get('/roles', { onRequest: [app.requireAuth] }, async () =>
    app.db.selectFrom('role').select(['id', 'name']).orderBy('name', 'asc').execute(),
  );
}
