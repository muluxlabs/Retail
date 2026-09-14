/**
 * Sign in, sign out, whoami, change password.
 *
 * There is no public registration route, by design. This is a back office
 * holding stock valuations and an audit trail for twelve branches; anyone who
 * could self-register would see all of it. Accounts are created by an
 * administrator through /api/users, which is the retail equivalent of signing
 * up and keeps one-human-one-record intact.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  login,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  writeAuthAudit,
} from '../services/auth.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '@retail-ops/db';
import { parseBody } from '../validation.js';

const loginBody = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/** Cookie settings. Secure in production; lax so normal navigation works. */
function cookieOptions(expires: Date, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const secure = process.env['NODE_ENV'] === 'production';

  app.post('/auth/login', async (request, reply) => {
    const body = parseBody(loginBody, request.body);

    const result = await login(app.db, {
      email: body.email,
      password: body.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 401;
      return reply.status(status).send({
        error: {
          code: result.reason === 'locked' ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CREDENTIALS',
          message: result.message,
        },
      });
    }

    reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(result.expiresAt, secure));

    return {
      user: {
        personId: result.user.personId,
        fullName: result.user.fullName,
        email: result.user.email,
        roles: result.user.roles,
        permissions: [...result.user.permissions],
        branchIds: result.user.branchIds,
        mustChangePassword: result.user.mustChangePassword,
      },
      expiresAt: result.expiresAt,
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.user !== null) {
      await revokeSession(app.db, request.user.sessionId, 'signed out');
      await writeAuthAudit(app.db, request.user.personId, 'LOGOUT', {}, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Who am I, and what may I do. The web app calls this on every load. */
  app.get('/auth/me', async (request, reply) => {
    if (request.user === null) {
      return reply.status(401).send({
        error: { code: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' },
      });
    }
    return {
      personId: request.user.personId,
      fullName: request.user.fullName,
      email: request.user.email,
      roles: request.user.roles,
      permissions: [...request.user.permissions],
      branchIds: request.user.branchIds,
      mustChangePassword: request.user.mustChangePassword,
    };
  });

  app.post(
    '/auth/change-password',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const body = parseBody(changePasswordBody, request.body);
      const user = request.user;
      if (user === null) return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' } });

      const credential = await app.db
        .selectFrom('user_credential')
        .select(['password_hash as passwordHash', 'email'])
        .where('person_id', '=', user.personId)
        .executeTakeFirstOrThrow();

      if (!(await verifyPassword(body.currentPassword, credential.passwordHash))) {
        await writeAuthAudit(app.db, user.personId, 'PASSWORD_CHANGE_FAILED', {}, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return reply.status(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' },
        });
      }

      if (body.newPassword === body.currentPassword) {
        return reply.status(422).send({
          error: { code: 'PASSWORD_UNCHANGED', message: 'New password must differ from the current one.' },
        });
      }

      const strength = checkPasswordStrength(body.newPassword, credential.email);
      if (!strength.ok) {
        return reply.status(422).send({ error: { code: 'PASSWORD_TOO_WEAK', message: strength.reason } });
      }

      await app.db
        .updateTable('user_credential')
        .set({
          password_hash: await hashPassword(body.newPassword),
          must_change_password: false,
          updated_at: new Date(),
        })
        .where('person_id', '=', user.personId)
        .execute();

      // Every other session for this person dies. If the old password had
      // been shared or stolen, changing it must actually evict whoever had it.
      await revokeAllSessions(app.db, user.personId, 'password changed', user.sessionId);

      await writeAuthAudit(app.db, user.personId, 'PASSWORD_CHANGED', {}, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );
}
