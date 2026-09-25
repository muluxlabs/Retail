import { describe, expect, it } from 'vitest';

import {
  InvalidBasket,
  isMoney,
  PaymentMismatch,
  priceLine,
  settlePayments,
  toCents,
  totalBasket,
} from '../src/basket.js';

describe('cents', () => {
  it('converts decimals that floating point gets wrong', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1.005)).toBe(101); // 1.005 * 100 is 100.49999999999999; a half must still round up
    expect(toCents(-1.005)).toBe(-101); // and symmetrically away from zero for a refund
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(4.35)).toBe(435);
  });

  it('recognises real amounts of money', () => {
    expect(isMoney(3.99)).toBe(true);
    expect(isMoney(0)).toBe(true);
    expect(isMoney(3.999)).toBe(false);
    expect(isMoney(Number.NaN)).toBe(false);
  });
});

describe('priceLine', () => {
  it('multiplies whole packs exactly', () => {
    expect(priceLine({ qtyPacks: 3, unitPrice: 1.1 })).toEqual({ grossCents: 330, discountCents: 0, totalCents: 330 });
  });

  it('rounds a fractional quantity to the nearest cent, halves up', () => {
    // 0.75 kg at 3.99 = 2.9925 -> 2.99
    expect(priceLine({ qtyPacks: 0.75, unitPrice: 3.99 }).totalCents).toBe(299);
    // 0.5 at 0.05 = 0.025 -> 0.03 (a half rounds up)
    expect(priceLine({ qtyPacks: 0.5, unitPrice: 0.05 }).totalCents).toBe(3);
  });

  it('takes a discount off the line', () => {
    expect(priceLine({ qtyPacks: 2, unitPrice: 5, discount: 1.5 })).toEqual({
      grossCents: 1000,
      discountCents: 150,
      totalCents: 850,
    });
  });

  it('refuses nonsense', () => {
    expect(() => priceLine({ qtyPacks: 0, unitPrice: 1 })).toThrow(InvalidBasket);
    expect(() => priceLine({ qtyPacks: -1, unitPrice: 1 })).toThrow(InvalidBasket);
    expect(() => priceLine({ qtyPacks: 1, unitPrice: 1.234 })).toThrow(InvalidBasket);
    expect(() => priceLine({ qtyPacks: 1, unitPrice: -1 })).toThrow(InvalidBasket);
    expect(() => priceLine({ qtyPacks: 1, unitPrice: 2, discount: 2.01 })).toThrow(InvalidBasket);
  });
});

describe('totalBasket', () => {
  it('is the sum of the ROUNDED lines, so the receipt always adds up', () => {
    // Three lines of 0.333 x 1.00 would sum to 0.999 -> 1.00 if rounded once at the end; rounded per line they are 0.33 each = 0.99.
    const lines = [1, 2, 3].map(() => priceLine({ qtyPacks: 0.333, unitPrice: 1 }));
    expect(lines.map((l) => l.totalCents)).toEqual([33, 33, 33]);
    expect(totalBasket(lines).netCents).toBe(99);
  });

  it('separates gross, discount and net', () => {
    const t = totalBasket([
      priceLine({ qtyPacks: 1, unitPrice: 10, discount: 1 }),
      priceLine({ qtyPacks: 2, unitPrice: 2.5 }),
    ]);
    expect(t).toEqual({ grossCents: 1500, discountCents: 100, netCents: 1400 });
    expect(t.grossCents - t.discountCents).toBe(t.netCents);
  });

  it('refuses an empty sale', () => {
    expect(() => totalBasket([])).toThrow(InvalidBasket);
  });
});

describe('settlePayments', () => {
  it('gives change from cash: the books see the amount applied, not the note handed over', () => {
    const s = settlePayments(750, [{ isCash: true, amount: 7.5, tendered: 10 }]);
    expect(s).toEqual({ paidCents: 750, tenderedCents: 1000, changeCents: 250 });
  });

  it('defaults tendered to the amount', () => {
    expect(settlePayments(500, [{ isCash: false, amount: 5 }]).changeCents).toBe(0);
  });

  it('splits a bill across methods', () => {
    const s = settlePayments(2000, [
      { isCash: true, amount: 12, tendered: 15 },
      { isCash: false, amount: 8 },
    ]);
    expect(s).toEqual({ paidCents: 2000, tenderedCents: 2300, changeCents: 300 });
  });

  it('refuses payments that do not cover the bill, in either direction', () => {
    expect(() => settlePayments(1000, [{ isCash: true, amount: 9.99 }])).toThrow(PaymentMismatch);
    expect(() => settlePayments(1000, [{ isCash: false, amount: 10.01 }])).toThrow(PaymentMismatch);
    expect(() => settlePayments(1000, [])).toThrow(PaymentMismatch);
  });

  it('never gives change on a card or a transfer', () => {
    expect(() => settlePayments(500, [{ isCash: false, amount: 5, tendered: 10 }])).toThrow(InvalidBasket);
  });

  it('refuses a customer handing over less than they are paying', () => {
    expect(() => settlePayments(500, [{ isCash: true, amount: 5, tendered: 4 }])).toThrow(InvalidBasket);
  });
});
