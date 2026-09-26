/**
 * Cashier shifts: the rules for opening and closing a cashier's session on a till.
 *
 * The cash a till should hold at the end of a shift is what was counted into
 * it at the start, plus every cash movement on the till during the shift (cash
 * sales, money received from customers, float moved in or out, cash paid to a
 * supplier). The shift report shows exactly that sum, line by line, so a
 * shortage can be traced.
 */

import { fromCents } from './basket.js';
import { DomainError } from './errors.js';

export class InvalidShift extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_SHIFT', message, detail);
  }
}

/** The till needs the cashier's own open shift before it will sell. */
export class ShiftRequired extends DomainError {
  constructor(till: string) {
    super('SHIFT_REQUIRED', `Open your shift on ${till} before selling: count the float in the till first.`, { till });
  }
}

/** A shift is already open on this till, or for this cashier. */
export class ShiftAlreadyOpen extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('SHIFT_ALREADY_OPEN', message, detail);
  }
}

/** End of day cannot be done while shifts at the branch are still open. */
export class ShiftsStillOpen extends DomainError {
  constructor(open: { cashier: string; till: string }[]) {
    super(
      'SHIFTS_STILL_OPEN',
      `Close the open shifts before closing the day: ${open.map((o) => `${o.cashier} on ${o.till}`).join(', ')}.`,
      { open },
    );
  }
}

export interface CashLine {
  reason: string;
  cents: number;
}

export interface ShiftCash {
  openingCents: number;
  /** Grouped by reason, in a fixed order; only reasons that occurred. */
  lines: { reason: string; amount: number }[];
  expectedCents: number;
}

const ORDER = [
  'sales_receipts',
  'customer_payment',
  'customer_payment_void',
  'float_issue',
  'float_return',
  'supplier_payment',
  'supplier_payment_void',
  'bank_deposit',
  'petty_disbursement',
  'cash_variance',
  'write_off',
];

/** What the till should hold: counted at the start, plus everything that moved through it. */
export function shiftCash(openingCents: number, movements: readonly CashLine[]): ShiftCash {
  const by = new Map<string, number>();
  for (const m of movements) by.set(m.reason, (by.get(m.reason) ?? 0) + m.cents);
  const reasons = [...by.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const total = [...by.values()].reduce((s, c) => s + c, 0);
  return {
    openingCents,
    lines: reasons.filter((r) => by.get(r) !== 0).map((r) => ({ reason: r, amount: fromCents(by.get(r)!) })),
    expectedCents: openingCents + total,
  };
}
