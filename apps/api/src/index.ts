/** API entrypoint. Reads configuration, connects, serves, shuts down cleanly. */

import { connect, migrationStatus } from '@retail-ops/db';

import { buildServer } from './server.js';

const port = Number(process.env['API_PORT'] ?? 3000);
const host = process.env['API_HOST'] ?? '0.0.0.0';
const corsOrigins = (process.env['CORS_ORIGINS'] ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

const { pool, db } = connect();

// Refuse to serve against a schema that has not been migrated. A half-applied
// schema produces confusing 500s rather than an obvious failure.
const pending = (await migrationStatus(pool)).filter((m) => !m.applied);
if (pending.length > 0) {
  process.stderr.write(
    `\nRefusing to start: ${pending.length} migration(s) pending.\n` +
      `  ${pending.map((m) => m.filename).join('\n  ')}\n\nRun: npm run db:migrate\n\n`,
  );
  process.exit(1);
}

const app = await buildServer({ db, corsOrigins });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app
      .close()
      .then(() => db.destroy())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
