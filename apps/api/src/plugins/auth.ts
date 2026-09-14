/**
 * Authentication plugin: attaches the signed-in user to every request and
 * exposes the guards routes use.
 *
 * The guards are capability-based, never role-name based. A route asks for
 * `exception.clear`, not for "manager". That is what lets the client grant a
 * branch manager price overrides without also granting stock adjustments -
 * the separation their current five roles cannot express (HANDOFF §2.6).
 */

import { DomainError } from '@retail-ops/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { resolveSession, SESSION_COOKIE, type AuthenticatedUser } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null on an anonymous request. */
    user: AuthenticatedUser | null;
  }
  interface FastifyInstance {
    /** Refuse anonymous requests. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Refuse requests without a named capability. */
    requirePermission: (
      permission: string,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** 401: we do not know who you are. */
export class NotAuthenticated extends DomainError {
  constructor() {
    super('NOT_AUTHENTICATED', 'Sign in to continue.');
  }
}

/** 403: we know who you are, and you may not do this. */
export class NotPermitted extends DomainError {
  constructor(permission: string) {
    super('NOT_PERMITTED', 'Your role does not allow that action.', { permission });
  }
}

/**
 * Routes that stay reachable while a password change is outstanding.
 * Everything else is refused until the person picks their own password, so a
 * shared seeded credential cannot be used to work in the system indefinitely.
 */
const ALLOWED_WHILE_MUST_CHANGE = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
]);

async function plugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('user', null);

  // Resolve the session on every request. Routes then only consult the guards.
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || token === '') {
      request.user = null;
      return;
    }
    request.user = await resolveSession(app.db, token);
  });

  app.decorate('requireAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.user === null) throw new NotAuthenticated();
    if (request.user.mustChangePassword && !ALLOWED_WHILE_MUST_CHANGE.has(request.routeOptions.url ?? '')) {
      throw new DomainError(
        'PASSWORD_CHANGE_REQUIRED',
        'You must choose a new password before continuing.',
      );
    }
  });

  app.decorate(
    'requirePermission',
    (permission: string) => async (request: FastifyRequest, reply: FastifyReply) => {
      await app.requireAuth(request, reply);
      if (request.user === null || !request.user.permissions.has(permission)) {
        throw new NotPermitted(permission);
      }
    },
  );
}

export const authPlugin = fp(plugin, { name: 'auth' });
