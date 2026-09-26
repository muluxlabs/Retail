/**
 * The rules of buying: what a delivery costs, when it falls due, how long an
 * unpaid amount has been owed, and whether a payment was made before or after
 * the goods came.
 *
 * Pure functions, no database: the same rules can be checked by a test with a
 * handful of numbers, and stated once for every screen and report.
 */

import { fromCents } from './basket.js';
import { DomainError } from './errors.js';

export type SupplierTerms = 'prepaid' | 'cash_on_delivery' | 'credit';

// -- errors ------------------------------------------------------------------------------------

/** A purchase order, goods received note or payment that is not valid as asked. */
export class InvalidPurchase extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_PURCHASE', message, detail);
  }
}

/** The order is cancelled, closed or already complete: nothing more can be received against it. */
export class PurchaseOrderNotOpen extends DomainError {
  constructor(poNo: string, why: string) {
    super('PURCHASE_ORDER_NOT_OPEN', `${poNo} is ${why}, so nothing more can be received against it.`, { poNo });
  }
}

/** The payment has already been voided. */
export class PaymentAlreadyVoided extends DomainError {
  constructor(paymentNo: string) {
    super('PAYMENT_ALREADY_VOIDED', `${paymentNo} has already been voided.`, { paymentNo });
  }
}

/** The document asked for does not exist (or is not visible to this person). */
export class PurchasingDocumentNotFound extends DomainError {
  constructor(kind: string, id: string) {
    super('PURCHASING_DOCUMENT_NOT_FOUND', `No ${kind} ${id}.`, { kind, id });
  }
}

/** A proof of payment file that is not an accepted image or PDF, or is too big. */
export class ProofRejected extends DomainError {
  constructor(message: string) {
    super('PROOF_REJECTED', message);
  }
}

// -- cost --------------------------------------------------------------------------------------------

/**
 * What a line of a delivery costs, in whole cents: quantity of packs times the
 * price of one pack, rounded to the cent (halves away from zero). The same
 * rule as a sale line, so purchases and sales round identically.
 */
export function costLineCents(qtyPacks: number, unitCostPerPack: number): number {
  if (!(qtyPacks > 0)) throw new InvalidPurchase('A line needs a quantity above zero.');
  if (!(unitCostPerPack >= 0) || !Number.isFinite(unitCostPerPack)) throw new InvalidPurchase('A cost must be zero or more.');
  return Math.round(Number((qtyPacks * unitCostPerPack * 100).toFixed(6)));
}

/** Cost of one BASE unit, from the price of a pack: what the stock ledger and the average cost use. */
export function costPerBaseUnit(unitCostPerPack: number, qtyBasePerPack: number): number {
  if (!(qtyBasePerPack > 0)) throw new InvalidPurchase('A pack must hold more than nothing.');
  return Math.round((unitCostPerPack / qtyBasePerPack) * 10_000) / 10_000;
}

/** The total of a delivery or an order, in decimal money, from its lines whole cents. */
export function sumCents(lines: readonly number[]): number {
  return fromCents(lines.reduce((s, c) => s + c, 0));
}

// -- when it is due -----------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * The day a delivery must be paid by, as 'YYYY-MM-DD' on the business calendar.
 *   prepaid / cash on delivery: the day it arrived (prepaid should already be paid)
 *   credit: the day it arrived plus the agreed days
 */
export function dueDate(receivedDay: string, terms: SupplierTerms, creditDays: number | null): string {
  const days = terms === 'credit' ? (creditDays ?? 0) : 0;
  return new Date(Date.parse(`${receivedDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// -- prepaid or postpaid ----------------------------------------------------------------------------------------

export type PaymentTiming = 'prepaid' | 'on_delivery' | 'after_delivery' | 'on_account';

/**
 * Was this payment made before the goods came, when they came, or after?
 *
 *   prepaid         before the goods it pays for were received
 *   on_delivery     on the day they were received
 *   after_delivery  after that day
 *   on_account      not tied to any order or delivery
 *
 * `deliveryDay` is the day the linked delivery arrived (for an order, the first
 * delivery against it), or null if nothing has been received against it yet -
 * which is exactly what a prepayment is.
 */
export function paymentTiming(paidDay: string, linked: boolean, deliveryDay: string | null): PaymentTiming {
  if (!linked) return 'on_account';
  if (deliveryDay === null || paidDay < deliveryDay) return 'prepaid';
  return paidDay === deliveryDay ? 'on_delivery' : 'after_delivery';
}

// -- what is owed, and for how long -------------------------------------------------------------------------------

export interface Delivery {
  id: string;
  /** Business day it was received, 'YYYY-MM-DD'. */
  day: string;
  /** What it cost, in cents. */
  cents: number;
  dueDay: string;
}

export interface OpenItem extends Delivery {
  /** Still unpaid, in cents (never negative). */
  outstandingCents: number;
  /** Days past the due date at `asOf`; zero or negative while not yet due. */
  daysOverdue: number;
}

export type AgeBucket = 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'over90';

export interface Ageing {
  items: OpenItem[];
  /** Payments beyond every delivery: money the supplier holds of ours. */
  creditCents: number;
  buckets: Record<AgeBucket, number>;
  totalCents: number;
}

/**
 * The aged creditors analysis for one supplier: which deliveries are still
 * unpaid and how overdue each is. Payments are applied to the OLDEST delivery
 * first (the standard rule when a payment is not tied to a particular invoice),
 * and anything left over is a credit balance with the supplier.
 */
export function ageDeliveries(deliveries: readonly Delivery[], paidCents: number, asOf: string): Ageing {
  const ordered = [...deliveries].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  let pool = Math.max(0, paidCents);
  const items: OpenItem[] = ordered.map((d) => {
    const applied = Math.min(pool, d.cents);
    pool -= applied;
    return { ...d, outstandingCents: d.cents - applied, daysOverdue: daysBetween(d.dueDay, asOf) };
  });

  const buckets: Record<AgeBucket, number> = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
  for (const i of items) {
    if (i.outstandingCents === 0) continue;
    const key: AgeBucket =
      i.daysOverdue <= 0 ? 'notDue' : i.daysOverdue <= 30 ? 'd1_30' : i.daysOverdue <= 60 ? 'd31_60' : i.daysOverdue <= 90 ? 'd61_90' : 'over90';
    buckets[key] += i.outstandingCents;
  }
  return {
    items: items.filter((i) => i.outstandingCents > 0),
    creditCents: pool,
    buckets,
    totalCents: Object.values(buckets).reduce((s, c) => s + c, 0),
  };
}

// -- a supplier account, as a statement ---------------------------------------------------------------------------

export interface StatementEntry {
  /** Sort key: when it happened. */
  at: string;
  kind: 'received' | 'payment' | 'void' | 'return';
  /** Increases what is owed (goods received). */
  debitCents: number;
  /** Decreases what is owed (a payment, or a credit for goods returned). */
  creditCents: number;
}

/** Entries in time order with the balance after each: positive means we owe the supplier. */
export function runStatement<T extends StatementEntry>(entries: readonly T[]): (T & { balanceCents: number })[] {
  let balance = 0;
  return [...entries]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => {
      balance += e.debitCents - e.creditCents;
      return { ...e, balanceCents: balance };
    });
}
