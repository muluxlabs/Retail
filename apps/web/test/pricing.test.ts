import { describe, expect, it } from 'vitest';

import { bulkPrice, marginPercent } from '../src/lib/pricing.js';

describe('bulk pricing', () => {
  it('a flat set is used as typed, in whole cents', () => {
    expect(bulkPrice('set', 2.5, 0.05, { current: null, cost: null })).toBe(2.5);
    expect(bulkPrice('set', 0, 0.05, { current: 3, cost: 1 })).toBe(0);
  });

  it('a percentage change rounds to the nearest step and skips unpriced items', () => {
    expect(bulkPrice('percent', 10, 0.05, { current: 2.0, cost: 1 })).toBe(2.2);
    expect(bulkPrice('percent', 5, 0.05, { current: 1.99, cost: 1 })).toBe(2.1); // 2.0895 -> 2.09 -> nearest 0.05 = 2.10
    expect(bulkPrice('percent', -10, 0.01, { current: 1.99, cost: 1 })).toBe(1.79); // 1.791
    expect(bulkPrice('percent', 10, 0.05, { current: null, cost: 1 })).toBeNull();
  });

  it('cost plus markup rounds UP so the margin is never short, and skips items with no cost', () => {
    expect(bulkPrice('markup', 30, 0.05, { current: null, cost: 1 })).toBe(1.3);
    expect(bulkPrice('markup', 32, 0.05, { current: null, cost: 1 })).toBe(1.35); // 1.32 -> up to 1.35
    expect(bulkPrice('markup', 30, 0.01, { current: null, cost: 0.99 })).toBe(1.29); // 1.287 -> 1.29
    expect(bulkPrice('markup', 30, 0.05, { current: 5, cost: null })).toBeNull();
    expect(bulkPrice('markup', 30, 0.05, { current: 5, cost: 0 })).toBeNull();
  });

  it('never produces a negative price', () => {
    expect(bulkPrice('percent', -150, 0.05, { current: 2, cost: 1 })).toBeNull();
  });

  it('margin is on the selling price', () => {
    expect(marginPercent(2, 1.5)).toBeCloseTo(25);
    expect(marginPercent(1, 1.5)).toBeCloseTo(-50);
    expect(marginPercent(null, 1)).toBeNull();
    expect(marginPercent(2, null)).toBeNull();
  });
});
