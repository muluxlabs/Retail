import { describe, expect, it } from 'vitest';

import { InvalidDayClose, receiptNumber, reconcileTills } from '../src/index.js';

const tills = [
  { id: 't1', name: 'Till 1', expectedCents: 45_020 },
  { id: 't2', name: 'Till 2', expectedCents: 12_000 },
];

describe('closing the day: counting the tills', () => {
  it('works out over and short per till, in cents', () => {
    const r = reconcileTills(tills, [
      { cashPointId: 't1', countedCents: 45_000 },
      { cashPointId: 't2', countedCents: 12_050 },
    ]);
    expect(r.map((t) => [t.id, t.varianceCents])).toEqual([
      ['t1', -20],
      ['t2', 50],
    ]);
  });

  it('refuses a close with a till left uncounted, naming it', () => {
    expect(() => reconcileTills(tills, [{ cashPointId: 't1', countedCents: 45_020 }])).toThrow(/Till 2 not counted/);
  });

  it('refuses a count for something that is not a till here, a till counted twice, and a bad amount', () => {
    const all = [{ cashPointId: 't1', countedCents: 1 }, { cashPointId: 't2', countedCents: 1 }];
    expect(() => reconcileTills(tills, [...all, { cashPointId: 'safe', countedCents: 1 }])).toThrow(InvalidDayClose);
    expect(() => reconcileTills(tills, [...all, { cashPointId: 't1', countedCents: 1 }])).toThrow(/twice/);
    expect(() => reconcileTills(tills, [{ cashPointId: 't1', countedCents: -1 }, { cashPointId: 't2', countedCents: 0 }])).toThrow(/zero or more/);
    expect(() => reconcileTills(tills, [{ cashPointId: 't1', countedCents: 1.5 }, { cashPointId: 't2', countedCents: 0 }])).toThrow(/whole cents/);
  });

  it('a branch with no tills closes with nothing to count', () => {
    expect(reconcileTills([], [])).toEqual([]);
  });

  it('reads the number off the end of a receipt number', () => {
    expect(receiptNumber('KANA-000123')).toBe(123);
    expect(receiptNumber('HRE-1')).toBe(1);
    expect(() => receiptNumber('KANA-')).toThrow(InvalidDayClose);
  });
});
