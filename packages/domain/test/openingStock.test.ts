import { describe, expect, it } from 'vitest';

import { checkOpeningLines, InvalidOpeningStock, OpeningStockNotEmpty } from '../src/index.js';

describe('opening stock lines', () => {
  const a = '00000000-0000-4000-8000-00000000000a';
  const b = '00000000-0000-4000-8000-00000000000b';

  it('accepts lines with and without a known cost', () => {
    expect(() => checkOpeningLines([{ productId: a, qtyPacks: 10, unitCost: 1.25 }, { productId: b, qtyPacks: 2.5, unitCost: null }])).not.toThrow();
  });

  it('refuses an empty document, a repeated item, a zero quantity and a negative cost', () => {
    expect(() => checkOpeningLines([])).toThrow(InvalidOpeningStock);
    expect(() => checkOpeningLines([{ productId: a, qtyPacks: 1, unitCost: 1 }, { productId: a, qtyPacks: 2, unitCost: 1 }])).toThrow(/twice/);
    expect(() => checkOpeningLines([{ productId: a, qtyPacks: 0, unitCost: 1 }])).toThrow(/above zero/);
    expect(() => checkOpeningLines([{ productId: a, qtyPacks: 1, unitCost: -1 }])).toThrow(/zero or more/);
  });

  it('names the items that already have stock', () => {
    const e = new OpeningStockNotEmpty([{ productId: a, name: 'Sugar 2kg', onHand: 12 }]);
    expect(e.code).toBe('OPENING_STOCK_NOT_EMPTY');
    expect(e.message).toContain('Sugar 2kg (12 on hand)');
    expect(e.message).toContain('stock take');
  });
});
