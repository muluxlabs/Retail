import { describe, expect, it } from 'vitest';

import { marginPercent, parseCostMicro, parsePriceList, suggestedPrice } from '../src/index.js';

describe('reading a pasted price list', () => {
  it('reads spreadsheet rows (tabs): code first, the last number is the cost', () => {
    const r = parsePriceList('Code\tDescription\tPrice\nAB-100\tCooking oil 2L x 12\t54.60\n6001234567890\tSugar 2kg\t$2.3750\n');
    expect(r).toEqual([
      { row: 2, code: 'AB-100', description: 'Cooking oil 2L x 12', costMicro: 546_000, problem: null },
      { row: 3, code: '6001234567890', description: 'Sugar 2kg', costMicro: 23_750, problem: null },
    ]);
  });

  it('reads CSV with quoted cells and thousands separators', () => {
    const r = parsePriceList('X1,"Rice, long grain 10kg","1,234.50"');
    expect(r[0]).toMatchObject({ code: 'X1', description: 'Rice, long grain 10kg', costMicro: 12_345_000, problem: null });
  });

  it('reads a list typed with spaces: first word is the code', () => {
    expect(parsePriceList('SKU-9 Maize meal 10kg 7.25')[0]).toMatchObject({ code: 'SKU-9', description: 'Maize meal 10kg', costMicro: 72_500 });
  });

  it('flags lines with no price, a zero price, or more than four decimals', () => {
    const r = parsePriceList('A1\tBread\nA2\tMilk\t0\nA3\tEggs\t1.23456\n');
    expect(r.map((l) => l.problem)).toEqual(['No price found on this line', 'A price of zero', 'No price found on this line']);
  });

  it('parses money strictly', () => {
    expect(parseCostMicro('12')).toBe(120_000);
    expect(parseCostMicro('US$0.5')).toBe(5_000);
    expect(parseCostMicro('1.2.3')).toBeNull();
    expect(parseCostMicro('-4')).toBeNull();
  });
});

describe('the price a new cost suggests', () => {
  it('keep margin: price moves with the cost, rounded up to the step', () => {
    // cost 10.00 -> 11.00 (+10%): price 15.00 -> 16.50
    expect(suggestedPrice({ newCostMicro: 110_000, oldCostMicro: 100_000, currentSellCents: 1_500 }, { mode: 'keep_margin', roundToCents: 5 })).toBe(1_650);
    // 1.2345 -> 1.3000: 2.00 * 1.3/1.2345 = 2.1061... -> 2.15
    expect(suggestedPrice({ newCostMicro: 13_000, oldCostMicro: 12_345, currentSellCents: 200 }, { mode: 'keep_margin', roundToCents: 5 })).toBe(215);
  });

  it('keep margin keeps the margin percentage (never lower)', () => {
    const before = marginPercent(1_500, 100_000)!;
    const p = suggestedPrice({ newCostMicro: 123_400, oldCostMicro: 100_000, currentSellCents: 1_500 }, { mode: 'keep_margin', roundToCents: 1 })!;
    expect(marginPercent(p, 123_400)!).toBeGreaterThanOrEqual(before);
  });

  it('keep margin cannot work without an old cost or a price: it suggests nothing', () => {
    expect(suggestedPrice({ newCostMicro: 10_000, oldCostMicro: null, currentSellCents: 150 }, { mode: 'keep_margin', roundToCents: 5 })).toBeNull();
    expect(suggestedPrice({ newCostMicro: 10_000, oldCostMicro: 9_000, currentSellCents: null }, { mode: 'keep_margin', roundToCents: 5 })).toBeNull();
  });

  it('markup: cost plus a percentage, rounded up, without float drift', () => {
    expect(suggestedPrice({ newCostMicro: 100_000, oldCostMicro: null, currentSellCents: null }, { mode: 'markup', markupPercent: 25, roundToCents: 5 })).toBe(1_250);
    // 1.10 * 1.10 = 1.2100000000000002 in floating point: must be 1.21, not 1.22.
    expect(suggestedPrice({ newCostMicro: 11_000, oldCostMicro: null, currentSellCents: null }, { mode: 'markup', markupPercent: 10, roundToCents: 1 })).toBe(121);
  });

  it('costs only leaves prices alone', () => {
    expect(suggestedPrice({ newCostMicro: 11_000, oldCostMicro: 10_000, currentSellCents: 150 }, { mode: 'costs_only' })).toBeNull();
  });

  it('margin is on the selling price', () => {
    expect(marginPercent(1_000, 75_000)).toBe(25);
    expect(marginPercent(null, 75_000)).toBeNull();
  });
});
