/**
 * Reading and writing spreadsheets in the browser: Excel (.xlsx) and CSV.
 *
 * Every cell comes back as text, keyed by its column heading. The Excel
 * libraries are loaded only when a file is actually read or a template
 * written, so the rest of the app never downloads them.
 */

export interface Sheet {
  headings: string[];
  rows: Record<string, string>[];
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    // Whole numbers as written (a 13-digit barcode stays 13 digits); prices keep their decimals.
    return Number.isInteger(v) ? v.toFixed(0) : String(Math.round(v * 1e6) / 1e6);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function toSheet(grid: unknown[][]): Sheet {
  const first = grid.findIndex((r) => r.some((c) => cellText(c) !== ''));
  if (first === -1) return { headings: [], rows: [] };
  const raw = grid[first]!.map((c) => cellText(c));
  // Blank or repeated headings still need distinct names.
  const headings = raw.map((h, i) => (h === '' ? `Column ${i + 1}` : raw.indexOf(h) === i ? h : `${h} (${i + 1})`));
  const rows = grid.slice(first + 1).map((r) => Object.fromEntries(headings.map((h, i) => [h, cellText(r[i])])));
  // Trailing blank rows are not rows.
  while (rows.length > 0 && Object.values(rows[rows.length - 1]!).every((v) => v === '')) rows.pop();
  return { headings, rows };
}

/** Split one delimited line, honouring "quoted, cells" and doubled quotes. */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
    } else if (ch === sep && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** CSV, semicolon-separated or tab-separated text (as pasted from a spreadsheet). */
export function parseDelimited(text: string): Sheet {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const head = lines.find((l) => l.trim() !== '') ?? '';
  const sep = head.includes('\t') ? '\t' : (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
  return toSheet(lines.map((l) => splitLine(l, sep)));
}

export async function readSpreadsheet(file: File): Promise<Sheet> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(file);
    // The template's "Items" sheet when there is one (its second sheet is help), else the first.
    const chosen = sheets.find((x) => x.sheet.trim().toLowerCase() === 'items') ?? sheets[0];
    if (chosen === undefined) throw new Error('That Excel file has no sheets.');
    return toSheet(chosen.data as unknown[][]);
  }
  if (name.endsWith('.xls')) throw new Error('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx or CSV, then upload that.');
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) return parseDelimited(await file.text());
  throw new Error('Upload an Excel file (.xlsx) or a CSV file.');
}

/** The columns of the item template, with example rows (a sugar in two packs, and a loaf with one). */
export const IMPORT_TEMPLATE: { heading: string; required: boolean; help: string; examples: string[] }[] = [
  { heading: 'SKU', required: false, help: 'Your code for the item. Rows with the same SKU are one item. Leave blank to have one made.', examples: ['SUG2', 'SUG2', ''] },
  { heading: 'Item name', required: true, help: 'The item as customers know it, without the pack.', examples: ['White sugar 2kg', 'White sugar 2kg', 'Brown bread loaf'] },
  { heading: 'Category', required: false, help: 'A category that does not exist yet is created.', examples: ['Groceries', 'Groceries', 'Bakery'] },
  { heading: 'Base unit', required: false, help: 'The unit stock is counted in: each, kg, litre, box. Default: each.', examples: ['each', 'each', 'each'] },
  { heading: 'Weighed', required: false, help: 'yes if sold by weight (quantities with decimals). Default: no.', examples: ['no', 'no', 'no'] },
  { heading: 'Pack', required: true, help: 'How it is sold or bought: single, bale of 10, case of 24.', examples: ['single', 'bale of 10', 'single'] },
  { heading: 'Units in pack', required: true, help: 'How many base units are in this pack: 1 for a single, 10 for a bale of 10.', examples: ['1', '10', '1'] },
  { heading: 'Barcode', required: false, help: 'The barcode on this pack: 8, 12 or 13 digits, or your own code. One barcode belongs to one pack only.', examples: ['6001234567890', '6001234567906', ''] },
  { heading: 'Selling price', required: false, help: 'What this pack sells for, e.g. 2.85. Needs price access; otherwise left for the Prices screen.', examples: ['2.85', '27.50', '1.10'] },
  { heading: 'Sell this pack', required: false, help: 'yes for the pack the till sells by default. Default: the smallest pack.', examples: ['yes', 'no', ''] },
  { heading: 'Buy this pack', required: false, help: 'yes for the pack you order from suppliers. Default: the largest pack.', examples: ['no', 'yes', ''] },
  { heading: 'Cost price', required: false, help: 'What one of this pack cost you (up to 4 decimals). Goes with Stock on hand.', examples: ['', '24.60', '0.85'] },
  { heading: 'Stock on hand', required: false, help: 'How many of this pack are on the shelf now, at the branch you choose when importing. One pack row per item.', examples: ['', '12', '40'] },
];

/** The Excel template: the Items sheet (headings, examples, every cell text) and a sheet explaining each column. */
export async function writeTemplateXlsx(): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = IMPORT_TEMPLATE.map((c) => ({ value: c.heading, fontWeight: 'bold' as const, backgroundColor: c.required ? '#FDE68A' : '#E5E7EB' }));
  const examples = IMPORT_TEMPLATE[0]!.examples.map((_, i) => IMPORT_TEMPLATE.map((c) => ({ type: String, value: c.examples[i] ?? '' })));
  // Plenty of empty text cells, so what is typed into them (barcodes above all) stays text.
  const blank = Array.from({ length: 500 }, () => IMPORT_TEMPLATE.map(() => ({ type: String, value: '' })));
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const help = [
    [bold('Column'), bold('Needed?'), bold('What to put'), bold('Example')],
    ...IMPORT_TEMPLATE.map((c) => [{ value: c.heading }, { value: c.required ? 'needed' : 'optional' }, { value: c.help }, { type: String, value: c.examples[0] ?? '' }]),
    [],
    [{ value: 'One row per pack. Rows with the same SKU (or the same item name, when SKU is blank) become one item with several packs.' }],
    [{ value: 'Delete the example rows before importing. Items already in the item master are skipped, never duplicated.' }],
  ];
  await writeXlsxFile([
    { sheet: 'Items', data: [header, ...examples, ...blank], columns: IMPORT_TEMPLATE.map((c) => ({ width: Math.max(12, c.heading.length + 4) })) },
    { sheet: 'How to fill this in', data: help, columns: [{ width: 16 }, { width: 10 }, { width: 90 }, { width: 18 }] },
  ]).toFile('item-import-template.xlsx');
}
