import { describe, expect, it } from 'vitest';

import { shiftCash, ShiftsStillOpen } from '../src/index.js';

describe('the cash a till should hold at the end of a shift', () => {
  it('is the float counted in, plus everything that moved through the till', () => {
    const r = shiftCash(5_000, [
      { reason: 'sales_receipts', cents: 12_345 },
      { reason: 'sales_receipts', cents: 655 },
      { reason: 'customer_payment', cents: 2_000 },
      { reason: 'supplier_payment', cents: -3_000 },
      { reason: 'float_return', cents: -10_000 },
    ]);
    expect(r.expectedCents).toBe(5_000 + 13_000 + 2_000 - 3_000 - 10_000);
    expect(r.lines).toEqual([
      { reason: 'sales_receipts', amount: 130 },
      { reason: 'customer_payment', amount: 20 },
      { reason: 'float_return', amount: -100 },
      { reason: 'supplier_payment', amount: -30 },
    ]);
  });

  it('a shift with no cash movements expects exactly the float', () => {
    expect(shiftCash(2_500, []).expectedCents).toBe(2_500);
  });

  it('a voided customer payment cancels out and drops off the report', () => {
    const r = shiftCash(0, [
      { reason: 'customer_payment', cents: 1_000 },
      { reason: 'customer_payment_void', cents: -1_000 },
    ]);
    expect(r.expectedCents).toBe(0);
    expect(r.lines.map((l) => l.reason)).toEqual(['customer_payment', 'customer_payment_void']);
  });

  it('names who is still on shift when the day cannot close', () => {
    const e = new ShiftsStillOpen([{ cashier: 'Tariro', till: 'Till 2' }]);
    expect(e.message).toContain('Tariro on Till 2');
  });
});
