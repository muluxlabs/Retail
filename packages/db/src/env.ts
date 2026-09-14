/**
 * Load the repository-root `.env`.
 *
 * npm workspace scripts run with the package directory as CWD, so a `.env` at
 * the repository root is not where anything looks by default. This walks up
 * until it finds one.
 *
 * Uses `process.loadEnvFile` (Node 20.12+), so there is no dotenv dependency.
 * Real environment variables always win: in production the platform sets
 * DATABASE_URL and a stray `.env` on a server must not silently override it.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal KEY=VALUE parser, used only if `process.loadEnvFile` is missing. */
function parseInto(file: string): void {
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Find and load the nearest `.env`, searching upward from `startDir`.
 * Returns the path loaded, or null when there is none (which is normal in
 * production, where the environment is supplied by the platform).
 */
export function loadEnv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      const before = { ...process.env };
      if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(candidate);
        // loadEnvFile overwrites; restore anything the real environment had set.
        for (const [key, value] of Object.entries(before)) {
          if (value !== undefined) process.env[key] = value;
        }
      } else {
        parseInto(candidate);
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
