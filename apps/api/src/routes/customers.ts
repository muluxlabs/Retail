/**
 * Customers on credit: the customer list, a customer's account, aged debtors,
 * a lookup for the till, and receiving money from customers.
 */

import { isMoney, InvalidCustomer } from '@retail-ops/domain';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { customerAccount, noteLimitChange, receivePayment, voidCustomerPayment } from '../services/customers.js';
import { adjustPoints, customerPoints, loyaltyRules } from '../services/loyalty.js';
import { businessTimezone, dayIn } from '../services/purchasing.js';
import { parseBody, parseParams, parseQuery, queryBool } from '../validation.js';

const money = z.number().min(0).max(100_000_000).refine(isMoney, 'An amount has at most two decimal places.');
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.union([z.literal('').transform(() => null), text(max)]).nullable().optional();

const customerBody = z.object({
  name: text(120).min(2, 'Give the customer a name.'),
  phone: optText(40),
  email: optText(120),
  address: optText(300),
  idNumber: optText(40),
  creditLimit: money.default(0),
  creditDays: z.number().int().min(0).max(365).default(30),
  notes: optText(500),
});
const customerPatch = customerBody.partial().extend({ isActive: z.boolean().optional() });
const listQuery = z.object({
  q: text(60).min(1).optional(),
  includeInactive: queryBool,
  owingOnly: queryBool,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
const lookupQuery = z.object({ q: text(60).min(1) });
const payBody = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  branchId: z.uuid(),
  amount: money.refine((n) => n > 0, 'A payment must be more than zero.'),
  paymentTypeId: z.string().trim().min(1).max(32),
  reference: optText(100),
  cashPointId: z.uuid().nullable().optional(),
  note: optText(500),
});
const reasonBody = z.object({ reason: text(300).min(5, 'Say why, in a few words.') });
const enrolBody = z.object({
  name: text(120).min(2, 'Give the customer a name.'),
  phone: text(40).min(5, 'A phone number identifies the customer at the till.'),
});
const adjustBody = z.object({
  id: z.uuid(),
  points: z.number().int().refine((p) => p !== 0, 'Give a number of points other than zero.').refine((p) => Math.abs(p) <= 10_000_000, 'That is too many points.'),
  note: text(300).min(5, 'Say why the points are being changed.'),
});
const idParams = z.object({ id: z.uuid() });
const branchQuery = z.object({ branchId: z.uuid() });

const n = (v: unknown): number => Number(v ?? 0);
const r2 = (v: unknown): number => Math.round(n(v) * 100) / 100;

export async function registerCustomerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/customers', { onRequest: [app.requirePermission('customer.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const like = q.q === undefined ? null : `%${q.q}%`;
    const rows = await sql<Record<string, unknown>>`
      SELECT c.id, c.code, c.name, c.phone, c.email, c.credit_limit AS "creditLimit", c.credit_days AS "creditDays", c.is_active AS "isActive",
             b.charged, b.paid, b.balance,
             (SELECT max(s.occurred_at) FROM sale s WHERE s.customer_id = c.id) AS "lastSale"
      FROM customer c JOIN customer_balance b ON b.customer_id = c.id
      WHERE (${q.includeInactive} OR c.is_active)
        AND (NOT ${q.owingOnly} OR b.balance > 0)
        AND (${like}::text IS NULL OR c.name ILIKE ${like} OR c.code ILIKE ${like} OR c.phone ILIKE ${like})
      ORDER BY c.name LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    return {
      items: rows.rows.map((r) => ({
        ...r, creditLimit: r2(r['creditLimit']), creditDays: n(r['creditDays']), charged: r2(r['charged']), paid: r2(r['paid']), balance: r2(r['balance']),
        available: Math.max(0, r2(n(r['creditLimit']) - n(r['balance']))),
      })),
    };
  });

  /** For the till: find a customer to name on a sale, with how much credit they have left. */
  app.get('/customers/lookup', { onRequest: [app.requirePermission('movement.post')] }, async (request) => {
    const q = parseQuery(lookupQuery, request.query);
    const like = `%${q.q}%`;
    const rows = await sql<Record<string, unknown>>`
      SELECT c.id, c.code, c.name, c.phone, c.credit_limit AS "creditLimit", b.balance, l.points
      FROM customer c JOIN customer_balance b ON b.customer_id = c.id JOIN loyalty_balance l ON l.customer_id = c.id
      WHERE c.is_active AND (c.name ILIKE ${like} OR c.code ILIKE ${like} OR c.phone ILIKE ${like})
      ORDER BY c.name LIMIT 10`.execute(app.db);
    return {
      items: rows.rows.map((r) => ({
        id: r['id'], code: r['code'], name: r['name'], phone: r['phone'],
        creditLimit: r2(r['creditLimit']), balance: r2(r['balance']), available: Math.max(0, r2(n(r['creditLimit']) - n(r['balance']))),
        points: n(r['points']),
      })),
    };
  });

  /** What the till needs to know about points: on or off, the rate, and what one is worth. */
  app.get('/loyalty/rules', { onRequest: [app.requireAuth] }, async () => {
    const r = await loyaltyRules(app.db);
    return { enabled: r.enabled, pointsPerDollar: r.pointsPerDollar, pointValue: r.pointValueCents / 100 };
  });

  /** Sign up a customer at the till: a name and a phone number, no credit. */
  app.post('/customers/enrol', { onRequest: [app.requirePermission('customer.enrol')] }, async (request, reply) => {
    const b = parseBody(enrolBody, request.body);
    const dup = await app.db.selectFrom('customer').select(['id', 'code', 'name']).where('phone', '=', b.phone).executeTakeFirst();
    if (dup !== undefined) return reply.status(409).send({ error: { code: 'CUSTOMER_EXISTS', message: `${dup.name} already has the phone number ${b.phone}.`, detail: { id: dup.id, code: dup.code, name: dup.name } } });
    const row = await app.db
      .insertInto('customer')
      .values({ name: b.name, phone: b.phone, email: null, address: null, id_number: null, credit_limit: 0, credit_days: 30, notes: null, created_by: request.user!.personId })
      .returning(['id', 'code', 'name', 'phone'])
      .executeTakeFirstOrThrow();
    return reply.status(201).send({ ...row, creditLimit: 0, balance: 0, available: 0, points: 0 });
  });

  app.get('/customers/:id/loyalty', { onRequest: [app.requirePermission('customer.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const c = await app.db.selectFrom('customer').select('id').where('id', '=', id).executeTakeFirst();
    if (c === undefined) throw new InvalidCustomer('No such customer.');
    return customerPoints(app.db, id);
  });

  app.post('/customers/:id/loyalty', { onRequest: [app.requirePermission('loyalty.adjust')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const b = parseBody(adjustBody, request.body);
    // Raised against the manager's branch; else where the customer usually buys; else the first branch.
    const branchId =
      request.user!.branchIds[0] ??
      (await app.db.selectFrom('sale').select('branch_id').where('customer_id', '=', id).orderBy('occurred_at', 'desc').executeTakeFirst())?.branch_id ??
      (await app.db.selectFrom('branch').select('id').where('is_active', '=', true).orderBy('code').executeTakeFirstOrThrow()).id;
    const r = await adjustPoints(app.db, { eventId: b.id, customerId: id, points: b.points, note: b.note, actorId: request.user!.personId, branchId });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/customers', { onRequest: [app.requirePermission('customer.write')] }, async (request, reply) => {
    const b = parseBody(customerBody, request.body);
    if (b.phone !== undefined && b.phone !== null) {
      const dup = await app.db.selectFrom('customer').select(['name']).where('phone', '=', b.phone).executeTakeFirst();
      if (dup !== undefined) return reply.status(409).send({ error: { code: 'CUSTOMER_EXISTS', message: `${dup.name} already has the phone number ${b.phone}.` } });
    }
    const row = await app.db
      .insertInto('customer')
      .values({
        name: b.name, phone: b.phone ?? null, email: b.email ?? null, address: b.address ?? null, id_number: b.idNumber ?? null,
        credit_limit: b.creditLimit, credit_days: b.creditDays, notes: b.notes ?? null, created_by: request.user!.personId,
      })
      .returning(['id', 'code', 'name'])
      .executeTakeFirstOrThrow();
    if (b.creditLimit > 0) await noteLimitChange(app.db, row.id, row.name, request.user!.personId, 0, b.creditLimit, request.user!.branchIds[0] ?? null);
    return reply.status(201).send(row);
  });

  app.patch('/customers/:id', { onRequest: [app.requirePermission('customer.write')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const b = parseBody(customerPatch, request.body);
    const before = await app.db.selectFrom('customer').selectAll().where('id', '=', id).executeTakeFirst();
    if (before === undefined) throw new InvalidCustomer('No such customer.');
    if (b.phone !== undefined && b.phone !== null && b.phone !== before.phone) {
      const dup = await app.db.selectFrom('customer').select(['name']).where('phone', '=', b.phone).where('id', '!=', id).executeTakeFirst();
      if (dup !== undefined) return reply.status(409).send({ error: { code: 'CUSTOMER_EXISTS', message: `${dup.name} already has the phone number ${b.phone}.` } });
    }
    await app.db
      .updateTable('customer')
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(b.address !== undefined ? { address: b.address } : {}),
        ...(b.idNumber !== undefined ? { id_number: b.idNumber } : {}),
        ...(b.creditLimit !== undefined ? { credit_limit: b.creditLimit } : {}),
        ...(b.creditDays !== undefined ? { credit_days: b.creditDays } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
        ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (b.creditLimit !== undefined && b.creditLimit !== n(before.credit_limit)) {
      await noteLimitChange(app.db, id, b.name ?? before.name, request.user!.personId, n(before.credit_limit), b.creditLimit, request.user!.branchIds[0] ?? null);
    }
    return { ok: true };
  });

  app.get('/customers/:id', { onRequest: [app.requirePermission('customer.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const c = await app.db.selectFrom('customer').selectAll().where('id', '=', id).executeTakeFirst();
    if (c === undefined) throw new InvalidCustomer('No such customer.');
    const account = await customerAccount(app.db, id);
    return {
      customer: {
        id: c.id, code: c.code, name: c.name, phone: c.phone, email: c.email, address: c.address, idNumber: c.id_number,
        creditLimit: r2(c.credit_limit), creditDays: n(c.credit_days), notes: c.notes, isActive: c.is_active,
      },
      available: Math.max(0, r2(n(c.credit_limit) - account.balance)),
      account,
    };
  });

  /** Aged debtors: what every customer owes, and how late. */
  app.get('/debtors', { onRequest: [app.requirePermission('customer.read')] }, async () => {
    const owing = await app.db.selectFrom('customer').innerJoin('customer_balance', 'customer_balance.customer_id', 'customer.id')
      .select(['customer.id', 'customer.code', 'customer.name', 'customer.phone', 'customer.credit_limit as creditLimit'])
      .where('customer_balance.balance', '!=', 0).orderBy('customer.name').execute();
    const totals = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0, credit: 0 };
    const rows = [];
    for (const c of owing) {
      const a = await customerAccount(app.db, c.id);
      for (const k of ['notDue', 'd1_30', 'd31_60', 'd61_90', 'over90'] as const) totals[k] += a.ageing.buckets[k];
      totals.total += a.ageing.total;
      totals.credit += a.ageing.credit;
      const b = a.ageing.buckets;
      rows.push({
        customerId: c.id, code: c.code, name: c.name, phone: c.phone, creditLimit: r2(c.creditLimit),
        owed: a.ageing.total, credit: a.ageing.credit, buckets: b, overdue: r2(b.d1_30 + b.d31_60 + b.d61_90 + b.over90),
        oldestOverdueDays: a.ageing.items.reduce((m, i) => Math.max(m, i.daysOverdue), 0),
      });
    }
    return {
      asOf: dayIn(await businessTimezone(app.db), new Date()),
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      customers: rows.sort((a, b) => b.owed - a.owed),
    };
  });

  /** Where money received can be put at a branch (its tills and safe). */
  app.get('/customer-payments/cash-points', { onRequest: [app.requirePermission('customer.receive')] }, async (request) => {
    const q = parseQuery(branchQuery, request.query);
    assertInScope(request, q.branchId);
    return {
      items: await app.db.selectFrom('cash_point').select(['id', 'name', 'kind']).where('branch_id', '=', q.branchId).where('is_active', '=', true).orderBy('kind').orderBy('name').execute(),
    };
  });

  app.post('/customer-payments', { onRequest: [app.requirePermission('customer.receive')] }, async (request, reply) => {
    const b = parseBody(payBody, request.body);
    assertInScope(request, b.branchId);
    const r = await receivePayment(app.db, { ...b, reference: b.reference ?? null, note: b.note ?? null, recordedBy: request.user!.personId });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/customer-payments/:id/void', { onRequest: [app.requirePermission('customer.write')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const { reason } = parseBody(reasonBody, request.body);
    const p = await app.db.selectFrom('customer_payment').select('branch_id').where('id', '=', id).executeTakeFirst();
    if (p === undefined) throw new InvalidCustomer('No such payment.');
    if (scopedBranchIds(request) !== null) assertInScope(request, p.branch_id);
    await voidCustomerPayment(app.db, id, request.user!.personId, reason);
    return { ok: true };
  });
}
