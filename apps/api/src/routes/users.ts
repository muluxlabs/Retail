/**
 * Staff accounts.
 *
 * This is "sign up" for a retail back office: an administrator creates the
 * account, assigns role and branch, and hands over a temporary password the
 * person must replace on first sign-in.
 *
 * Two rules from HANDOFF are enforced here rather than left to good intentions:
 *   - one human, one record (§2.6). Creating a user creates or reuses exactly
 *     one `person`, and the login email is unique case-insensitively.
 *   - no hard deletes (§10). Deactivation sets `is_active` false and revokes
 *     live sessions; nothing is removed, so past movements keep their actor.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { revokeAllSessions, writeAuthAudit } from '../services/auth.js';
import { checkPasswordStrength, generateTemporaryPassword, hashPassword } from '@retail-ops/db';
import { parseBody, parseParams } from '../validation.js';

const createUserBody = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.email().max(200),
  phone: z.string().trim().max(40).nullable().default(null),
  roleIds: z.array(z.string().trim().min(1).max(64)).min(1, 'Assign at least one role.'),
  /** Null scopes the roles group-wide. Migration 002 made that expressible. */
  branchId: z.uuid().nullable().default(null),
  /** Omit to have one generated and returned once. */
  password: z.string().min(1).max(200).optional(),
});

const idParams = z.object({ id: z.uuid() });

const accessParams = z.object({ id: z.uuid(), permission: z.string().trim().min(1).max(64) });
const accessBody = z.object({
  /** grant: add beyond the role; revoke: take away what the role gives; role: back to what the role gives. */
  effect: z.enum(['grant', 'revoke', 'role']),
  note: z.string().trim().max(300).nullable().optional(),
});

const updateUserBody = z.object({
  isActive: z.boolean().optional(),
  roleIds: z.array(z.string().trim().min(1).max(64)).optional(),
  branchId: z.uuid().nullable().optional(),
});

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { onRequest: [app.requirePermission('user.read')] }, async () => {
    const people = await app.db
      .selectFrom('person')
      .leftJoin('user_credential', 'user_credential.person_id', 'person.id')
      .select([
        'person.id',
        'person.full_name as fullName',
        'person.phone',
        'person.is_active as isActive',
        'person.created_at as createdAt',
        'user_credential.email as loginEmail',
        'user_credential.last_login_at as lastLoginAt',
        'user_credential.must_change_password as mustChangePassword',
        'user_credential.locked_until as lockedUntil',
      ])
      .orderBy('person.full_name', 'asc')
      .execute();

    const grants = await app.db
      .selectFrom('person_role')
      .leftJoin('branch', 'branch.id', 'person_role.branch_id')
      .select([
        'person_role.person_id as personId',
        'person_role.role_id as roleId',
        'person_role.branch_id as branchId',
        'branch.code as branchCode',
      ])
      .execute();

    const byPerson = new Map<string, typeof grants>();
    for (const g of grants) {
      const list = byPerson.get(g.personId) ?? [];
      list.push(g);
      byPerson.set(g.personId, list);
    }

    const overrides = await app.db
      .selectFrom('person_permission')
      .select(['person_id as personId', 'permission_id as permissionId', 'effect'])
      .execute();
    const overridesOf = new Map<string, { permissionId: string; effect: 'grant' | 'revoke' }[]>();
    for (const o of overrides) overridesOf.set(o.personId, [...(overridesOf.get(o.personId) ?? []), { permissionId: o.permissionId, effect: o.effect }]);

    return people.map((p) => ({
      ...p,
      /** Access set for this person beyond or short of their roles. */
      overrides: overridesOf.get(p.id) ?? [],
      /** No credential row means the person exists but cannot sign in. */
      canSignIn: p.loginEmail !== null,
      roles: (byPerson.get(p.id) ?? []).map((g) => ({
        roleId: g.roleId,
        branchId: g.branchId,
        branchCode: g.branchCode,
      })),
    }));
  });

  app.post('/users', { onRequest: [app.requirePermission('user.manage')] }, async (request, reply) => {
    const body = parseBody(createUserBody, request.body);
    const actor = request.user;
    if (actor === null) return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });

    const email = body.email.trim().toLowerCase();

    const existing = await app.db
      .selectFrom('user_credential')
      .select('person_id')
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
      .executeTakeFirst();

    if (existing !== undefined) {
      return reply.status(409).send({
        error: { code: 'EMAIL_TAKEN', message: 'That email already has an account.' },
      });
    }

    const roles = await app.db
      .selectFrom('role')
      .select('id')
      .where('id', 'in', body.roleIds)
      .execute();
    if (roles.length !== body.roleIds.length) {
      return reply.status(422).send({
        error: { code: 'UNKNOWN_ROLE', message: 'One or more roles do not exist.' },
      });
    }

    // A generated password is returned exactly once, in this response. It is
    // never stored in plaintext and cannot be retrieved again.
    const password = body.password ?? generateTemporaryPassword();
    if (body.password !== undefined) {
      const strength = checkPasswordStrength(body.password, email);
      if (!strength.ok) {
        return reply.status(422).send({ error: { code: 'PASSWORD_TOO_WEAK', message: strength.reason } });
      }
    }
    const passwordHash = await hashPassword(password);

    const created = await app.db.transaction().execute(async (tx) => {
      const person = await tx
        .insertInto('person')
        .values({
          full_name: body.fullName,
          email,
          phone: body.phone,
          national_id_ref: null,
        })
        .returning(['id', 'full_name'])
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('user_credential')
        .values({
          person_id: person.id,
          email,
          password_hash: passwordHash,
          must_change_password: true,
        })
        .execute();

      for (const roleId of body.roleIds) {
        await tx
          .insertInto('person_role')
          .values({ person_id: person.id, role_id: roleId, branch_id: body.branchId })
          .execute();
      }

      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: 'USER_CREATED',
          actor_id: actor.personId,
          terminal_id: null,
          branch_id: body.branchId,
          entity_type: 'person',
          entity_id: person.id,
          state_before: null,
          state_after: JSON.stringify({ email, roles: body.roleIds, branchId: body.branchId }),
          occurred_at: new Date(),
        })
        .execute();

      return person;
    });

    return reply.status(201).send({
      id: created.id,
      fullName: created.full_name,
      email,
      roles: body.roleIds,
      branchId: body.branchId,
      /** Shown once so the administrator can pass it on. Not recoverable. */
      temporaryPassword: body.password === undefined ? password : undefined,
      mustChangePassword: true,
    });
  });

  app.patch('/users/:id', { onRequest: [app.requirePermission('user.manage')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = parseBody(updateUserBody, request.body);
    const actor = request.user;
    if (actor === null) return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });

    const person = await app.db
      .selectFrom('person')
      .select(['id', 'is_active as isActive', 'full_name as fullName'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (person === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No user ${id}` } });
    }

    // An administrator locking themselves out is a support call, so refuse it.
    if (body.isActive === false && person.id === actor.personId) {
      return reply.status(409).send({
        error: { code: 'CANNOT_DEACTIVATE_SELF', message: 'You cannot deactivate your own account.' },
      });
    }

    await app.db.transaction().execute(async (tx) => {
      if (body.isActive !== undefined) {
        await tx.updateTable('person').set({ is_active: body.isActive }).where('id', '=', id).execute();
      }
      if (body.roleIds !== undefined) {
        // Role grants are configuration, not history; the audit_log row below
        // is what preserves the change.
        await tx.deleteFrom('person_role').where('person_id', '=', id).execute();
        for (const roleId of body.roleIds) {
          await tx
            .insertInto('person_role')
            .values({ person_id: id, role_id: roleId, branch_id: body.branchId ?? null })
            .execute();
        }
      }
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: 'USER_UPDATED',
          actor_id: actor.personId,
          terminal_id: null,
          branch_id: null,
          entity_type: 'person',
          entity_id: id,
          state_before: JSON.stringify({ isActive: person.isActive }),
          state_after: JSON.stringify(body),
          occurred_at: new Date(),
        })
        .execute();
    });

    // Deactivation must take effect now, not when the session happens to expire.
    if (body.isActive === false) {
      await revokeAllSessions(app.db, id, 'account deactivated');
    }

    return { ok: true };
  });

  /** Issue a new temporary password. Returned once, forces a change on use. */
  app.post(
    '/users/:id/reset-password',
    { onRequest: [app.requirePermission('user.manage')] },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const actor = request.user;
      if (actor === null) return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });

      const credential = await app.db
        .selectFrom('user_credential')
        .select('person_id')
        .where('person_id', '=', id)
        .executeTakeFirst();

      if (credential === undefined) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'That person has no sign-in credential.' },
        });
      }

      const password = generateTemporaryPassword();
      await app.db
        .updateTable('user_credential')
        .set({
          password_hash: await hashPassword(password),
          must_change_password: true,
          failed_attempts: 0,
          locked_until: null,
          updated_at: new Date(),
        })
        .where('person_id', '=', id)
        .execute();

      await revokeAllSessions(app.db, id, 'password reset by administrator');
      await writeAuthAudit(app.db, actor.personId, 'USER_PASSWORD_RESET', { targetPersonId: id }, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { temporaryPassword: password, mustChangePassword: true };
    },
  );

  /** One person's access: every permission, whether their roles give it, and anything set for them. */
  app.get('/users/:id/access', { onRequest: [app.requirePermission('user.read')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const person = await app.db.selectFrom('person').select(['id', 'full_name as fullName']).where('id', '=', id).executeTakeFirst();
    if (person === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No user ${id}` } });
    const [all, fromRoles, roles, overrides] = await Promise.all([
      app.db.selectFrom('permission').select(['id', 'description']).orderBy('id').execute(),
      app.db
        .selectFrom('person_role')
        .innerJoin('role_permission', 'role_permission.role_id', 'person_role.role_id')
        .select(['role_permission.permission_id as permissionId', 'person_role.role_id as roleId'])
        .where('person_role.person_id', '=', id)
        .execute(),
      app.db
        .selectFrom('person_role')
        .leftJoin('branch', 'branch.id', 'person_role.branch_id')
        .select(['person_role.role_id as roleId', 'branch.name as branchName'])
        .where('person_role.person_id', '=', id)
        .execute(),
      app.db
        .selectFrom('person_permission')
        .innerJoin('person', 'person.id', 'person_permission.set_by')
        .select(['person_permission.permission_id as permissionId', 'person_permission.effect', 'person_permission.note', 'person_permission.set_at as setAt', 'person.full_name as setByName'])
        .where('person_permission.person_id', '=', id)
        .execute(),
    ]);
    const viaRoles = new Map<string, string[]>();
    for (const r of fromRoles) viaRoles.set(r.permissionId, [...(viaRoles.get(r.permissionId) ?? []), r.roleId]);
    const override = new Map(overrides.map((o) => [o.permissionId, o]));
    return {
      person,
      roles,
      permissions: all.map((p) => {
        const o = override.get(p.id);
        const fromRole = viaRoles.has(p.id);
        return {
          id: p.id,
          description: p.description,
          fromRoles: viaRoles.get(p.id) ?? [],
          override: o === undefined ? null : { effect: o.effect, note: o.note, setAt: o.setAt, setByName: o.setByName },
          effective: o === undefined ? fromRole : o.effect === 'grant',
        };
      }),
    };
  });

  /**
   * Add a permission for one person, take one away, or put it back to what their role gives.
   * Nobody changes their own access, and nobody gives access they do not hold.
   */
  app.put('/users/:id/access/:permission', { onRequest: [app.requirePermission('user.manage')] }, async (request, reply) => {
    const { id, permission } = parseParams(accessParams, request.params);
    const body = parseBody(accessBody, request.body);
    const actor = request.user!;
    if (id === actor.personId) {
      return reply.status(409).send({ error: { code: 'CANNOT_CHANGE_OWN_ACCESS', message: 'You cannot change your own access: ask another administrator.' } });
    }
    const [person, perm] = await Promise.all([
      app.db.selectFrom('person').select(['id', 'full_name as fullName']).where('id', '=', id).executeTakeFirst(),
      app.db.selectFrom('permission').select(['id', 'description']).where('id', '=', permission).executeTakeFirst(),
    ]);
    if (person === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No user ${id}` } });
    if (perm === undefined) return reply.status(422).send({ error: { code: 'UNKNOWN_PERMISSION', message: `There is no permission ${permission}.` } });
    if (body.effect === 'grant' && !actor.permissions.has(permission)) {
      return reply.status(403).send({ error: { code: 'NOT_PERMITTED', message: 'You cannot give access you do not have yourself.' } });
    }

    const fromRole = await app.db
      .selectFrom('person_role')
      .innerJoin('role_permission', 'role_permission.role_id', 'person_role.role_id')
      .select('role_permission.permission_id')
      .where('person_role.person_id', '=', id)
      .where('role_permission.permission_id', '=', permission)
      .executeTakeFirst();
    // Adding what the role already gives, or removing what it does not, is just "as the role".
    const effect = body.effect === 'grant' && fromRole !== undefined ? 'role' : body.effect === 'revoke' && fromRole === undefined ? 'role' : body.effect;

    await app.db.transaction().execute(async (tx) => {
      const before = await tx
        .selectFrom('person_permission')
        .select(['effect', 'note'])
        .where('person_id', '=', id)
        .where('permission_id', '=', permission)
        .executeTakeFirst();
      await tx.deleteFrom('person_permission').where('person_id', '=', id).where('permission_id', '=', permission).execute();
      if (effect !== 'role') {
        await tx
          .insertInto('person_permission')
          .values({ person_id: id, permission_id: permission, effect, note: body.note ?? null, set_by: actor.personId, set_at: new Date() })
          .execute();
      }
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(),
          action_code: effect === 'grant' ? 'ACCESS_GRANTED' : effect === 'revoke' ? 'ACCESS_REVOKED' : 'ACCESS_RESET',
          actor_id: actor.personId,
          terminal_id: null,
          branch_id: null,
          entity_type: 'person',
          entity_id: id,
          state_before: JSON.stringify({ permission, access: before?.effect ?? 'role' }),
          state_after: JSON.stringify({ permission, access: effect, note: body.note ?? null }),
          occurred_at: new Date(),
        })
        .execute();
      // Access beyond a role is raised for review, against the person's branch (else the first branch).
      if (effect === 'grant' && before?.effect !== 'grant') {
        const branch =
          (await tx.selectFrom('person_role').select('branch_id').where('person_id', '=', id).where('branch_id', 'is not', null).executeTakeFirst())?.branch_id ??
          (await tx.selectFrom('branch').select('id').where('is_active', '=', true).orderBy('code').executeTakeFirstOrThrow()).id;
        await tx
          .insertInto('exception_event')
          .values({
            event_id: crypto.randomUUID(),
            kind: 'access_granted',
            branch_id: branch,
            terminal_id: null,
            actor_id: actor.personId,
            product_id: null,
            detail: JSON.stringify({ personId: id, person: person.fullName, permission, description: perm.description, note: body.note ?? null }),
            value_impact: null,
            currency: null,
            occurred_at: new Date(),
          })
          .execute();
      }
    });
    return { permission, access: effect };
  });

  app.get('/permissions', { onRequest: [app.requirePermission('user.read')] }, async () => {
    const [permissions, rolePermissions] = await Promise.all([
      app.db.selectFrom('permission').select(['id', 'description']).orderBy('id').execute(),
      app.db
        .selectFrom('role_permission')
        .select(['role_id as roleId', 'permission_id as permissionId'])
        .execute(),
    ]);
    return { permissions, rolePermissions };
  });
}
