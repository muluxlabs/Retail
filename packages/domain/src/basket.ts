/**
 * The money arithmetic of a sale.
 *
 * Shared, like every other rule (AD-6), so the till and the server can never
 * disagree about what a basket costs or how much change is owed.
 *
 * All money is handled as WHOLE CENTS (integers). Adding 0.1 and 0.2 in
 * floating point does not give 0.3, and in a till that is a cent that appears
 * from nowhere; an auditor will find it. Prices arrive as decimals with at
 * most two places, become cents once at the edge, and only become decimals
 * again for display.
 *
 * Rounding rule, stated once: each LINE is rounded to the nearest cent, halves
 * away from zero, and the basket is the sum of the rounded lines. Nothing is
 * rounded after that, so the receipt's lines always add up to its total.
 */

import { DomainError } from './errors.js';

/** A decimal amount of money to whole cents. Inputs have at most two decimal places. */
export function toCents(amount: number): number {
  return roundHalfAwayFromZero(amount * 100);
}

/**
 * Round to a whole number, halves away from zero, ignoring floating point
 * noise. 1.005 * 100 is 100.49999999999999 in floating point; a value that is
 * meant to be exactly on a half must not be pushed just under it. (Math.round
 * alone also rounds -0.5 towards zero the wrong way for refunds.)
 */
function roundHalfAwayFromZero(x: number): number {
  const cleaned = Number(Math.abs(x).toFixed(6));
  return Math.sign(x) * Math.round(cleaned);
}

/** Whole cents back to a decimal amount, for storage and display only. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** True when `amount` has no more than two decimal places, i.e. it is a real amount of money. */
export function isMoney(amount: number): boolean {
  return Number.isFinite(amount) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

export interface BasketLineInput {
  /** How many packs. May be fractional (0.75 kg of something priced per kg). */
  qtyPacks: number;
  /** Price per pack, in decimal money. */
  unitPrice: number;
  /** A discount on this line, in decimal money. */
  discount?: number;
}

export interface PricedLine {
  grossCents: number;
  discountCents: number;
  totalCents: number;
}

export function priceLine(line: BasketLineInput): PricedLine {
  if (!(line.qtyPacks > 0)) throw new InvalidBasket('A line needs a quantity above zero.');
  if (!isMoney(line.unitPrice) || line.unitPrice < 0) throw new InvalidBasket('A price must be a valid amount of money.');
  const discount = line.discount ?? 0;
  if (!isMoney(discount) || discount < 0) throw new InvalidBasket('A discount must be a valid amount of money.');

  // toFixed first: 1.1 * 3 is 3.3000000000000003 in floating point, and a
  // value that should be exactly on a half-cent must not be pushed off it.
  const grossCents = roundHalfAwayFromZero(line.qtyPacks * toCents(line.unitPrice));
  const discountCents = toCents(discount);
  if (discountCents > grossCents) throw new InvalidBasket('A discount cannot be more than the line it is on.');

  return { grossCents, discountCents, totalCents: grossCents - discountCents };
}

export interface BasketTotals {
  grossCents: number;
  discountCents: number;
  netCents: number;
}

export function totalBasket(lines: readonly PricedLine[]): BasketTotals {
  if (lines.length === 0) throw new InvalidBasket('A sale needs at least one item.');
  const grossCents = lines.reduce((s, l) => s + l.grossCents, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  return { grossCents, discountCents, netCents: grossCents - discountCents };
}

export interface PaymentInput {
  /** Cash is the only tender a customer can overpay with, and the only one change comes back from. */
  isCash: boolean;
  /** What this payment covers of the bill, in decimal money. */
  amount: number;
  /** What the customer handed over. Defaults to `amount`. Above `amount` only for cash. */
  tendered?: number;
}

export interface PaymentSettlement {
  paidCents: number;
  tenderedCents: number;
  changeCents: number;
}

/**
 * Do the payments cover the bill exactly, and how much change is owed?
 *
 * "Cover exactly" is deliberate: the amounts APPLIED to the bill must sum to
 * it. A customer paying a $7.50 bill with a $10 note is one cash payment of
 * $7.50 applied, $10 tendered, $2.50 change - the books see $7.50 of cash
 * sales, not $10.
 */
export function settlePayments(netCents: number, payments: readonly PaymentInput[]): PaymentSettlement {
  if (payments.length === 0) throw new PaymentMismatch(netCents, 0);

  let paidCents = 0;
  let tenderedCents = 0;
  for (const p of payments) {
    if (!isMoney(p.amount) || !(p.amount > 0)) throw new InvalidBasket('A payment must be an amount above zero.');
    const applied = toCents(p.amount);
    const handed = p.tendered === undefined ? applied : toCents(p.tendered);
    if (p.tendered !== undefined && !isMoney(p.tendered)) throw new InvalidBasket('A tendered amount must be a valid amount of money.');
    if (handed < applied) throw new InvalidBasket('A customer cannot hand over less than the payment covers.');
    if (handed > applied && !p.isCash) throw new InvalidBasket('Only a cash payment can be more than the amount due; there is no change from a card or a transfer.');
    paidCents += applied;
    tenderedCents += handed;
  }

  if (paidCents !== netCents) throw new PaymentMismatch(netCents, paidCents);
  return { paidCents, tenderedCents, changeCents: tenderedCents - paidCents };
}

/** The basket itself is not valid: empty, a bad quantity, a bad amount. */
export class InvalidBasket extends DomainError {
  constructor(message: string) {
    super('INVALID_BASKET', message);
  }
}

/** The payments do not add up to what is owed. */
export class PaymentMismatch extends DomainError {
  constructor(dueCents: number, paidCents: number) {
    super(
      'PAYMENT_MISMATCH',
      `The payments add up to ${fromCents(paidCents).toFixed(2)} but the sale is ${fromCents(dueCents).toFixed(2)}.`,
      { due: fromCents(dueCents), paid: fromCents(paidCents) },
    );
  }
}

/** Nothing to charge: the product has no selling price yet. */
export class PriceMissing extends DomainError {
  constructor(productName: string, productId: string) {
    super('PRICE_MISSING', `“${productName}” has no selling price yet. A manager needs to set it before it can be sold.`, {
      productId,
      productName,
    });
  }
}

/** A price or discount away from the list, by someone without authority to give one. */
export class PriceOverrideRequired extends DomainError {
  constructor(productName: string, productId: string) {
    super(
      'PRICE_OVERRIDE_REQUIRED',
      `“${productName}” can only be sold away from its list price with a manager’s authorisation.`,
      { productId, productName },
    );
  }
}

/** The branch has tills, and the sale did not say which one took the cash. */
export class TillRequired extends DomainError {
  constructor() {
    super('TILL_REQUIRED', 'Choose the till this cash is going into.');
  }
}
