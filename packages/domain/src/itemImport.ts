/**
 * Importing items from a spreadsheet: reading the rows, grouping them into
 * items with their packs, and saying precisely what is wrong with any row.
 *
 * One row is one pack. Rows with the same SKU — or, where the SKU is blank,
 * the same item name — are one item. Only the item name, the pack and the
 * units in the pack are needed; everything else has a sensible default.
 *
 * Column headings are matched loosely (case, spaces and common alternatives),
 * because people rename them: "Item name", "Name" and "Description" all work.
 */

import { DomainError } from './errors.js';

export class InvalidItemImport extends DomainError {
  constructor(message: string) {
    super('INVALID_ITEM_IMPORT', message);
  }
}

export interface ImportPack {
  row: number;
  label: string;
  qtyBase: number;
  barcode: string | null;
  symbology: 'ean13' | 'ean8' | 'upca' | 'internal';
  sellPrice: number | null;
  isDefaultSell: boolean;
  isDefaultBuy: boolean;
  /** What one of this pack cost (up to 4 decimals), for the opening stock. */
  cost: number | null;
  /** How many of this pack are on the shelf now, for the opening stock. */
  stock: number | null;
}

export interface ImportItem {
  /** The grouping key: the SKU, or the name when there is no SKU. */
  key: string;
  sku: string | null;
  name: string;
  category: string | null;
  baseUom: string;
  isWeighed: boolean;
  rows: number[];
  packs: ImportPack[];
}

export interface ImportProblem {
  row: number;
  column: string | null;
  message: string;
}

export interface ParsedImport {
  items: ImportItem[];
  /** Rows (1-based, as in the spreadsheet, the heading being row 1) that cannot be imported, and why. */
  problems: ImportProblem[];
  /** Columns found, mapped to what they were understood as. Unrecognised headings are listed so the user sees them ignored. */
  columns: { heading: string; field: Field | null }[];
}

export type Field =
  | 'sku'
  | 'name'
  | 'category'
  | 'baseUom'
  | 'isWeighed'
  | 'pack'
  | 'qtyBase'
  | 'barcode'
  | 'sellPrice'
  | 'isDefaultSell'
  | 'isDefaultBuy'
  | 'cost'
  | 'stock';

/** The template's headings, in order, with what each means. */
export const IMPORT_COLUMNS: { field: Field; heading: string; required: boolean; help: string; example: string }[] = [
  { field: 'sku', heading: 'SKU', required: false, help: 'Your code for the item. Rows with the same SKU are one item. Leave blank to have one made.', example: 'SUG2' },
  { field: 'name', heading: 'Item name', required: true, help: 'The item as customers know it, without the pack.', example: 'White sugar 2kg' },
  { field: 'category', heading: 'Category', required: false, help: 'A category that does not exist yet is created.', example: 'Groceries' },
  { field: 'baseUom', heading: 'Base unit', required: false, help: 'The unit stock is counted in: each, kg, litre, box. Default: each.', example: 'each' },
  { field: 'isWeighed', heading: 'Weighed', required: false, help: 'yes if sold by weight (quantities with decimals). Default: no.', example: 'no' },
  { field: 'pack', heading: 'Pack', required: true, help: 'How it is sold or bought: single, bale of 10, case of 24.', example: 'single' },
  { field: 'qtyBase', heading: 'Units in pack', required: true, help: 'How many base units are in this pack: 1 for a single, 10 for a bale of 10.', example: '1' },
  { field: 'barcode', heading: 'Barcode', required: false, help: 'The barcode on this pack (8, 12 or 13 digits, or your own code). One barcode belongs to one pack only.', example: '6001234567890' },
  { field: 'sellPrice', heading: 'Selling price', required: false, help: 'What this pack sells for. Needs price access; otherwise left for later.', example: '2.85' },
  { field: 'isDefaultSell', heading: 'Sell this pack', required: false, help: 'yes for the pack the till sells by default. Default: the smallest pack.', example: 'yes' },
  { field: 'isDefaultBuy', heading: 'Buy this pack', required: false, help: 'yes for the pack you order from suppliers. Default: the largest pack.', example: 'no' },
  { field: 'cost', heading: 'Cost price', required: false, help: 'What one of this pack cost you (up to 4 decimals). Used with Stock on hand.', example: '2.10' },
  { field: 'stock', heading: 'Stock on hand', required: false, help: 'How many of this pack are on the shelf now, at the branch you choose when importing. Give it on one pack row per item.', example: '24' },
];

const ALIASES: Record<Field, string[]> = {
  sku: ['sku', 'code', 'itemcode', 'productcode', 'stockcode', 'plu'],
  name: ['itemname', 'name', 'productname', 'description', 'item', 'product'],
  category: ['category', 'department', 'group', 'dept'],
  baseUom: ['baseunit', 'unit', 'uom', 'unitofmeasure'],
  isWeighed: ['weighed', 'soldbyweight', 'byweight', 'weight'],
  pack: ['pack', 'packsize', 'packlabel', 'packaging', 'packname'],
  qtyBase: ['unitsinpack', 'units', 'packqty', 'qty', 'quantity', 'unitsperpack', 'packquantity'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  sellPrice: ['sellingprice', 'price', 'sellprice', 'retailprice', 'retail'],
  isDefaultSell: ['sellthispack', 'defaultsell', 'sell', 'sellingpack'],
  isDefaultBuy: ['buythispack', 'defaultbuy', 'buy', 'buyingpack', 'orderpack'],
  cost: ['costprice', 'cost', 'unitcost', 'buyingprice', 'purchaseprice', 'costperpack'],
  stock: ['stockonhand', 'stock', 'onhand', 'qtyonhand', 'quantityonhand', 'openingstock', 'instock', 'soh'],
};

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function fieldFor(heading: string): Field | null {
  const h = squash(heading);
  for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) if (names.includes(h)) return field;
  return null;
}

function yesNo(v: string): boolean | null | 'bad' {
  const t = v.trim().toLowerCase();
  if (t === '') return null;
  if (['yes', 'y', 'true', '1', 'x'].includes(t)) return true;
  if (['no', 'n', 'false', '0'].includes(t)) return false;
  return 'bad';
}

function money(v: string): number | null | 'bad' {
  const s = v.trim().replace(/^\$|^US\$|^USD\s*/i, '').replace(/,/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 'bad';
  return Number(s);
}

function cost4(v: string): number | null | 'bad' {
  const t = v.trim().replace(/^\$|^US\$|^USD\s*/i, '').replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return 'bad';
  return Number(t);
}

export function barcodeType(code: string): ImportPack['symbology'] {
  if (/^\d{13}$/.test(code)) return 'ean13';
  if (/^\d{8}$/.test(code)) return 'ean8';
  if (/^\d{12}$/.test(code)) return 'upca';
  return 'internal';
}

/**
 * Rows as read from the file: each an object of heading → text. Excel numbers
 * arrive as text already (the reader keeps barcodes from turning into 6.0E+12).
 */
export function parseItemRows(rows: Record<string, string>[], headings: string[]): ParsedImport {
  const columns = headings.map((h) => ({ heading: h, field: fieldFor(h) }));
  const byField = new Map<Field, string>();
  for (const c of columns) if (c.field !== null && !byField.has(c.field)) byField.set(c.field, c.heading);
  const problems: ImportProblem[] = [];
  const missing = IMPORT_COLUMNS.filter((c) => c.required && !byField.has(c.field) && !(c.field === 'pack' && byField.has('qtyBase')));
  if (missing.length > 0) {
    problems.push({ row: 1, column: null, message: `The heading row needs: ${missing.map((m) => m.heading).join(', ')}.` });
    return { items: [], problems, columns };
  }
  const get = (r: Record<string, string>, f: Field): string => {
    const h = byField.get(f);
    return h === undefined ? '' : String(r[h] ?? '').trim();
  };

  const items = new Map<string, ImportItem>();
  const badRows = new Set<number>();
  /** Items with any bad row: never created with a pack missing. */
  const badKeys = new Map<string, number>();
  const barcodes = new Map<string, number>();

  rows.forEach((r, i) => {
    const row = i + 2; // the heading is row 1
    if (Object.values(r).every((v) => String(v ?? '').trim() === '')) return;
    const err = (column: Field | null, message: string) => {
      problems.push({ row, column: column === null ? null : (byField.get(column) ?? IMPORT_COLUMNS.find((c) => c.field === column)!.heading), message });
      badRows.add(row);
    };

    const sku = get(r, 'sku');
    const name = get(r, 'name');
    const packLabel = get(r, 'pack') || (get(r, 'qtyBase') === '1' || get(r, 'qtyBase') === '' ? 'single' : '');
    const qtyText = get(r, 'qtyBase') || '1';
    const qty = Number(qtyText.replace(',', '.'));
    const barcode = get(r, 'barcode').replace(/\s/g, '');
    const price = money(get(r, 'sellPrice'));
    const weighed = yesNo(get(r, 'isWeighed'));
    const dSell = yesNo(get(r, 'isDefaultSell'));
    const dBuy = yesNo(get(r, 'isDefaultBuy'));
    const costV = cost4(get(r, 'cost'));
    const stockText = get(r, 'stock').replace(',', '.');
    const stockV = stockText === '' ? null : Number(stockText);

    if (name === '') err('name', 'The item name is missing.');
    else if (name.length > 200) err('name', 'The item name is longer than 200 characters.');
    if (sku.length > 64) err('sku', 'The SKU is longer than 64 characters.');
    if (packLabel === '') err('pack', 'Say what the pack is (e.g. single, bale of 10).');
    if (!Number.isFinite(qty) || qty <= 0) err('qtyBase', `"${qtyText}" is not a number of units above zero.`);
    if (barcode !== '' && (barcode.length > 32 || /^-/.test(barcode))) err('barcode', 'That is not a barcode.');
    if (barcode !== '' && /e\+/i.test(barcode)) err('barcode', 'The barcode was turned into a number by Excel (like 6.0E+12). Format the column as Text and type it again.');
    if (price === 'bad') err('sellPrice', `"${get(r, 'sellPrice')}" is not a price (up to two decimals).`);
    if (weighed === 'bad') err('isWeighed', 'Answer yes or no.');
    if (dSell === 'bad') err('isDefaultSell', 'Answer yes or no.');
    if (dBuy === 'bad') err('isDefaultBuy', 'Answer yes or no.');
    if (costV === 'bad') err('cost', `"${get(r, 'cost')}" is not a cost (up to four decimals).`);
    if (stockV !== null && (!Number.isFinite(stockV) || stockV < 0)) err('stock', `"${get(r, 'stock')}" is not a quantity of zero or more.`);
    if (barcode !== '') {
      const first = barcodes.get(barcode);
      if (first !== undefined) err('barcode', `The same barcode as row ${first}: a barcode belongs to one pack only.`);
      else barcodes.set(barcode, row);
    }
    const key = sku !== '' ? `sku:${sku.toLowerCase()}` : `name:${name.toLowerCase()}`;
    if (badRows.has(row)) {
      if (!badKeys.has(key)) badKeys.set(key, row);
      return;
    }
    let item = items.get(key);
    const category = get(r, 'category') || null;
    const baseUom = (get(r, 'baseUom') || 'each').toLowerCase().slice(0, 16);
    if (item === undefined) {
      item = { key, sku: sku || null, name, category, baseUom, isWeighed: weighed === true, rows: [], packs: [] };
      items.set(key, item);
    } else {
      // Rows of one item must agree about the item.
      const clash =
        item.name.toLowerCase() !== name.toLowerCase()
          ? (['name', `Same SKU as row ${item.rows[0]}, but a different name ("${item.name}").`] as const)
          : category !== null && item.category !== null && item.category.toLowerCase() !== category.toLowerCase()
            ? (['category', `Same item as row ${item.rows[0]}, but a different category.`] as const)
            : item.packs.some((p) => p.label.toLowerCase() === packLabel.toLowerCase())
              ? (['pack', `The item already has a pack called "${packLabel}".`] as const)
              : null;
      if (clash !== null) {
        err(clash[0], clash[1]);
        if (!badKeys.has(key)) badKeys.set(key, row);
        return;
      }
      if (item.category === null) item.category = category;
    }
    item.rows.push(row);
    item.packs.push({
      row, label: packLabel, qtyBase: qty, barcode: barcode || null, symbology: barcodeType(barcode),
      sellPrice: price === null || price === 'bad' ? null : price, isDefaultSell: dSell === true, isDefaultBuy: dBuy === true,
      cost: costV === null || costV === 'bad' ? null : costV, stock: stockV === null || stockV === 0 ? null : stockV,
    });
  });

  // Each item sells and buys by exactly one pack: marked, or the smallest / largest.
  const out: ImportItem[] = [];
  for (const item of items.values()) {
    const bad = badKeys.get(item.key);
    if (bad !== undefined) {
      problems.push({ row: item.rows[0]!, column: null, message: `${item.name} is held back until row ${bad} is put right, so it is not created with a pack missing.` });
      continue;
    }
    const sells = item.packs.filter((p) => p.isDefaultSell);
    const buys = item.packs.filter((p) => p.isDefaultBuy);
    if (sells.length > 1 || buys.length > 1) {
      const which = sells.length > 1 ? 'sell' : 'buy';
      problems.push({ row: item.rows[0]!, column: which === 'sell' ? 'Sell this pack' : 'Buy this pack', message: `${item.name} is marked to ${which} by more than one pack: mark one.` });
      continue;
    }
    const stocked = item.packs.filter((p) => p.stock !== null);
    if (stocked.length > 1) {
      problems.push({ row: stocked[1]!.row, column: 'Stock on hand', message: `Give ${item.name}'s stock on one pack row only (e.g. 12 on the bale row, not bales and singles).` });
      continue;
    }
    const bySize = [...item.packs].sort((x, y) => x.qtyBase - y.qtyBase);
    if (sells.length === 0) bySize[0]!.isDefaultSell = true;
    if (buys.length === 0) bySize[bySize.length - 1]!.isDefaultBuy = true;
    out.push(item);
  }
  return { items: out, problems: problems.sort((x, y) => x.row - y.row), columns };
}
