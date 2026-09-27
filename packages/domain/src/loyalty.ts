/**
 * Loyalty points: what a sale earns, and what points are worth when spent.
 *
 * Points are whole numbers. A sale earns on what the customer actually paid
 * for, not on the part they paid with points (spending points does not earn
 * more points). Earning rounds down: a customer is never given a point they
 * did not reach.
 */

import { DomainError } from './errors.js';

export class InvalidLoyalty extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_LOYALTY', message, detail);
  }
}

export class NotEnoughPoints extends DomainError {
  constructor(customer: string, balance: number, needed: number) {
    super('NOT_ENOUGH_POINTS', `${customer} has ${balance.toLocaleString('en')} points; this needs ${needed.toLocaleString('en')}.`, {
      customer,
      balance,
      needed,
    });
  }
}

export interface LoyaltyRules {
  /** Points earned per whole dollar paid, up to two decimals (0.5 = a point every $2). */
  pointsPerDollar: number;
  /** What one point is worth when spent, in cents (whole cents, at least 1). */
  pointValueCents: number;
}

/** Points a sale earns: rounded down, on the amount paid other than with points. */
export function pointsEarned(eligibleCents: number, rules: LoyaltyRules): number {
  if (eligibleCents <= 0 || rules.pointsPerDollar <= 0) return 0;
  // Integers throughout: rate in hundredths, amount in cents.
  const rateHundredths = Math.round(rules.pointsPerDollar * 100);
  return Math.floor((eligibleCents * rateHundredths) / 10_000);
}

/** The points needed to pay an amount. The amount must be a whole number of points. */
export function pointsFor(amountCents: number, rules: LoyaltyRules): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new InvalidLoyalty('The amount paid with points must be above zero.');
  if (rules.pointValueCents < 1) throw new InvalidLoyalty('Points have no value set.');
  if (amountCents % rules.pointValueCents !== 0) {
    throw new InvalidLoyalty(
      `Points are worth ${(rules.pointValueCents / 100).toFixed(2)} each: pay an amount that is a whole number of points.`,
      { pointValueCents: rules.pointValueCents },
    );
  }
  return amountCents / rules.pointValueCents;
}

/** The most a customer can pay with the points they have, in cents. */
export function pointsWorthCents(points: number, rules: LoyaltyRules): number {
  return Math.max(0, points) * rules.pointValueCents;
}
