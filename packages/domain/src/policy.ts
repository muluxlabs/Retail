/**
 * The rules themselves, as pure functions.
 *
 * Extracted so there is exactly one statement of each rule (AD-6). Three
 * callers need them and none may hold a private copy:
 *
 *   - `Ledger`, the in-memory implementation used by the offline POS
 *   - the API's database-backed posting service
 *   - the test suite, which proves the rule rather than the caller
 *
 * Everything here is a pure function of its arguments. No clock, no database,
 * no I/O. That is what makes the same rule enforceable on a till that has not
 * seen the network for six hours.
 */

import { NegativeStockBlocked } from './errors.js';
import type { MovementReason } from './types.js';
import { RECEIPT_REASONS } from './types.js';

/**
 * Gap between business time and server time beyond which a movement counts as
 * backdated. Matches the `backdated_movement` view in 001_core.sql.
 *
 * TGRN-10001 carried a five-month gap, and the previous vendor shipped a
 * "Backdate inventory report" — treating it as routine rather than as an
 * incident. Here it is an incident.
 */
export const BACKDATE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/** Round to cents, for money leaving the domain. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Would this movement take stock below zero?
 *
 * Pure predicate, so the caller can ask before committing to a transaction.
 */
export function wouldGoNegative(available: number, qtyBase: number): boolean {
  return qtyBase < 0 && available + qtyBase < 0;
}

/**
 * The negative-stock guard.
 *
 * Their stated problem is "selling negative / zeros — override to their own
 * benefit". Blocking is the default; an override is possible but never
 * silent, and the caller is responsible for raising the exception.
 */
export function assertStockAvailable(
  available: number,
  qtyBase: number,
  options: { allowNegative?: boolean } = {},
): void {
  if (options.allowNegative === true) return;
  if (wouldGoNegative(available, qtyBase)) {
    throw new NegativeStockBlocked(available, Math.abs(qtyBase));
  }
}

/** Milliseconds by which recording lagged the business event. Never negative. */
export function backdateGapMs(occurredAt: Date, recordedAt: Date): number {
  return Math.max(0, recordedAt.getTime() - occurredAt.getTime());
}

export function isBackdated(occurredAt: Date, recordedAt: Date): boolean {
  return backdateGapMs(occurredAt, recordedAt) > BACKDATE_THRESHOLD_MS;
}

export function backdateGapHours(occurredAt: Date, recordedAt: Date): number {
  return roundMoney(backdateGapMs(occurredAt, recordedAt) / 3_600_000);
}

/** Does this movement reason represent stock entering at a known cost? */
export function isReceipt(reason: MovementReason): boolean {
  return RECEIPT_REASONS.includes(reason);
}

/**
 * Weighted-average cost over receipt movements.
 *
 * Mirrors the `product_wac` view. Returns null rather than guessing when
 * nothing priced has been received: a guessed cost is how cost price drifted
 * to equal selling price and produced a 0.11% gross margin.
 */
export function weightedAverageCost(
  rows: readonly { qtyBase: number; unitCost: number | null; reason: MovementReason }[],
): number | null {
  let value = 0;
  let qty = 0;
  for (const row of rows) {
    if (row.unitCost === null || !isReceipt(row.reason)) continue;
    value += row.qtyBase * row.unitCost;
    qty += row.qtyBase;
  }
  if (qty === 0) return null; // NULLIF(SUM(qty_base), 0)
  return value / qty;
}

export interface CountVariance {
  expected: number;
  counted: number;
  variance: number;
  /** Variance valued at weighted-average cost, or null when cost is unknown. */
  valueImpact: number | null;
}

/**
 * Compare a physical count against the ledger.
 *
 * Valuing the variance is the step that, when skipped, leaves a count
 * arithmetically posted but financially invisible. A count that is never
 * posted changes nothing at all — which is why four counts sitting "In
 * progress" at Kernmaur, Mission and TM never cleared their variance, and the
 * next count started from the same wrong base.
 */
export function computeCountVariance(
  expected: number,
  counted: number,
  wac: number | null,
): CountVariance {
  const variance = counted - expected;
  const valueImpact =
    wac === null || wac === 0 || variance === 0 ? null : roundMoney(variance * wac);
  return { expected, counted, variance, valueImpact };
}
