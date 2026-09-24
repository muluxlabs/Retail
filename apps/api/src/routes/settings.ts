/**
 * System settings.
 *
 * A generic key/value store (migration 006), but not exposed as a raw KV
 * editor here - every key this API will act on is described and validated
 * below. A setting whose meaning and shape live only inside a text box is
 * not something an administrator can safely change; unknown keys are
 * refused rather than silently accepted, and the registry is the one place
 * that has to grow when a new operator-adjustable limit is added.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseBody, parseParams } from '../validation.js';

interface SettingDef {
  label: string;
  description: string;
  parse: (raw: string) => { ok: true } | { ok: false; message: string };
}

const SETTINGS: Record<string, SettingDef> = {
  max_active_branches: {
    label: 'Maximum active branches',
    description:
      'How many branches this deployment is licensed for. Raising it is a plan change, not a technical one - the client\'s own framing was that adding branches grows what they should be charged.',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0
        ? { ok: true }
        : { ok: false, message: 'Must be a positive whole number.' };
    },
  },
};

const keyParams = z.object({ key: z.string().trim().min(1).max(100) });
const updateBody = z.object({ value: z.string().trim().min(1).max(500) });

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  /** Every known setting, with its current value and who last touched it. */
  app.get('/settings', { onRequest: [app.requirePermission('settings.manage')] }, async () => {
    const rows = await app.db
      .selectFrom('system_setting')
      .leftJoin('person', 'person.id', 'system_setting.updated_by')
      .select([
        'system_setting.key',
        'system_setting.value',
        'system_setting.updated_at as updatedAt',
        'person.full_name as updatedByName',
      ])
      .orderBy('system_setting.key', 'asc')
      .execute();

    return rows.map((r) => ({
      ...r,
      label: SETTINGS[r.key]?.label ?? r.key,
      description: SETTINGS[r.key]?.description ?? null,
    }));
  });

  app.patch(
    '/settings/:key',
    { onRequest: [app.requirePermission('settings.manage')] },
    async (request, reply) => {
      const { key } = parseParams(keyParams, request.params);
      const body = parseBody(updateBody, request.body);
      const actor = request.user;
      if (actor === null) {
        return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
      }

      const def = SETTINGS[key];
      if (def === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No setting ${key}` } });
      }
      const validity = def.parse(body.value);
      if (!validity.ok) {
        return reply.status(422).send({ error: { code: 'INVALID_VALUE', message: validity.message } });
      }

      const before = await app.db
        .selectFrom('system_setting')
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      if (before === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No setting ${key}` } });
      }

      const updated = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('system_setting')
          .set({ value: body.value, updated_by: actor.personId, updated_at: new Date() })
          .where('key', '=', key)
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(),
            action_code: 'SETTING_CHANGED',
            actor_id: actor.personId,
            terminal_id: null,
            branch_id: null,
            entity_type: 'system_setting',
            entity_id: null,
            state_before: JSON.stringify({ key, value: before.value }),
            state_after: JSON.stringify({ key, value: body.value }),
            occurred_at: new Date(),
          })
          .execute();

        return row;
      });

      return { ...updated, label: def.label, description: def.description };
    },
  );
}
