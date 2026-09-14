/**
 * Migration runner over `migrations/*.sql`.
 *
 * Plain SQL files, applied in filename order, each inside a transaction, each
 * recorded with a checksum. Deliberately not a migration framework: the schema
 * uses triggers, partial unique indexes, enums and views, and the SQL file is
 * the source of truth (HANDOFF section 7). A tool that generates DDL from
 * TypeScript would quietly become the source of truth instead.
 *
 * An already-applied file whose contents have changed is a hard error rather
 * than a silent re-run. Editing applied history is the same mistake as
 * editing the stock ledger: write a new file, never rewrite an old one.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/ and src/ are both one level below the package root. */
export const MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');

const LOG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);`;

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationOutcome {
  filename: string;
  status: 'applied' | 'already-applied';
  durationMs: number;
}

function checksum(sql: string): string {
  // Normalise line endings so a Windows checkout does not look like a change.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(path.join(dir, filename), 'utf8');
      return { filename, sql, checksum: checksum(sql) };
    }),
  );
}

/**
 * Apply every migration not yet recorded. Idempotent: running twice against
 * the same database applies nothing the second time.
 */
export async function migrate(
  pool: pg.Pool,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrationOutcome[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  await pool.query(LOG_TABLE_DDL);

  const applied = new Map<string, string>();
  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migration',
  );
  for (const row of rows) applied.set(row.filename, row.checksum);

  const migrations = await loadMigrations(dir);
  if (migrations.length === 0) {
    throw new Error(`No .sql migrations found in ${dir}`);
  }

  const outcomes: MigrationOutcome[] = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.filename);

    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.filename} has changed since it was applied.\n` +
            `  recorded: ${previous}\n` +
            `  on disk:  ${migration.checksum}\n` +
            'Applied migrations are immutable. Add a new migration instead.',
        );
      }
      outcomes.push({ filename: migration.filename, status: 'already-applied', durationMs: 0 });
      log(`  = ${migration.filename} (already applied)`);
      continue;
    }

    const startedAt = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)',
        [migration.filename, migration.checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.filename} failed and was rolled back: ${reason}`, {
        cause: error,
      });
    } finally {
      client.release();
    }

    const durationMs = Date.now() - startedAt;
    outcomes.push({ filename: migration.filename, status: 'applied', durationMs });
    log(`  + ${migration.filename} (${durationMs}ms)`);
  }

  return outcomes;
}

/** What has been applied, for the API's health endpoint and for humans. */
export async function migrationStatus(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<{ filename: string; applied: boolean }[]> {
  await pool.query(LOG_TABLE_DDL);
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migration',
  );
  const applied = new Set(rows.map((r) => r.filename));
  const migrations = await loadMigrations(dir);
  return migrations.map((m) => ({ filename: m.filename, applied: applied.has(m.filename) }));
}
