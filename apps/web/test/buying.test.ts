import { describe, expect, it } from 'vitest';

import { packCost } from '../src/lib/buying.js';

describe('a price per pack is shown as agreed', () => {
  it('keeps at least two decimals and up to four, never rounding a real price away', () => {
    expect(packCost(13.5)).toBe('$13.50');
    expect(packCost(0.335)).toBe('$0.335');
    expect(packCost(0.3333)).toBe('$0.3333');
    expect(packCost(2)).toBe('$2.00');
    expect(packCost(1234.5)).toBe('$1,234.50');
    expect(packCost(0.34)).toBe('$0.34');
    expect(packCost(null)).toBe('—');
  });
});
