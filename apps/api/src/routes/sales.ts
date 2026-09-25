/**
 * Sales: check out a basket, read a receipt back, list receipts.
 *
 * The cashier on a sale is the signed-in person, never a value in the request.
 * Everything here is limited to the branches the caller is allowed at.
 */

import { isMoney } from '@retail-ops/domain';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { checkout, getReceipt } from '../services/checkout.js';
import { parseBody, parseParams, parseQuery } from '../validation.js';

const money = z.number().refine(isMoney, 'An amount of money has at most two decimal places.');

const checkoutBody = z.object({
  /** Made by the till before it sends the sale, so a retry is recognised as the same sale. */
  saleId: z.uuid(),
  branchId: z.uuid(),
  cashPointId: z.uuid().nullable().default(null),
  terminalId: z.uuid().nullable().default(null),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        packId: z.uuid(),
        qtyPacks: z.number().positive().max(100_000),
        unitPrice: money.nonnegative().optional(),
        discount: money.nonnegative().optional(),
      }),
    )
    .min(1, 'A sale needs at least one item.')
    .max(200),
  payments: z
    .array(
      z.object({
        paymentTypeId: z.string().trim().min(1).max(32),
        amount: money.positive(),
        tendered: money.positive().optional(),
        reference: z.string().trim().max(100).nullable().optional(),
      }),
    )
    .min(1, 'Say how it was paid.')
    .max(6),
  overrideNegative: z.boolean().default(false),
});

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  branchId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(40).optional(),
  cashierId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function registerSaleRoutes(app: FastifyInstance): Promise<void> {
  /** Check out a basket: many lines, one receipt, one atomic write. */
  app.post('/sales/checkout', { onRequest: [app.requirePermission('movement.post')] }, async (request, reply) => {
    const body = parseBody(checkoutBody, request.body);
    const user = request.user;
    if (user === null) {
      return reply.status(401).send({ error: { code: 'NOT_AUTHENTICATED', message: 'Sign in.' } });
    }
    assertInScope(request, body.branchId);

    // Overriding the negative-stock guard is its own capability, not something a
    // cashier can grant themselves by ticking a box.
    if (body.overrideNegative && !user.permissions.has('stock.override')) {
      return reply.status(403).send({
        error: {
          code: 'NOT_PERMITTED',
          message: 'Overriding negative stock requires manager authorisation.',
          detail: { permission: 'stock.override' },
        },
      });
    }

    const result = await checkout(app.db, {
      saleId: body.saleId,
      branchId: body.branchId,
      cashPointId: body.cashPointId,
      terminalId: body.terminalId,
      cashierId: user.personId,
      lines: body.lines,
      payments: body.payments,
      canOverridePrice: user.permissions.has('price.override'),
      overrideNegative: body.overrideNegative,
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /** Payment methods the till can take. Available to anyone signed in: the till needs them to sell. */
  app.get('/payment-types', { onRequest: [app.requireAuth] }, async () =>
    app.db
      .selectFrom('payment_type')
      .select(['id', 'name', 'is_cash as isCash', 'at_till as atTill', 'for_suppliers as forSuppliers'])
      .where('is_active', '=', true)
      .orderBy('sort_order', 'asc')
      .execute(),
  );

  /** The tills at a branch, so the Sell screen can say which one is taking the cash. */
  app.get('/branches/:id/tills', { onRequest: [app.requirePermission('movement.post')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    assertInScope(request, id);
    return app.db
      .selectFrom('cash_point')
      .select(['id', 'name', 'terminal_id as terminalId'])
      .where('branch_id', '=', id)
      .where('kind', '=', 'till')
      .where('is_active', '=', true)
      .orderBy('name', 'asc')
      .execute();
  });

  /** One receipt. A cashier can reprint what they just sold; anyone with sale.read can read any. */
  app.get('/sales/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const perms = request.user?.permissions;
    if (perms === undefined || (!perms.has('movement.post') && !perms.has('sale.read'))) {
      return reply.status(403).send({
        error: { code: 'NOT_PERMITTED', message: 'Your role does not allow that action.', detail: { permission: 'sale.read' } },
      });
    }

    const sale = await app.db.selectFrom('sale').select(['id', 'branch_id']).where('id', '=', id).executeTakeFirst();
    if (sale === undefined) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No receipt ${id}` } });
    }
    assertInScope(request, sale.branch_id);
    return getReceipt(app.db, id);
  });

  /** Receipts, newest first. */
  app.get('/sales', { onRequest: [app.requirePermission('sale.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const limitTo = scopedBranchIds(request);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);

    let query = app.db
      .selectFrom('sale')
      .innerJoin('branch', 'branch.id', 'sale.branch_id')
      .innerJoin('person', 'person.id', 'sale.cashier_id')
      .select([
        'sale.id',
        'sale.receipt_no as receiptNo',
        'sale.occurred_at as occurredAt',
        'branch.code as branchCode',
        'branch.name as branchName',
        'person.full_name as cashierName',
        'sale.net_total as net',
        'sale.discount_total as discount',
        sql<number>`(select count(*) from sale_line l where l.sale_id = sale.id)`.as('itemCount'),
        sql<string>`(select string_agg(t.name, ' + ' order by t.sort_order) from sale_payment p join payment_type t on t.id = p.payment_type_id where p.sale_id = sale.id)`.as(
          'paidBy',
        ),
      ]);

    if (limitTo !== null) query = query.where('sale.branch_id', 'in', limitTo);
    if (q.branchId !== undefined) query = query.where('sale.branch_id', '=', q.branchId);
    if (q.cashierId !== undefined) query = query.where('sale.cashier_id', '=', q.cashierId);
    if (q.from !== undefined) query = query.where('sale.occurred_at', '>=', q.from);
    if (q.to !== undefined) query = query.where('sale.occurred_at', '<', new Date(q.to.getTime() + 86_400_000));
    if (q.q !== undefined) query = query.where('sale.receipt_no', 'ilike', `%${q.q}%`);

    const items = await query.orderBy('sale.occurred_at', 'desc').limit(q.limit).offset(q.offset).execute();
    return { items, limit: q.limit, offset: q.offset };
  });
}
