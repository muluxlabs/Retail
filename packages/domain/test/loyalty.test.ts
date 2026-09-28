import { describe, expect, it } from 'vitest';

import { InvalidLoyalty, NotEnoughPoints, pointsEarned, pointsFor, pointsWorthCents } from '../src/index.js';

const oneForDollar = { pointsPerDollar: 1, pointValueCents: 1 };

describe('points earned on a sale', () => {
  it('is one point per whole dollar, rounded down', () => {
    expect(pointsEarned(1_999, oneForDollar)).toBe(19);
    expect(pointsEarned(2_000, oneForDollar)).toBe(20);
    expect(pointsEarned(99, oneForDollar)).toBe(0);
  });

  it('follows a fractional rate without floating-point drift', () => {
    expect(pointsEarned(1_000, { pointsPerDollar: 0.5, pointValueCents: 1 })).toBe(5);
    expect(pointsEarned(1_000, { pointsPerDollar: 2.5, pointValueCents: 1 })).toBe(25);
    // 0.1 * 30 is 2.9999999999999996 in floating point: must still be 3.
    expect(pointsEarned(3_000, { pointsPerDollar: 0.1, pointValueCents: 1 })).toBe(3);
  });

  it('earns nothing on nothing, or with earning switched to zero', () => {
    expect(pointsEarned(0, oneForDollar)).toBe(0);
    expect(pointsEarned(-500, oneForDollar)).toBe(0);
    expect(pointsEarned(5_000, { pointsPerDollar: 0, pointValueCents: 1 })).toBe(0);
  });
});

describe('paying with points', () => {
  it('needs one point per cent when a point is worth a cent', () => {
    expect(pointsFor(250, oneForDollar)).toBe(250);
  });

  it('refuses an amount that is not a whole number of points', () => {
    const fiveCents = { pointsPerDollar: 1, pointValueCents: 5 };
    expect(pointsFor(100, fiveCents)).toBe(20);
    expect(() => pointsFor(102, fiveCents)).toThrow(InvalidLoyalty);
    expect(() => pointsFor(0, fiveCents)).toThrow(InvalidLoyalty);
  });

  it('says what a balance is worth', () => {
    expect(pointsWorthCents(340, { pointsPerDollar: 1, pointValueCents: 5 })).toBe(1_700);
    expect(pointsWorthCents(-3, oneForDollar)).toBe(0);
  });

  it('names the customer and the shortfall', () => {
    expect(new NotEnoughPoints('Rudo Moyo', 1_200, 1_500).message).toBe('Rudo Moyo has 1,200 points; this needs 1,500.');
  });
});
