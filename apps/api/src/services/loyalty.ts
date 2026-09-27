/**
 * Loyalty points: earning and spending inside a sale, adjustments by hand,
 * and a customer's points history.
 *
 * Spending is checked against the balance while the customer's row is locked
 * (checkout takes that lock), so two tills cannot spend the same points.
 */

import { InvalidLoyalty, NotEnoughPoints, pointsEarned, pointsFor, type LoyaltyRules } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface Rules extends LoyaltyRules {
  enabled: boolean;
}

export async function loyaltyRules(db: Db | Tx): Promise<Rules> {
  const rows = await db
    .selectFrom('system_setting')
    .select(['key', 'value'])
    .where('key', 'in', ['loyalty_enabled', 'loyalty_points_per_dollar', 'loyalty_point_value'])
    .execute();
  const s = new Map(rows.map((r) => [r.key, r.value]));
  const perDollar = Number(s.get('loyalty_points_per_dollar') ?? '1');
  const value = Number(s.get('loyalty_point_value') ?? '0.01');
  return {
    enabled: s.get('loyalty_enabled') === 'yes',
    pointsPerDollar: Number.isFinite(perDollar) && perDollar > 0 ? perDollar : 1,
    pointValueCents: Number.isFinite(value) && value >= 0.01 ? Math.round(value * 100) : 1,
  };
}

export async function pointsBalance(db: Db | Tx, customerId: string): Promise<number> {
  const r = await db.selectFrom('loyalty_balance').select('points').where('customer_id', '=', customerId).executeTakeFirst();
  return Number(r?.points ?? 0);
}

/**
 * Before any stock moves: the points a sale spends, checked against the
 * balance. The customer's row must already be locked by the caller.
 */
export async function pointsToSpend(
  tx: Tx,
  customer: { id: string; name: string } | null,
  loyaltyCents: number,
  rules: Rules,
): Promise<number> {
  if (loyaltyCents === 0) return 0;
  if (!rules.enabled) throw new InvalidLoyalty('Loyalty points are switched off: they cannot be spent.');
  if (customer === null) throw new InvalidLoyalty('Choose the customer whose points are being spent.');
  const needed = pointsFor(loyaltyCents, rules);
  const balance = await pointsBalance(tx, customer.id);
  if (needed > balance) throw new NotEnoughPoints(customer.name, balance, needed);
  return needed;
}

/** After the sale is written: record what it spent and what it earned. */
export async function postSalePoints(
  tx: Tx,
  input: {
    saleId: string;
    customerId: string;
    branchId: string;
    cashierId: string;
    spent: number;
    /** Net of the sale less the part paid with points. */
    eligibleCents: number;
    rules: Rules;
    at: Date;
  },
): Promise<void> {
  const base = { customer_id: input.customerId, sale_id: input.saleId, branch_id: input.branchId, actor_id: input.cashierId, occurred_at: input.at, note: null };
  if (input.spent > 0) {
    await tx.insertInto('loyalty_movement').values({ ...base, event_id: crypto.randomUUID(), points: -input.spent, reason: 'redeem' }).execute();
  }
  const earned = input.rules.enabled ? pointsEarned(input.eligibleCents, input.rules) : 0;
  if (earned > 0) {
    await tx.insertInto('loyalty_movement').values({ ...base, event_id: crypto.randomUUID(), points: earned, reason: 'earn' }).execute();
  }
}

/** For a receipt: what this sale earned and spent, and the balance straight after it. */
export async function salePoints(db: Db | Tx, saleId: string, customerId: string) {
  const r = await sql<{ earned: number; spent: number; lastSeq: number | null }>`
    SELECT coalesce(sum(points) FILTER (WHERE reason = 'earn'), 0)::int AS earned,
           coalesce(-sum(points) FILTER (WHERE reason = 'redeem'), 0)::int AS spent,
           max(seq) AS "lastSeq"
    FROM loyalty_movement WHERE sale_id = ${saleId}::uuid`.execute(db);
  const row = r.rows[0];
  if (row === undefined || row.lastSeq === null) return null;
  const b = await sql<{ balance: number }>`
    SELECT coalesce(sum(points), 0)::int AS balance FROM loyalty_movement
    WHERE customer_id = ${customerId}::uuid AND seq <= ${row.lastSeq}`.execute(db);
  return { earned: Number(row.earned), spent: Number(row.spent), balance: Number(b.rows[0]?.balance ?? 0) };
}

/** A manager adds or takes away points by hand. Never below zero; always with a reason; always raised for review. */
export async function adjustPoints(
  db: Db,
  input: { eventId: string; customerId: string; points: number; note: string; actorId: string; branchId: string },
): Promise<{ balance: number; replayed: boolean }> {
  if (!Number.isInteger(input.points) || input.points === 0) throw new InvalidLoyalty('Give a whole number of points to add (or take away, with a minus).');
  if (input.note.trim() === '') throw new InvalidLoyalty('Say why the points are being changed.');
  const done = await db.selectFrom('loyalty_movement').select('customer_id').where('event_id', '=', input.eventId).executeTakeFirst();
  if (done !== undefined) return { balance: await pointsBalance(db, input.customerId), replayed: true };
  return db.transaction().execute(async (tx) => {
    const c = await sql<{ id: string; name: string }>`SELECT id, name FROM customer WHERE id = ${input.customerId}::uuid FOR UPDATE`.execute(tx);
    const customer = c.rows[0];
    if (customer === undefined) throw new InvalidLoyalty('No such customer.');
    const before = await pointsBalance(tx, customer.id);
    if (before + input.points < 0) throw new NotEnoughPoints(customer.name, before, -input.points);
    const at = new Date();
    const m = await tx
      .insertInto('loyalty_movement')
      .values({
        event_id: input.eventId, customer_id: customer.id, points: input.points, reason: 'adjust', sale_id: null,
        branch_id: input.branchId, note: input.note.trim(), actor_id: input.actorId, occurred_at: at,
      })
      .returning('seq')
      .executeTakeFirstOrThrow();
    const rules = await loyaltyRules(tx);
    await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'loyalty_adjustment',
        branch_id: input.branchId,
        terminal_id: null,
        actor_id: input.actorId,
        product_id: null,
        detail: JSON.stringify({ customerId: customer.id, customer: customer.name, points: input.points, before, after: before + input.points, note: input.note.trim(), seq: m.seq }),
        // What the points are worth at the till: added points are value given away.
        value_impact: -(input.points * rules.pointValueCents) / 100,
        currency: 'USD',
        occurred_at: at,
      })
      .execute();
    return { balance: before + input.points, replayed: false };
  });
}

export async function customerPoints(db: Db, customerId: string) {
  const [bal, rows, rules] = await Promise.all([
    db.selectFrom('loyalty_balance').selectAll().where('customer_id', '=', customerId).executeTakeFirst(),
    sql<Record<string, unknown>>`
      SELECT m.seq, m.points, m.reason::text AS reason, m.note, m.occurred_at AS "at", s.id AS "saleId", s.receipt_no AS "receiptNo",
             b.name AS "branchName", p.full_name AS "byName"
      FROM loyalty_movement m JOIN branch b ON b.id = m.branch_id JOIN person p ON p.id = m.actor_id
      LEFT JOIN sale s ON s.id = m.sale_id
      WHERE m.customer_id = ${customerId}::uuid ORDER BY m.seq DESC LIMIT 200`.execute(db),
    loyaltyRules(db),
  ]);
  const points = Number(bal?.points ?? 0);
  return {
    enabled: rules.enabled,
    points,
    worth: (points * rules.pointValueCents) / 100,
    earned: Number(bal?.earned ?? 0),
    redeemed: Number(bal?.redeemed ?? 0),
    adjusted: Number(bal?.adjusted ?? 0),
    movements: rows.rows.map((r) => ({ ...r, seq: Number(r['seq']), points: Number(r['points']) })),
  };
}
