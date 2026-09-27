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

const text = (label: string, max: number): SettingDef['parse'] => (raw) =>
  raw.length <= max ? { ok: true } : { ok: false, message: `${label} can be at most ${max} characters.` };

SETTINGS['business_name'] = {
  label: 'Business name',
  description: 'Printed at the top of every receipt.',
  parse: (raw) => (raw.length >= 1 && raw.length <= 80 ? { ok: true } : { ok: false, message: 'Give the business a name (up to 80 characters).' }),
};
SETTINGS['business_address'] = {
  label: 'Business address',
  description: 'Printed under the name on receipts. Leave blank to print nothing.',
  parse: text('The address', 160),
};
SETTINGS['business_phone'] = {
  label: 'Business phone',
  description: 'Printed on receipts. Leave blank to print nothing.',
  parse: text('The phone number', 40),
};
SETTINGS['business_tin'] = {
  label: 'Tax identification number',
  description: 'Your TIN / VAT registration number, printed on receipts. Leave blank if not registered.',
  parse: text('The number', 40),
};
SETTINGS['receipt_footer'] = {
  label: 'Receipt footer',
  description: 'A line printed at the bottom of every receipt, such as a thank-you or a returns policy.',
  parse: text('The footer', 200),
};
SETTINGS['receipt_width_mm'] = {
  label: 'Receipt paper width (mm)',
  description: 'The width of the roll in your receipt printer: 58 or 80.',
  parse: (raw) => (raw === '58' || raw === '80' ? { ok: true } : { ok: false, message: 'Paper width must be 58 or 80.' }),
};

SETTINGS['business_timezone'] = {
  label: 'Business time zone',
  description:
    'The time zone the shop trades in, e.g. Africa/Harare. "Today", the hour of a sale and each day in the sales reports follow it, so a late-night sale lands on the day the shop thinks it does.',
  parse: (raw) => {
    if (!/^(UTC|[A-Za-z]+(\/[A-Za-z_+-]+)+)$/.test(raw)) return { ok: false, message: 'Use an IANA time zone name such as Africa/Harare.' };
    try {
      new Intl.DateTimeFormat('en', { timeZone: raw });
      return { ok: true };
    } catch {
      return { ok: false, message: 'That is not a known time zone. Try Africa/Harare.' };
    }
  },
};

SETTINGS['shifts_required'] = {
  label: 'Tills need an open shift to sell',
  description:
    'yes: a cashier must open a shift on the till (counting the float) before selling, and end of day waits until every shift at the branch is closed. no: shifts are optional.',
  parse: (raw) => (raw === 'yes' || raw === 'no' ? { ok: true } : { ok: false, message: 'Answer yes or no.' }),
};

SETTINGS['loyalty_enabled'] = {
  label: 'Loyalty points',
  description: 'yes: named customers earn points on what they pay for, and can spend them at the till. no: nothing is earned, and points cannot be spent.',
  parse: (raw) => (raw === 'yes' || raw === 'no' ? { ok: true } : { ok: false, message: 'Answer yes or no.' }),
};
SETTINGS['loyalty_points_per_dollar'] = {
  label: 'Points earned per dollar',
  description: 'Points a customer earns for each whole dollar paid (not counting what they paid with points). 1 = a point per dollar; 0.5 = a point every $2. Rounded down.',
  parse: (raw) =>
    /^\d{1,3}(\.\d{1,2})?$/.test(raw) && Number(raw) > 0
      ? { ok: true }
      : { ok: false, message: 'A number above zero, up to two decimal places (e.g. 1 or 0.5).' },
};
SETTINGS['loyalty_point_value'] = {
  label: 'Value of one point ($)',
  description: 'What one point is worth when a customer spends it at the till, in whole cents: 0.01 = a point is worth one cent, so 100 points pay $1.00.',
  parse: (raw) =>
    /^\d{1,3}(\.\d{1,2})?$/.test(raw) && Number(raw) >= 0.01
      ? { ok: true }
      : { ok: false, message: 'An amount of at least 0.01, in whole cents.' },
};

const keyParams = z.object({ key: z.string().trim().min(1).max(100) });
const updateBody = z.object({ value: z.string().trim().max(500) });

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
