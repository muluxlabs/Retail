/**
 * Authentication: sessions, sign-in, and the permission lookup.
 *
 * Sessions are opaque random tokens stored as a SHA-256 hash. The cookie
 * carries the token; the database only ever holds its digest, so a leaked
 * backup does not yield live sessions. They are revoked, never deleted
 * (HANDOFF §10) - "who was signed in when this happened" has to stay
 * answerable after the fact.
 *
 * Every sign-in attempt, success or failure, is written to `audit_log`.
 * The sponsor is an auditor and their current system cannot prove who used
 * an account.
 */

import type { Database } from '@retail-ops/db';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';

import { hashPassword, needsRehash, verifyPassword } from '@retail-ops/db';

type Db = Kysely<Database>;

export const SESSION_COOKIE = 'retail_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one long shift
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface AuthenticatedUser {
  personId: string;
  fullName: string;
  email: string;
  permissions: Set<string>;
  roles: string[];
  /** Branch ids this person is scoped to. Empty means group-wide. */
  branchIds: string[];
  mustChangePassword: boolean;
  sessionId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare two secrets without leaking length or content through timing.
 * Used for the bootstrap-token check on first-run admin creation.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface LoginFailure {
  ok: false;
  /** Shown to the user. Deliberately identical for every failure mode. */
  message: string;
  /** For the audit log only, never sent to the client. */
  reason: 'unknown_email' | 'bad_password' | 'locked' | 'inactive';
  retryAfterMs?: number;
}

export interface LoginSuccess {
  ok: true;
  token: string;
  expiresAt: Date;
  user: AuthenticatedUser;
}

/** One message for every failure, so the form cannot be used to enumerate staff. */
const GENERIC_FAILURE = 'Email or password is incorrect.';

export async function login(
  db: Db,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
): Promise<LoginSuccess | LoginFailure> {
  const email = input.email.trim().toLowerCase();

  const credential = await db
    .selectFrom('user_credential')
    .innerJoin('person', 'person.id', 'user_credential.person_id')
    .select([
      'user_credential.person_id as personId',
      'user_credential.email as email',
      'user_credential.password_hash as passwordHash',
      'user_credential.must_change_password as mustChangePassword',
      'user_credential.failed_attempts as failedAttempts',
      'user_credential.locked_until as lockedUntil',
      'person.full_name as fullName',
      'person.is_active as isActive',
    ])
    .where((eb) => eb(eb.fn('lower', ['user_credential.email']), '=', email))
    .executeTakeFirst();

  if (credential === undefined) {
    // Spend comparable time to a real verification so a missing account is not
    // distinguishable by response time.
    await verifyPassword(input.password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    await writeAuthAudit(db, null, 'LOGIN_FAILED', { email, reason: 'unknown_email' }, input);
    return { ok: false, message: GENERIC_FAILURE, reason: 'unknown_email' };
  }

  if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > Date.now()) {
    await writeAuthAudit(db, credential.personId, 'LOGIN_BLOCKED', { reason: 'locked' }, input);
    return {
      ok: false,
      message: 'Too many failed attempts. Try again shortly.',
      reason: 'locked',
      retryAfterMs: credential.lockedUntil.getTime() - Date.now(),
    };
  }

  if (!credential.isActive) {
    await writeAuthAudit(db, credential.personId, 'LOGIN_BLOCKED', { reason: 'inactive' }, input);
    return { ok: false, message: GENERIC_FAILURE, reason: 'inactive' };
  }

  const valid = await verifyPassword(input.password, credential.passwordHash);

  if (!valid) {
    const attempts = credential.failedAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await db
      .updateTable('user_credential')
      .set({
        failed_attempts: attempts,
        locked_until: lock ? new Date(Date.now() + LOCKOUT_MS) : null,
        updated_at: new Date(),
      })
      .where('person_id', '=', credential.personId)
      .execute();
    await writeAuthAudit(
      db,
      credential.personId,
      'LOGIN_FAILED',
      { reason: 'bad_password', attempts, locked: lock },
      input,
    );
    return { ok: false, message: GENERIC_FAILURE, reason: 'bad_password' };
  }

  // Transparently upgrade a hash made with older parameters.
  if (needsRehash(credential.passwordHash)) {
    await db
      .updateTable('user_credential')
      .set({ password_hash: await hashPassword(input.password), updated_at: new Date() })
      .where('person_id', '=', credential.personId)
      .execute();
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const session = await db
    .insertInto('user_session')
    .values({
      token_hash: hashToken(token),
      person_id: credential.personId,
      expires_at: expiresAt,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .updateTable('user_credential')
    .set({ failed_attempts: 0, locked_until: null, last_login_at: new Date(), updated_at: new Date() })
    .where('person_id', '=', credential.personId)
    .execute();

  await writeAuthAudit(db, credential.personId, 'LOGIN_SUCCEEDED', { sessionId: session.id }, input);

  const grants = await loadGrants(db, credential.personId);

  return {
    ok: true,
    token,
    expiresAt,
    user: {
      personId: credential.personId,
      fullName: credential.fullName,
      email: credential.email,
      mustChangePassword: credential.mustChangePassword,
      sessionId: session.id,
      ...grants,
    },
  };
}

/** Resolve a cookie token to a live session, or null. */
export async function resolveSession(db: Db, token: string): Promise<AuthenticatedUser | null> {
  if (token === '') return null;

  const row = await db
    .selectFrom('user_session')
    .innerJoin('person', 'person.id', 'user_session.person_id')
    .innerJoin('user_credential', 'user_credential.person_id', 'user_session.person_id')
    .select([
      'user_session.id as sessionId',
      'user_session.person_id as personId',
      'user_session.expires_at as expiresAt',
      'user_session.revoked_at as revokedAt',
      'person.full_name as fullName',
      'person.is_active as isActive',
      'user_credential.email as email',
      'user_credential.must_change_password as mustChangePassword',
    ])
    .where('user_session.token_hash', '=', hashToken(token))
    .executeTakeFirst();

  if (row === undefined) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.isActive) return null;

  const grants = await loadGrants(db, row.personId);

  return {
    personId: row.personId,
    fullName: row.fullName,
    email: row.email,
    mustChangePassword: row.mustChangePassword,
    sessionId: row.sessionId,
    ...grants,
  };
}

async function loadGrants(
  db: Db,
  personId: string,
): Promise<{ permissions: Set<string>; roles: string[]; branchIds: string[] }> {
  const rows = await db
    .selectFrom('person_role')
    .leftJoin('role_permission', 'role_permission.role_id', 'person_role.role_id')
    .select([
      'person_role.role_id as roleId',
      'person_role.branch_id as branchId',
      'role_permission.permission_id as permissionId',
    ])
    .where('person_role.person_id', '=', personId)
    .execute();

  const permissions = new Set<string>();
  const roles = new Set<string>();
  const branchIds = new Set<string>();
  for (const row of rows) {
    roles.add(row.roleId);
    if (row.permissionId !== null) permissions.add(row.permissionId);
    if (row.branchId !== null) branchIds.add(row.branchId);
  }
  return { permissions, roles: [...roles], branchIds: [...branchIds] };
}

export async function revokeSession(db: Db, sessionId: string, reason: string): Promise<void> {
  await db
    .updateTable('user_session')
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Used after a password change: every other session for that person dies. */
export async function revokeAllSessions(
  db: Db,
  personId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<void> {
  let query = db
    .updateTable('user_session')
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where('person_id', '=', personId)
    .where('revoked_at', 'is', null);
  if (exceptSessionId !== undefined) query = query.where('id', '!=', exceptSessionId);
  await query.execute();
}

export async function writeAuthAudit(
  db: Db,
  personId: string | null,
  action: string,
  detail: Record<string, unknown>,
  context: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      event_id: crypto.randomUUID(),
      action_code: action,
      actor_id: personId,
      terminal_id: null,
      branch_id: null,
      entity_type: 'person',
      entity_id: personId,
      state_before: null,
      state_after: JSON.stringify({
        ...detail,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      }),
      occurred_at: new Date(),
    })
    .execute();
}
