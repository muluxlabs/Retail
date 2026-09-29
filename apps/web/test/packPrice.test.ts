import { describe, expect, it } from 'vitest';

import { packPriceNote, packPriceText } from '../src/lib/packPrice.js';

const money = (n: number) => `$${n.toFixed(2)}`;

describe('a pack price against singles', () => {
  it('shows the price per unit and the saving on a bulk pack', () => {
    const note = packPriceNote(10, 3, 4)!;
    expect(note.kind).toBe('saves');
    expect(note.saving).toBe(2);
    expect(packPriceText(note, 3, 'each', money)).toBe('$3.33 a unit · saves $2.00 against 3 singles');
  });

  it('warns when a pack costs more than the same number of singles', () => {
    const note = packPriceNote(13, 3, 4)!;
    expect(note.kind).toBe('dearer');
    expect(packPriceText(note, 3, 'each', money)).toContain('$1.00 MORE than 3 singles');
  });

  it('says so when there is no saving', () => {
    expect(packPriceNote(12, 3, 4)!.kind).toBe('same');
  });

  it('has nothing to compare for a single, or without a single price', () => {
    expect(packPriceNote(4, 1, 4)!.kind).toBe('no-compare');
    expect(packPriceText(packPriceNote(24, 12, null)!, 12, 'each', money)).toBe('$2.00 a unit');
  });

  it('uses the unit for weighed or measured items', () => {
    expect(packPriceText(packPriceNote(9, 5, 2)!, 5, 'kg', money)).toBe('$1.80 per kg · saves $1.00 against 5 kg sold singly');
  });

  it('shows nothing until there is a price', () => {
    expect(packPriceNote(null, 3, 4)).toBeNull();
    expect(packPriceNote(10, 0, 4)).toBeNull();
  });
});
