/**
 * Customers on credit: their accounts, and money received from them.
 *
 * What a customer owes is never stored: it is sales charged to their account
 * (the "on account" part of a receipt) less payments received and not voided.
 * A payment is one numbered document; cash taken goes into a named till or
 * safe in the same transaction, so that point's expected cash is right at the
 * next count. A payment made in error is voided, and the cash comes back out.
 */

import { ageDeliveries, fromCents, InvalidCustomer, runStatement, toCents } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { post as postCash } from './cash.js';
import { businessTimezone, dayIn } from './purchasing.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const dueDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function groupNumber(tx: Tx, kind: string): Promise<string> {
  const r = await sql<{ lastNo: number }>`
    INSERT INTO group_counter (doc_kind, last_no) VALUES (${kind}, 1)
    ON CONFLICT (doc_kind) DO UPDATE SET last_no = group_counter.last_no + 1
    RETURNING last_no AS "lastNo"`.execute(tx);
  return `${kind}-${String(Number(r.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;
}

async function audit(tx: Tx | Db, action: string, actorId: string, branchId: string | null, entityType: string, entityId: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null) {
  await tx
    .insertInto('audit_log')
    .values({
      event_id: crypto.randomUUID(),
      action_code: action,
      actor_id: actorId,
      terminal_id: null,
      branch_id: branchId,
      entity_type: entityType,
      entity_id: entityId,
      state_before: before === null ? null : JSON.stringify(before),
      state_after: JSON.stringify(after),
      occurred_at: new Date(),
    })
    .execute();
}

// -- the account ------------------------------------------------------------------------------------

export interface CustomerAccount {
  balance: number;
  charged: number;
  paid: number;
  ageing: {
    buckets: { notDue: number; d1_30: number; d31_60: number; d61_90: number; over90: number };
    total: number;
    credit: number;
    items: { saleId: string; receiptNo: string; day: string; dueDay: string; amount: number; outstanding: number; daysOverdue: number }[];
  };
  statement: { at: string; kind: 'sale' | 'payment' | 'void'; ref: string; description: string; id: string; debit: number; credit: number; balance: number }[];
}

export async function customerAccount(db: Db, customerId: string, asOf: Date = new Date()): Promise<CustomerAccount> {
  const tz = await businessTimezone(db);
  const c = await db.selectFrom('customer').select(['credit_days']).where('id', '=', customerId).executeTakeFirst();
  if (c === undefined) throw new InvalidCustomer('No such customer.');

  const sales = await sql<{ id: string; receiptNo: string; at: Date; charged: number; branch: string }>`
    SELECT s.id, s.receipt_no AS "receiptNo", s.occurred_at AS at, sum(p.amount) AS charged, b.name AS branch
    FROM sale s JOIN sale_payment p ON p.sale_id = s.id AND p.payment_type_id = 'account' JOIN branch b ON b.id = s.branch_id
    WHERE s.customer_id = ${customerId}::uuid GROUP BY s.id, s.receipt_no, s.occurred_at, b.name ORDER BY s.occurred_at`.execute(db);
  const pays = await sql<{ id: string; receiptNo: string; at: Date; amount: number; method: string; reference: string | null; voidedAt: Date | null; voidReason: string | null }>`
    SELECT p.id, p.receipt_no AS "receiptNo", p.received_at AS at, p.amount, t.name AS method, p.reference, p.voided_at AS "voidedAt", p.void_reason AS "voidReason"
    FROM customer_payment p JOIN payment_type t ON t.id = p.payment_type_id
    WHERE p.customer_id = ${customerId}::uuid ORDER BY p.received_at`.execute(db);

  const entries = [
    ...sales.rows.map((s) => ({
      at: iso(s.at), kind: 'sale' as const, id: s.id, ref: s.receiptNo,
      description: `Sale on account at ${s.branch}`, debitCents: toCents(Number(s.charged)), creditCents: 0,
    })),
    ...pays.rows.map((p) => ({
      at: iso(p.at), kind: 'payment' as const, id: p.id, ref: p.receiptNo,
      description: `Payment by ${p.method}${p.reference === null ? '' : ` · ${p.reference}`}`, debitCents: 0, creditCents: toCents(Number(p.amount)),
    })),
    ...pays.rows.filter((p) => p.voidedAt !== null).map((p) => ({
      at: iso(p.voidedAt as Date), kind: 'void' as const, id: p.id, ref: p.receiptNo,
      description: `Payment voided${p.voidReason === null ? '' : ` · ${p.voidReason}`}`, debitCents: toCents(Number(p.amount)), creditCents: 0,
    })),
  ];
  // The domain statement speaks of suppliers' kinds; map ours onto it and back.
  const kindMap = { sale: 'received', payment: 'payment', void: 'void' } as const;
  const run = runStatement(entries.map((e) => ({ ...e, kind: kindMap[e.kind], ourKind: e.kind })));
  const charged = entries.reduce((s, e) => s + (e.kind === 'sale' ? e.debitCents : 0), 0);
  const paid = entries.reduce((s, e) => s + (e.kind === 'payment' ? e.creditCents : e.kind === 'void' ? -e.debitCents : 0), 0);

  const ageing = ageDeliveries(
    sales.rows.map((s) => {
      const day = dayIn(tz, s.at);
      return { id: s.id, day, cents: toCents(Number(s.charged)), dueDay: dueDay(day, Number(c.credit_days)) };
    }),
    paid,
    dayIn(tz, asOf),
  );
  const receiptOf = new Map(sales.rows.map((s) => [s.id, s.receiptNo]));
  return {
    balance: fromCents(charged - paid),
    charged: fromCents(charged),
    paid: fromCents(paid),
    ageing: {
      buckets: {
        notDue: fromCents(ageing.buckets.notDue), d1_30: fromCents(ageing.buckets.d1_30), d31_60: fromCents(ageing.buckets.d31_60),
        d61_90: fromCents(ageing.buckets.d61_90), over90: fromCents(ageing.buckets.over90),
      },
      total: fromCents(ageing.totalCents),
      credit: fromCents(ageing.creditCents),
      items: ageing.items.map((i) => ({
        saleId: i.id, receiptNo: receiptOf.get(i.id) ?? '', day: i.day, dueDay: i.dueDay,
        amount: fromCents(i.cents), outstanding: fromCents(i.outstandingCents), daysOverdue: i.daysOverdue,
      })),
    },
    statement: run.map((e) => ({
      at: e.at, kind: e.ourKind, ref: e.ref, description: e.description, id: e.id,
      debit: fromCents(e.debitCents), credit: fromCents(e.creditCents), balance: fromCents(e.balanceCents),
    })),
  };
}

// -- credit limits ------------------------------------------------------------------------------------

/** Record a credit limit change; raising one is a control point an auditor reviews. */
export async function noteLimitChange(db: Db, customerId: string, name: string, by: string, from: number, to: number, actorBranchId: string | null): Promise<void> {
  await audit(db, 'CREDIT_LIMIT_CHANGED', by, null, 'customer', customerId, { creditLimit: to }, { creditLimit: from });
  if (to > from) {
    await db
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'credit_limit_change',
        // The raising manager's branch; else where the customer usually buys; else the first branch.
        branch_id:
          actorBranchId ??
          (await db.selectFrom('sale').select('branch_id').where('customer_id', '=', customerId).orderBy('occurred_at', 'desc').executeTakeFirst())?.branch_id ??
          (await db.selectFrom('branch').select('id').where('is_active', '=', true).orderBy('code').executeTakeFirstOrThrow()).id,
        terminal_id: null,
        actor_id: by,
        product_id: null,
        detail: JSON.stringify({ customerId, customer: name, from, to }),
        value_impact: to - from,
        currency: 'USD',
        occurred_at: new Date(),
      })
      .execute();
  }
}

// -- money received ---------------------------------------------------------------------------------------

export interface ReceiveInput {
  id: string;
  customerId: string;
  branchId: string;
  amount: number;
  paymentTypeId: string;
  reference?: string | null | undefined;
  cashPointId?: string | null | undefined;
  note?: string | null | undefined;
  recordedBy: string;
}

export async function receivePayment(db: Db, input: ReceiveInput): Promise<{ id: string; receiptNo: string; replayed: boolean }> {
  const done = await db.selectFrom('customer_payment').select(['id', 'receipt_no']).where('id', '=', input.id).executeTakeFirst();
  if (done !== undefined) return { id: done.id, receiptNo: done.receipt_no, replayed: true };
  try {
    const r = await db.transaction().execute(async (tx) => {
      const customer = await tx.selectFrom('customer').select(['id', 'name']).where('id', '=', input.customerId).executeTakeFirst();
      if (customer === undefined) throw new InvalidCustomer('No such customer.');
      if (input.paymentTypeId === 'account') throw new InvalidCustomer('A payment onto an account cannot itself be "on account".');
      const method = await tx.selectFrom('payment_type').select(['id', 'name', 'is_cash', 'is_active', 'at_till']).where('id', '=', input.paymentTypeId).executeTakeFirst();
      if (method === undefined || !method.is_active) throw new InvalidCustomer('Choose how the customer paid.');
      if (!method.is_cash && (input.reference ?? '').trim() === '') {
        throw new InvalidCustomer(`Enter the ${method.name.toLowerCase()} reference so the payment can be traced.`);
      }
      const cents = toCents(input.amount);
      if (!(cents > 0)) throw new InvalidCustomer('A payment must be more than zero.');

      let cashPointId: string | null = null;
      if (method.is_cash) {
        const points = await tx.selectFrom('cash_point').select(['id', 'branch_id', 'is_active']).where('branch_id', '=', input.branchId).where('is_active', '=', true).execute();
        if (input.cashPointId === undefined || input.cashPointId === null) {
          if (points.length > 0) throw new InvalidCustomer('Choose the till or safe the cash went into.');
        } else {
          if (!points.some((p) => p.id === input.cashPointId)) throw new InvalidCustomer('That cash point is not at this branch.');
          cashPointId = input.cashPointId;
        }
      } else if (input.cashPointId !== undefined && input.cashPointId !== null) {
        throw new InvalidCustomer(`A ${method.name.toLowerCase()} payment does not go into a cash point.`);
      }

      const receiptNo = await groupNumber(tx, 'RCP');
      const at = new Date();
      await tx
        .insertInto('customer_payment')
        .values({
          id: input.id, receipt_no: receiptNo, customer_id: input.customerId, branch_id: input.branchId,
          amount: fromCents(cents), payment_type_id: input.paymentTypeId,
          reference: (input.reference ?? '').trim() === '' ? null : (input.reference ?? '').trim(),
          cash_point_id: cashPointId, received_at: at, note: input.note ?? null, recorded_by: input.recordedBy,
        })
        .execute();
      if (cashPointId !== null) {
        await postCash(tx, { cashPointId, amount: fromCents(cents), reason: 'customer_payment', actorId: input.recordedBy, docType: 'CUSTOMER_PAY', docId: input.id, occurredAt: at });
      }
      await audit(tx, 'CUSTOMER_PAID', input.recordedBy, input.branchId, 'customer_payment', input.id, { receiptNo, customer: customer.name, amount: fromCents(cents), method: method.name });
      return { id: input.id, receiptNo };
    });
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'customer_payment_pkey') {
      const won = await db.selectFrom('customer_payment').select(['id', 'receipt_no']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, receiptNo: won.receipt_no, replayed: true };
    }
    throw error;
  }
}

export async function voidCustomerPayment(db: Db, id: string, by: string, reason: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const p = await tx.selectFrom('customer_payment').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (p === undefined) throw new InvalidCustomer('No such payment.');
    if (p.voided_at !== null) throw new InvalidCustomer(`${p.receipt_no} has already been voided.`);
    await sql`UPDATE customer_payment SET voided_at = now(), voided_by = ${by}::uuid, void_reason = ${reason} WHERE id = ${id}::uuid`.execute(tx);
    if (p.cash_point_id !== null) {
      await postCash(tx, { cashPointId: p.cash_point_id, amount: -Number(p.amount), reason: 'customer_payment_void', actorId: by, docType: 'CUSTOMER_PAY', docId: id });
    }
    await audit(tx, 'CUSTOMER_PAYMENT_VOIDED', by, p.branch_id, 'customer_payment', id, { receiptNo: p.receipt_no, amount: Number(p.amount), reason });
  });
}
