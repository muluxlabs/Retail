import { describe, expect, it } from 'vitest';

import {
  ageDeliveries,
  costLineCents,
  costPerBaseUnit,
  dueDate,
  InvalidPurchase,
  paymentTiming,
  runStatement,
  sumCents,
} from '../src/index.js';

describe('what a delivery costs', () => {
  it('rounds each line to the cent, halves away from zero, like a sale line', () => {
    expect(costLineCents(10, 13.5)).toBe(13500);
    expect(costLineCents(3, 0.335)).toBe(101); // 1.005 -> 1.01
    expect(costLineCents(0.5, 2.01)).toBe(101); // 1.005 -> 1.01
    expect(costLineCents(7, 1.1)).toBe(770);
    expect(costLineCents(1, 0)).toBe(0);
  });

  it('refuses a nonsense line', () => {
    expect(() => costLineCents(0, 5)).toThrow(InvalidPurchase);
    expect(() => costLineCents(-1, 5)).toThrow(InvalidPurchase);
    expect(() => costLineCents(1, -5)).toThrow(InvalidPurchase);
    expect(() => costLineCents(1, Number.NaN)).toThrow(InvalidPurchase);
  });

  it('the lines of a delivery add up to its total exactly', () => {
    const lines = [costLineCents(3, 0.335), costLineCents(7, 1.1), costLineCents(10, 13.5)];
    expect(sumCents(lines)).toBe(1.01 + 7.7 + 135);
  });

  it('cost per base unit is the pack price spread over what is in the pack', () => {
    expect(costPerBaseUnit(13.5, 24)).toBe(0.5625);
    expect(costPerBaseUnit(10, 3)).toBe(3.3333);
    expect(costPerBaseUnit(2, 1)).toBe(2);
    expect(() => costPerBaseUnit(2, 0)).toThrow(InvalidPurchase);
  });
});

describe('when it falls due', () => {
  it('credit terms add the days; prepaid and cash on delivery are due the day it arrives', () => {
    expect(dueDate('2026-09-25', 'credit', 30)).toBe('2026-10-25');
    expect(dueDate('2026-01-15', 'credit', 30)).toBe('2026-02-14');
    expect(dueDate('2026-02-20', 'credit', 14)).toBe('2026-03-06');
    expect(dueDate('2026-09-25', 'cash_on_delivery', null)).toBe('2026-09-25');
    expect(dueDate('2026-09-25', 'prepaid', null)).toBe('2026-09-25');
    expect(dueDate('2026-09-25', 'credit', null)).toBe('2026-09-25');
  });
});

describe('prepaid or postpaid', () => {
  it('names when a payment was made against the delivery', () => {
    expect(paymentTiming('2026-09-20', true, null)).toBe('prepaid'); // nothing received yet
    expect(paymentTiming('2026-09-20', true, '2026-09-25')).toBe('prepaid');
    expect(paymentTiming('2026-09-25', true, '2026-09-25')).toBe('on_delivery');
    expect(paymentTiming('2026-10-10', true, '2026-09-25')).toBe('after_delivery');
    expect(paymentTiming('2026-10-10', false, null)).toBe('on_account');
  });
});

describe('aged creditors', () => {
  const d = (id: string, day: string, cents: number, due: string) => ({ id, day, cents, dueDay: due });

  it('applies payments to the oldest delivery first', () => {
    const a = ageDeliveries(
      [d('b', '2026-08-20', 20000, '2026-09-19'), d('a', '2026-07-01', 10000, '2026-07-31'), d('c', '2026-09-20', 5000, '2026-10-20')],
      12000,
      '2026-09-25',
    );
    // a (10000) is paid in full; b has 2000 of its 20000 paid; c is untouched
    expect(a.items.map((i) => [i.id, i.outstandingCents])).toEqual([
      ['b', 18000],
      ['c', 5000],
    ]);
    expect(a.creditCents).toBe(0);
    expect(a.totalCents).toBe(23000);
  });

  it('buckets what is owed by how overdue it is', () => {
    const a = ageDeliveries(
      [
        d('notdue', '2026-09-20', 100, '2026-10-20'),
        d('late10', '2026-08-26', 200, '2026-09-15'),
        d('late45', '2026-07-01', 400, '2026-08-11'),
        d('late75', '2026-06-01', 800, '2026-07-12'),
        d('late200', '2026-01-01', 1600, '2026-02-01'),
      ],
      0,
      '2026-09-25',
    );
    expect(a.buckets).toEqual({ notDue: 100, d1_30: 200, d31_60: 400, d61_90: 800, over90: 1600 });
    expect(a.totalCents).toBe(3100);
    expect(a.items.find((i) => i.id === 'late10')?.daysOverdue).toBe(10);
    expect(a.items.find((i) => i.id === 'notdue')?.daysOverdue).toBe(-25);
  });

  it('a payment beyond everything owed is a credit balance with the supplier', () => {
    const a = ageDeliveries([d('a', '2026-09-01', 5000, '2026-09-01')], 8000, '2026-09-25');
    expect(a.items).toEqual([]);
    expect(a.creditCents).toBe(3000);
    expect(a.totalCents).toBe(0);
  });

  it('nothing delivered, everything paid in advance: all credit', () => {
    expect(ageDeliveries([], 4000, '2026-09-25').creditCents).toBe(4000);
  });
});

describe('a supplier statement', () => {
  it('carries the balance after each entry: goods received add, payments take away', () => {
    const rows = runStatement([
      { at: '2026-09-03', kind: 'payment' as const, debitCents: 0, creditCents: 5000 },
      { at: '2026-09-01', kind: 'received' as const, debitCents: 20000, creditCents: 0 },
      { at: '2026-09-10', kind: 'received' as const, debitCents: 3000, creditCents: 0 },
    ]);
    expect(rows.map((r) => r.balanceCents)).toEqual([20000, 15000, 18000]);
    expect(rows.map((r) => r.at)).toEqual(['2026-09-01', '2026-09-03', '2026-09-10']);
  });

  it('an advance payment shows as a negative balance: the supplier owes us goods', () => {
    const rows = runStatement([{ at: '2026-09-01', kind: 'payment' as const, debitCents: 0, creditCents: 7000 }]);
    expect(rows[0]?.balanceCents).toBe(-7000);
  });
});
