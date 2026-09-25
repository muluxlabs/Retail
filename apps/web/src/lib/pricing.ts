/**
 * Bulk price arithmetic for the Prices screen.
 *
 * All in whole cents, so a price is never a floating point near-miss. The
 * rounding rule is stated once and shown to the person on screen:
 *   - "set to cost + markup" rounds UP to the step, so the price is never
 *     below the markup asked for (the same rule as the server's fill-missing);
 *   - a flat set is used as typed; a percentage change rounds to the NEAREST
 *     step, because "raise by 5%" should not quietly become 8%.
 */

import { fromCents, toCents } from './basketMath.js';

export type BulkMode = 'set' | 'percent' | 'markup';

export const ROUND_STEPS = [0.01, 0.05, 0.1, 0.5, 1] as const;
export type RoundStep = (typeof ROUND_STEPS)[number];

export interface BulkTarget {
  /** The price now (or being edited), null if unpriced. */
  current: number | null;
  /** Cost of one pack, null if nothing costed has been received. */
  cost: number | null;
}

export function bulkPrice(
  mode: BulkMode,
  amount: number,
  step: RoundStep,
  target: BulkTarget,
): number | null {
  const stepCents = Math.round(step * 100);
  if (mode === 'set') return amount >= 0 ? fromCents(toCents(amount)) : null;

  if (mode === 'percent') {
    if (target.current === null) return null;
    const raw = target.current * 100 * (1 + amount / 100);
    const cents = Math.round(Number(raw.toFixed(6)) / stepCents) * stepCents;
    return cents < 0 ? null : fromCents(cents);
  }

  // markup on cost
  if (target.cost === null || !(target.cost > 0)) return null;
  const raw = Number((target.cost * 100 * (1 + amount / 100)).toFixed(6));
  return fromCents(Math.ceil(raw / stepCents - 1e-9) * stepCents);
}

/** Gross margin on price: (price - cost) / price. Null when it cannot be worked out. */
export function marginPercent(price: number | null, cost: number | null): number | null {
  if (price === null || cost === null || !(price > 0)) return null;
  return ((price - cost) / price) * 100;
}
