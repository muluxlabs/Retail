import { describe, expect, it } from 'vitest';

import { LOOK_ALIKE, nameIndex, nameSimilarity, normaliseName } from '../src/index.js';

describe('the standard form of an item name', () => {
  it('ignores case, punctuation and spacing, and writes units one way', () => {
    expect(normaliseName('Coca-Cola  500 ML')).toBe('coca cola 500ml');
    expect(normaliseName('COCA COLA 500ml')).toBe('coca cola 500ml');
    expect(normaliseName('Cooking Oil 2 Litres')).toBe('cooking oil 2l');
    expect(normaliseName('Sugar 2.0 kgs')).toBe('sugar 2kg');
    expect(normaliseName("Mazoe Orange & Lemon")).toBe('mazoe orange and lemon');
  });
});

describe('look-alike names', () => {
  it('spots a typo or a small spelling difference', () => {
    expect(nameSimilarity('White sugar 2kg', 'White suger 2kg')).toBeGreaterThanOrEqual(LOOK_ALIKE);
    expect(nameSimilarity('Blue Band margarine 500g', 'Blueband margarine 500 g')).toBeGreaterThanOrEqual(LOOK_ALIKE);
    expect(nameSimilarity('Coca Cola 500ml', 'Coca-Cola 500 ml')).toBe(1);
  });

  it('never calls different sizes the same item', () => {
    expect(nameSimilarity('White sugar 1kg', 'White sugar 2kg')).toBe(0);
    expect(nameSimilarity('Cooking oil 2L', 'Cooking oil 5L')).toBe(0);
    expect(nameSimilarity('Eggs tray of 30', 'Eggs tray of 12')).toBe(0);
  });

  it('keeps different items apart', () => {
    expect(nameSimilarity('White sugar 2kg', 'Brown sugar 2kg')).toBeLessThan(LOOK_ALIKE);
    expect(nameSimilarity('Bread white loaf', 'Bread brown loaf')).toBeLessThan(LOOK_ALIKE);
  });
});

describe('the name index', () => {
  const master = [
    { id: '1', name: 'White sugar 2kg', sku: 'SUG2' },
    { id: '2', name: 'White sugar 1kg', sku: 'SUG1' },
    { id: '3', name: 'Cooking oil 2L', sku: 'OIL2' },
  ];

  it('finds the same name written differently', () => {
    const ix = nameIndex(master);
    expect(ix.same('WHITE SUGAR 2 KG').map((x) => x.sku)).toEqual(['SUG2']);
  });

  it('finds look-alikes, best first, but not other sizes', () => {
    const ix = nameIndex(master);
    const hits = ix.alike('White suger 2kg');
    expect(hits.map((h) => h.item.sku)).toEqual(['SUG2']);
    expect(ix.alike('Cooking oyl 2 litres')[0]!.item.sku).toBe('OIL2');
    expect(ix.alike('Maize meal 10kg')).toEqual([]);
  });

  it('grows as items are added (duplicates within one file)', () => {
    const ix = nameIndex<{ id: string; name: string; sku: string | null }>([]);
    ix.add({ id: 'row-2', name: 'Mazoe orange 2L', sku: null });
    expect(ix.alike('Mazoe ornage 2L')[0]!.item.id).toBe('row-2');
  });

  it('stays quick with a large master', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => ({ id: String(i), name: `Item number ${i} pack ${i % 7}kg`, sku: `S${i}` }));
    const ix = nameIndex(big);
    const t = Date.now();
    for (let i = 0; i < 500; i += 1) ix.alike(`Item nunber ${i} pack ${i % 7}kg`);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});
