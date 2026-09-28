/**
 * Password hashing.
 *
 * Lives in packages/db rather than in the API because two callers need it and
 * neither may hold a private copy: the API's auth routes, and the seeding CLI
 * that creates the first administrator. It sits with `user_credential`, the
 * table it protects.
 *
 * scrypt from `node:crypto`, not argon2 or bcrypt. Both of those are native
 * modules, and this deploys to Vercel's serverless runtime where a native
 * build is a recurring source of breakage. scrypt is memory-hard, built into
 * Node, and needs no compilation step. It is a legitimate choice here; argon2id
 * would be marginally stronger and is the thing to revisit if this ever moves
 * to a container runtime.
 *
 * The stored format is self-describing:
 *
 *     scrypt$N$r$p$<salt base64>$<derived key base64>
 *
 * so parameters can be raised later and old hashes still verify. `needsRehash`
 * reports when a stored hash is below current cost, and the login path upgrades
 * it transparently on the next successful sign-in.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to scrypt's three-argument overload, which drops the
// cost parameters. Declare the shape we actually call.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Cost parameters. N=2^15 with r=8 needs about 32 MB and lands around
 * 100-150ms on a small serverless instance - slow enough to make online
 * guessing expensive, fast enough not to stall a till sign-in.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt needs maxmem above roughly 128 * N * r, with headroom. */
const MAX_MEM = 128 * N * R * 2;

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Tokens a password may not be built around.
 *
 * Matched as a SUBSTRING after normalisation, not as a whole string. An
 * earlier version compared only the whole value, so "password" was rejected
 * while "password12" sailed through - which is the shape almost every weak
 * password actually takes.
 *
 * The product and domain words are here deliberately. A password made from
 * the name of the thing it protects is the first guess anyone makes, and this
 * system is called Retail Operations.
 */
const BANNED_TOKENS = [
  'password', 'passwd', 'letmein', 'welcome', 'qwerty', 'asdfgh', 'zxcvbn',
  'admin', 'administrator', 'login', 'secret', 'changeme', 'iloveyou',
  'monkey', 'dragon', 'sunshine', 'default', 'temp', 'test1234',
  // The system, the business, and the place.
  'retail', 'retailops', 'supermarket', 'grocery', 'stock', 'inventory',
  'zimbabwe', 'harare', 'bulawayo',
];

/** Runs we treat as having no entropy, forwards or backwards. */
const SEQUENCES = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];

const RUN_LENGTH = 4;

function normalise(password: string): string {
  return password.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The word a password is built around, with decorative digits stripped off. */
function core(normalised: string): string {
  return normalised.replace(/^[0-9]+/, '').replace(/[0-9]+$/, '');
}

function findSequentialRun(normalised: string): string | null {
  for (const sequence of SEQUENCES) {
    for (let i = 0; i + RUN_LENGTH <= sequence.length; i += 1) {
      const run = sequence.slice(i, i + RUN_LENGTH);
      if (normalised.includes(run)) return run;
      const reversed = [...run].reverse().join('');
      if (normalised.includes(reversed)) return reversed;
    }
  }
  return null;
}

export interface PasswordProblem {
  ok: false;
  reason: string;
}

export type PasswordCheck = { ok: true } | PasswordProblem;

/**
 * Composition rules deliberately favour length and unpredictability over
 * character-class theatre: forced symbols produce `Password1!` on a sticky
 * note, which is precisely the failure mode HANDOFF section 2.6 describes
 * with shared and unattributable accounts.
 */
export function checkPasswordStrength(password: string, email?: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 200) {
    return { ok: false, reason: 'Password must be 200 characters or fewer.' };
  }

  const normalised = normalise(password);
  const stem = core(normalised);

  // Built around a banned word: "example@1234", "password12", "Welcome2026".
  for (const token of BANNED_TOKENS) {
    if (stem === token || normalised === token) {
      return {
        ok: false,
        reason: `"${token}" is too easily guessed, with or without numbers on the end.`,
      };
    }
    // Or the token dominates what was chosen.
    if (token.length >= 5 && normalised.includes(token) && token.length * 2 >= normalised.length) {
      return {
        ok: false,
        reason: `Password is mostly the word "${token}". Choose something unrelated to this system.`,
      };
    }
  }

  const run = findSequentialRun(normalised);
  if (run !== null) {
    return { ok: false, reason: `Password contains the predictable run "${run}".` };
  }

  if (email !== undefined) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    const domain = email.split('@')[1]?.split('.')[0]?.toLowerCase() ?? '';
    if (local.length >= 3 && normalised.includes(local)) {
      return { ok: false, reason: 'Password must not contain your email address.' };
    }
    if (domain.length >= 4 && normalised.includes(domain)) {
      return { ok: false, reason: 'Password must not contain your organisation name.' };
    }
  }

  if (new Set(password).size < 5) {
    return { ok: false, reason: 'Password is too repetitive. Choose something less predictable.' };
  }

  // A single word with digits tacked on is the most common weak shape there
  // is. Require some structure beyond that.
  if (/^[a-z]+[0-9]*$/.test(normalised) && stem.length < 8) {
    return {
      ok: false,
      reason: 'One short word with numbers on the end is too easy to guess. Use several words.',
    };
  }

  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Verify a candidate against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt
 * row must fail closed, not crash the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const keyB64 = parts[5];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (saltB64 === undefined || keyB64 === undefined) return false;

  // Refuse absurd stored parameters rather than letting a tampered row
  // allocate unbounded memory during verification.
  if (n > 1_048_576 || r > 32 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(keyB64, 'base64');
    actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
  } catch {
    return false;
  }

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

/**
 * A readable temporary password for an administrator to hand over.
 *
 * Avoids characters that are misread when dictated or written down (0/O,
 * 1/l/I), because these get read out over a phone to a branch.
 */
function draw(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 9) {
      out += '-';
      continue;
    }
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

export function generateTemporaryPassword(): string {
  // Random draws occasionally contain a run the policy refuses - "vwxy" and
  // "3456" both turn up in practice. Issuing a credential this system would
  // itself reject is incoherent, so draw again until one passes.
  //
  // Checked without an email address because the generator does not know whose
  // account it is for; the account-specific rules are applied at the point the
  // person chooses their own password.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = draw();
    if (checkPasswordStrength(candidate).ok) return candidate;
  }
  // Unreachable in practice. Fail loudly rather than hand back a weak
  // credential or loop forever.
  throw new Error('Could not generate a temporary password meeting the policy');
}
