import { describe, expect, it } from 'vitest';

import { barcodeType, fieldFor, IMPORT_COLUMNS, parseItemRows } from '../src/index.js';

const H = IMPORT_COLUMNS.map((c) => c.heading);
const row = (v: Partial<Record<string, string>>): Record<string, string> => Object.fromEntries(H.map((h) => [h, v[h] ?? '']));

describe('reading an item spreadsheet', () => {
  it('groups rows with the same SKU into one item with several packs, and picks default packs', () => {
    const r = parseItemRows(
      [
        row({ SKU: 'SUG2', 'Item name': 'White sugar 2kg', Category: 'Groceries', Pack: 'single', 'Units in pack': '1', Barcode: '6001234567890', 'Selling price': '2.85' }),
        row({ SKU: 'SUG2', 'Item name': 'White sugar 2kg', Pack: 'bale of 10', 'Units in pack': '10', Barcode: '6001234567906', 'Selling price': '27.50' }),
      ],
      H,
    );
    expect(r.problems).toEqual([]);
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it).toMatchObject({ sku: 'SUG2', name: 'White sugar 2kg', category: 'Groceries', baseUom: 'each', isWeighed: false });
    expect(it.packs.map((p) => [p.label, p.qtyBase, p.isDefaultSell, p.isDefaultBuy])).toEqual([
      ['single', 1, true, false],
      ['bale of 10', 10, false, true],
    ]);
  });

  it('groups by name when there is no SKU, and fills in a single pack', () => {
    const r = parseItemRows([row({ 'Item name': 'Bread loaf', 'Units in pack': '' })], H);
    expect(r.problems).toEqual([]);
    expect(r.items[0]).toMatchObject({ sku: null, name: 'Bread loaf' });
    expect(r.items[0]!.packs[0]).toMatchObject({ label: 'single', qtyBase: 1, isDefaultSell: true, isDefaultBuy: true });
  });

  it('says exactly which row and column is wrong', () => {
    const r = parseItemRows(
      [
        row({ 'Item name': '', Pack: 'single', 'Units in pack': '1' }),
        row({ 'Item name': 'Milk', Pack: 'single', 'Units in pack': 'two' }),
        row({ 'Item name': 'Rice', Pack: 'single', 'Units in pack': '1', 'Selling price': '1.234' }),
        row({ 'Item name': 'Oil', Pack: 'single', 'Units in pack': '1', Weighed: 'maybe' }),
        row({ 'Item name': 'Salt', Pack: 'single', 'Units in pack': '1', Barcode: '6.00123E+12' }),
      ],
      H,
    );
    expect(r.items).toEqual([]);
    expect(r.problems.map((p) => [p.row, p.column])).toEqual([
      [2, 'Item name'],
      [3, 'Units in pack'],
      [4, 'Selling price'],
      [5, 'Weighed'],
      [6, 'Barcode'],
    ]);
    expect(r.problems[4]!.message).toContain('Format the column as Text');
  });

  it('refuses the same barcode twice, and holds back the whole item rather than create it with a pack missing', () => {
    const r = parseItemRows(
      [
        row({ SKU: 'A', 'Item name': 'Tea', Pack: 'single', 'Units in pack': '1', Barcode: '6001111111111' }),
        row({ SKU: 'A', 'Item name': 'Tea', Pack: 'box of 6', 'Units in pack': '6', Barcode: '6001111111111' }),
        row({ SKU: 'B', 'Item name': 'Jam', Pack: 'single', 'Units in pack': '1' }),
      ],
      H,
    );
    expect(r.items.map((i) => i.sku)).toEqual(['B']);
    expect(r.problems.some((p) => p.row === 3 && p.message.includes('same barcode as row 2'))).toBe(true);
    expect(r.problems.some((p) => p.row === 2 && p.message.includes('held back'))).toBe(true);
  });

  it('refuses rows of one SKU that disagree, and two packs marked to sell', () => {
    const r = parseItemRows(
      [
        row({ SKU: 'X', 'Item name': 'Soap', Pack: 'single', 'Units in pack': '1', 'Sell this pack': 'yes' }),
        row({ SKU: 'X', 'Item name': 'Soap bar', Pack: 'box', 'Units in pack': '12' }),
        row({ SKU: 'Y', 'Item name': 'Candle', Pack: 'single', 'Units in pack': '1', 'Sell this pack': 'yes' }),
        row({ SKU: 'Y', 'Item name': 'Candle', Pack: 'pack of 6', 'Units in pack': '6', 'Sell this pack': 'yes' }),
      ],
      H,
    );
    expect(r.items).toEqual([]);
    expect(r.problems.some((p) => p.row === 3 && p.message.includes('different name'))).toBe(true);
    expect(r.problems.some((p) => p.message.includes('more than one pack'))).toBe(true);
  });

  it('understands the headings people actually use', () => {
    expect(fieldFor('Description')).toBe('name');
    expect(fieldFor(' Item Code ')).toBe('sku');
    expect(fieldFor('EAN')).toBe('barcode');
    expect(fieldFor('Retail Price')).toBe('sellPrice');
    expect(fieldFor('Colour')).toBeNull();
    const r = parseItemRows([{ Code: 'Z1', Description: 'Maize meal 10kg', Qty: '1', Price: '$7.25', Colour: 'white' }], ['Code', 'Description', 'Qty', 'Price', 'Colour']);
    expect(r.problems).toEqual([]);
    expect(r.items[0]).toMatchObject({ sku: 'Z1', name: 'Maize meal 10kg' });
    expect(r.items[0]!.packs[0]!.sellPrice).toBe(7.25);
    expect(r.columns.find((c) => c.heading === 'Colour')!.field).toBeNull();
  });

  it('says which headings are missing', () => {
    const r = parseItemRows([{ Colour: 'red' }], ['Colour']);
    expect(r.problems[0]).toMatchObject({ row: 1 });
    expect(r.problems[0]!.message).toContain('Item name');
  });

  it('refuses numbers too large to be real, by row and column (a value in the wrong column)', () => {
    const r = parseItemRows(
      [
        row({ 'Item name': 'A', Pack: 'single', 'Units in pack': '6001234567890' }),
        row({ 'Item name': 'B', Pack: 'single', 'Units in pack': '1', 'Selling price': '6001234567890' }),
        row({ 'Item name': 'C', Pack: 'single', 'Units in pack': '1', 'Cost price': '99999999999' }),
        row({ 'Item name': 'D', Pack: 'single', 'Units in pack': '1', 'Stock on hand': '6001234567890' }),
        row({ 'Item name': 'E', Pack: 'case', 'Units in pack': '100000', 'Selling price': '10000000', 'Stock on hand': '10000000' }),
      ],
      H,
    );
    expect(r.problems.map((p) => [p.row, p.column])).toEqual([
      [2, 'Units in pack'],
      [3, 'Selling price'],
      [4, 'Cost price'],
      [5, 'Stock on hand'],
    ]);
    expect(r.items.map((i) => i.name)).toEqual(['E']);
  });

  it('knows barcode types', () => {
    expect(barcodeType('6001234567890')).toBe('ean13');
    expect(barcodeType('60012345')).toBe('ean8');
    expect(barcodeType('012345678905')).toBe('upca');
    expect(barcodeType('SHELF-12')).toBe('internal');
  });

  it('skips blank rows', () => {
    const r = parseItemRows([row({}), row({ 'Item name': 'Eggs', Pack: 'tray of 30', 'Units in pack': '30' })], H);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.rows).toEqual([3]);
  });
});
