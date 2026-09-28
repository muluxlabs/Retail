import { describe, expect, it } from 'vitest';

import { parsePasted } from '../src/lib/openingPaste.js';

describe('pasting an opening stock list', () => {
  it('reads tab-separated rows as Excel copies them, and skips a heading', () => {
    const rows = parsePasted('SKU\tQty\tCost\nSUGAR-2KG\t120\t1.85\nSALT-1KG\t48\t0.62\n');
    expect(rows).toEqual([
      { line: 2, code: 'SUGAR-2KG', qty: 120, cost: 1.85, problem: null },
      { line: 3, code: 'SALT-1KG', qty: 48, cost: 0.62, problem: null },
    ]);
  });

  it('accepts commas or semicolons, a missing cost, and a $ sign', () => {
    const rows = parsePasted('6001234567890, 12\nMAIZE-10KG;5;$8.20');
    expect(rows[0]).toMatchObject({ code: '6001234567890', qty: 12, cost: null, problem: null });
    expect(rows[1]).toMatchObject({ code: 'MAIZE-10KG', qty: 5, cost: 8.2, problem: null });
  });

  it('reads 1,250 in a tab-separated row as one thousand two hundred and fifty', () => {
    expect(parsePasted('A\t1,250\t0.5')[0]).toMatchObject({ qty: 1250, cost: 0.5 });
  });

  it('points at the line of every problem', () => {
    const rows = parsePasted('A\t10\t1\nB\tlots\t1\n\nC\t0\nD\t3\tcheap\nE\t2\t0.123456');
    expect(rows.map((r) => [r.line, r.problem])).toEqual([
      [1, null],
      [2, 'Quantity must be a number above zero'],
      [4, 'Quantity must be a number above zero'],
      [5, 'Cost is not a number'],
      [6, 'Cost has more than four decimal places'],
    ]);
  });
});
