/**
 * Database CLI.
 *
 *   npm run db:migrate     apply pending migrations
 *   npm run db:seed        load development data
 *   npm run db:status      what is applied, what is pending
 *   npm run db:reset       DROP the public schema, re-migrate, re-seed
 *
 * `reset` is destructive and refuses to touch anything that does not look
 * like a local development database.
 */

import { loadEnv } from './env.js';
import { connect } from './pool.js';
import { migrate, migrationStatus } from './migrate.js';
import { seed } from './seed.js';

loadEnv();

const log = (m: string): void => {
  process.stdout.write(`${m}\n`);
};

/**
 * Guard on `reset`. Dropping a schema is the one genuinely destructive thing
 * in this package, so it is gated on the connection looking local.
 */
function assertLocal(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL; refusing to reset.');
  }
  const local = ['localhost', '127.0.0.1', '::1', 'db', 'postgres'];
  if (!local.includes(host)) {
    throw new Error(
      `Refusing to reset a database on host "${host}". ` +
        'reset drops the entire public schema and is for local development only.',
    );
  }
}

/**
 * Print sign-in details once. These are never recoverable afterwards: only the
 * scrypt hash is stored, and every account must change its password on first
 * use.
 */
function printAccounts(accounts: { email: string; password: string | null }[]): void {
  if (accounts.length === 0) return;
  const width = Math.max(...accounts.map((a) => a.email.length));
  log('');
  log('  Sign-in details (shown once, not recoverable):');
  log('  ' + '-'.repeat(width + 24));
  for (const a of accounts) {
    log(`  ${a.email.padEnd(width)}   ${a.password ?? '(unchanged)'}`);
  }
  log('  ' + '-'.repeat(width + 24));
  log('  Every account must set a new password at first sign-in.');
  log('');
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'migrate';
  const force = process.argv.includes('--force');
  const { pool, db } = connect({ max: 1 });

  try {
    switch (command) {
      case 'migrate': {
        log('Applying migrations...');
        const outcomes = await migrate(pool, { log });
        const applied = outcomes.filter((o) => o.status === 'applied').length;
        log(applied === 0 ? 'Already up to date.' : `Applied ${applied} migration(s).`);
        return 0;
      }

      case 'seed': {
        log('Seeding development data...');
        const result = await seed(db, { force, log });
        log(
          `Done: ${result.products} products, ${result.movements} movements, ` +
            `${result.exceptions} open exceptions across ${result.branches} branches.`,
        );
        printAccounts(result.accounts);
        return 0;
      }

      case 'status': {
        const rows = await migrationStatus(pool);
        log('Migrations:');
        for (const r of rows) log(`  ${r.applied ? '[x]' : '[ ]'} ${r.filename}`);
        const pending = rows.filter((r) => !r.applied).length;
        log(pending === 0 ? 'Schema is up to date.' : `${pending} migration(s) pending.`);
        return pending === 0 ? 0 : 1;
      }

      case 'reset': {
        assertLocal(process.env['DATABASE_URL'] ?? '');
        log('Dropping public schema...');
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        log('Applying migrations...');
        await migrate(pool, { log });
        log('Seeding...');
        const result = await seed(db, { log });
        log(`Reset complete: ${result.products} products, ${result.movements} movements.`);
        printAccounts(result.accounts);
        return 0;
      }

      default: {
        log(`Unknown command: ${command}`);
        log('Usage: migrate | seed | status | reset');
        return 1;
      }
    }
  } finally {
    await db.destroy().catch(() => pool.end());
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nDatabase command failed:\n  ${message}\n\n`);
    process.exitCode = 1;
  });
