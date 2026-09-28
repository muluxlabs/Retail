/**
 * Customers on credit: the rules for charging a sale to a customer's account.
 *
 * A customer may owe at most their credit limit. A sale charged to their
 * account is refused if it would take what they owe past it. A limit of zero
 * means the customer buys for cash only. Everything is worked in whole cents.
 */

import { fromCents } from './basket.js';
import { DomainError } from './errors.js';

/** A customer, or a payment from one, that is not valid as asked. */
export class InvalidCustomer extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_CUSTOMER', message, detail);
  }
}

/** The sale would take what the customer owes past their credit limit. */
export class CreditLimitExceeded extends DomainError {
  constructor(name: string, owedCents: number, limitCents: number, chargeCents: number) {
    const room = Math.max(0, limitCents - owedCents);
    super(
      'CREDIT_LIMIT_EXCEEDED',
      limitCents === 0
        ? `${name} is not allowed credit: take payment another way, or ask a manager to set a credit limit.`
        : `${name} owes ${fromCents(owedCents).toFixed(2)} of a ${fromCents(limitCents).toFixed(2)} limit, so at most ${fromCents(room).toFixed(2)} more can be charged to the account (this sale charges ${fromCents(chargeCents).toFixed(2)}).`,
      { owed: fromCents(owedCents), limit: fromCents(limitCents), available: fromCents(room), charge: fromCents(chargeCents) },
    );
  }
}

/** Refuse a charge that would take a customer past their limit. */
export function checkCredit(name: string, owedCents: number, limitCents: number, chargeCents: number): void {
  if (chargeCents <= 0) return;
  if (owedCents + chargeCents > limitCents) throw new CreditLimitExceeded(name, owedCents, limitCents, chargeCents);
}
