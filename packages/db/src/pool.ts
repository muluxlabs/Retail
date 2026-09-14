/**
 * Connection pool and Kysely instance.
 *
 * The type-parser block below is not boilerplate. node-postgres returns
 * `numeric` and `bigint` as STRINGS by default, because neither fits a JS
 * number in the general case. Left alone, `SUM(qty_base)` arrives as "380"
 * and `"380" + 20` is `"38020"`. On a stock system that is not a bug you find
 * in testing, it is a bug you find in a variance report.
 *
 * We convert both to `number`, which is what `packages/domain` uses and what
 * the API serialises. The precision trade is deliberate and bounded:
 * `numeric(14,4)` carries at most 14 significant digits and a float64 holds
 * 15-17, so every value the schema permits round-trips exactly. Should the
 * business ever need wider numerics, this decision is the thing to revisit.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

const { Pool, types } = pg;

// OID 1700 = numeric. Quantities, costs, value impacts.
types.setTypeParser(1700, (value) => Number.parseFloat(value));
// OID 20 = int8/bigserial. stock_movement.seq, audit_log.seq, last_synced_seq.
// Safe until 2^53 movements, which is several billion years of trading.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export interface PoolOptions {
  connectionString?: string;
  /** Keep this low for the API and 1 for one-shot scripts like migrate. */
  max?: number;
}

export function createPool(options: PoolOptions = {}): pg.Pool {
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or pass connectionString.',
    );
  }
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    // Fail fast rather than hanging a request behind an unreachable database.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Pool plus Kysely, for callers that just want a database. */
export function connect(options: PoolOptions = {}): {
  pool: pg.Pool;
  db: Kysely<Database>;
} {
  const pool = createPool(options);
  return { pool, db: createDb(pool) };
}

/** True once the database answers. Used by the API's readiness check. */
export async function ping(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
