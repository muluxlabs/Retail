import { priceLine, settlePayments, toCents as domainToCents, totalBasket } from '../../../packages/domain/src/basket.js';
import { describe, expect, it } from 'vitest';

import { basketCents, lineCents, parseMoney, settleRows, toCents } from '../src/lib/basketMath.js';

describe('till arithmetic agrees with the domain rule the server applies', () => {
  it('rounds every line the same way, including half-cent edges', () => {
    const cases = [
      { qtyPacks: 3, unitPrice: 1.1, discount: 0 },
      { qtyPacks: 0.75, unitPrice: 2.35, discount: 0.1 },
      { qtyPacks: 1.5, unitPrice: 0.33, discount: 0 },
      { qtyPacks: 0.333, unitPrice: 1.005 * 0 + 1.0, discount: 0 },
      { qtyPacks: 7, unitPrice: 0.05, discount: 0.05 },
    ];
    for (const c of cases) {
      const d = priceLine(c);
      const w = lineCents(c);
      expect(w).toEqual({ grossCents: d.grossCents, discountCents: d.discountCents, totalCents: d.totalCents });
    }
    const basket = totalBasket(cases.map((c) => priceLine(c)));
    expect(basketCents(cases).netCents).toBe(basket.netCents);
  });

  it('cleans floating point noise in toCents', () => {
    for (const x of [1.005, 0.1 + 0.2, 19.99, 4.35, 1.15]) expect(toCents(x)).toBe(domainToCents(x));
  });

  it('cash tender: the books see the amount applied, the customer gets change', () => {
    const t = settleRows(750, [{ isCash: true, received: 10 }]);
    expect(t.problem).toBeNull();
    expect(t.rows[0]).toMatchObject({ appliedCents: 750, receivedCents: 1000 });
    expect(t.changeCents).toBe(250);
    const d = settlePayments(750, [{ isCash: true, amount: 7.5, tendered: 10 }]);
    expect(d.changeCents).toBe(t.changeCents);
  });

  it('split payment: card first, cash takes the rest and can give change', () => {
    const t = settleRows(2000, [
      { isCash: true, received: 15 },
      { isCash: false, received: 8 },
    ]);
    expect(t.problem).toBeNull();
    expect(t.rows[1]).toMatchObject({ appliedCents: 800 });
    expect(t.rows[0]).toMatchObject({ appliedCents: 1200, receivedCents: 1500 });
    expect(t.changeCents).toBe(300);
  });

  it('blank amount means the rest of the bill', () => {
    const t = settleRows(1234, [{ isCash: false, received: null }]);
    expect(t.problem).toBeNull();
    expect(t.rows[0]?.appliedCents).toBe(1234);
  });

  it('refuses under-payment and card overpayment', () => {
    expect(settleRows(1000, [{ isCash: true, received: 5 }]).problem).toMatch(/do not cover/);
    expect(settleRows(1000, [{ isCash: false, received: 12 }]).problem).toMatch(/cannot be more/);
  });

  it('parses money fields strictly', () => {
    expect(parseMoney('12.5')).toBe(12.5);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('.')).toBeNull();
  });
});
