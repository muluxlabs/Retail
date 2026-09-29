/**
 * Exporting records as Excel or CSV. The server decides the columns and rows
 * (and records the export in the audit log); this turns them into a file.
 */

import { api, type ExportKind, type ExportResult } from './api.js';
import { downloadCsv } from './csv.js';

export interface ExportInfo {
  kind: ExportKind;
  label: string;
  description: string;
  /** Besides data.export: the permission that shows the same data on screen. */
  needs: string;
}

export const EXPORTS: ExportInfo[] = [
  {
    kind: 'items',
    label: 'Items',
    description: 'Every item and pack: barcodes, selling price, average cost, last received cost and date, supplier, and stock at each branch. Same columns as the item import.',
    needs: 'product.read',
  },
  {
    kind: 'suppliers',
    label: 'Suppliers',
    description: 'Every supplier: contact details, tax number, terms, and (group-wide) what has been received, paid and is owed.',
    needs: 'supplier.read',
  },
  {
    kind: 'customers',
    label: 'Customers',
    description: 'Every customer: contact details, credit limit and days to pay, what they owe, loyalty points and their last sale.',
    needs: 'customer.read',
  },
  {
    kind: 'price-lists',
    label: 'Supplier price lists',
    description: 'The latest cost each supplier has given for each pack, beside your selling price and margin.',
    needs: 'supplier.read',
  },
  {
    kind: 'staff',
    label: 'Staff',
    description: 'Everyone with an account: roles and branches, access beyond their role, last sign-in. Never passwords.',
    needs: 'user.manage',
  },
];

function text(v: string | number | boolean | null, kind: string): string | number | null {
  if (v === null) return null;
  if (typeof v === 'boolean' || kind === 'yesno') return v ? 'yes' : 'no';
  return v;
}

async function writeXlsx(data: ExportResult): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = data.columns.map((c) => ({ value: c.heading, fontWeight: 'bold' as const, backgroundColor: '#E5E7EB' }));
  const body = data.rows.map((row) =>
    row.map((v, i) => {
      const kind = data.columns[i]!.kind;
      if (v === null || v === '') return null;
      if (kind === 'money' && typeof v === 'number') return { type: Number, value: v, format: '#,##0.00' };
      if (kind === 'number' && typeof v === 'number') return { type: Number, value: v };
      // Text cells are stored as text: a name starting with "=" is never a formula. Codes stay text when edited.
      const heading = data.columns[i]!.heading;
      const code = heading === 'SKU' || heading.includes('arcode') || heading === 'Supplier code';
      return { type: String, value: String(text(v, kind)), ...(code ? { format: '@' } : {}) };
    }),
  );
  const about = [
    [{ value: data.title, fontWeight: 'bold' as const }],
    [{ value: `Exported ${new Date(data.generatedAt).toLocaleString('en-GB')}` }],
    [{ value: `${data.rows.length} row${data.rows.length === 1 ? '' : 's'}` }],
    ...(data.note === null ? [] : [[{ value: data.note }]]),
    [{ value: 'This export is recorded in the audit log.' }],
  ];
  await writeXlsxFile([
    {
      sheet: data.title.slice(0, 31),
      data: [header, ...body],
      columns: data.columns.map((c) => ({ width: Math.min(40, Math.max(12, c.heading.length + 3)) })),
      stickyRowsCount: 1,
    },
    { sheet: 'About this file', data: about, columns: [{ width: 110 }] },
  ]).toFile(`${data.fileName}.xlsx`);
}

/** Fetch an export and save it. Returns how many rows went into the file. */
export async function downloadExport(kind: ExportKind, format: 'xlsx' | 'csv'): Promise<number> {
  const data = await api.exportRecords(kind, format);
  if (format === 'csv') {
    downloadCsv(
      `${data.fileName}.csv`,
      data.columns.map((c) => c.heading),
      data.rows.map((r) => r.map((v, i) => text(v, data.columns[i]!.kind))),
    );
  } else {
    await writeXlsx(data);
  }
  return data.rows.length;
}
