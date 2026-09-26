/**
 * Reading a list pasted from a spreadsheet or an old system:
 *
 *   code, quantity, cost per pack
 *
 * one item per line. The code is a SKU or a barcode. Columns may be separated
 * by a tab (what Excel copies), a comma or a semicolon. The cost may be left
 * out when it is not known. A first line that is a heading ("SKU, Qty, Cost")
 * is skipped.
 */

export interface PastedRow {
  /** 1-based line in what was pasted, so a problem can be pointed at. */
  line: number;
  code: string;
  qty: number | null;
  cost: number | null;
  problem: string | null;
}

const NUM = /^\d*\.?\d+$/;

function num(text: string | undefined): number | null {
  if (text === undefined) return null;
  // "1,250" from a spreadsheet is a thousands separator, not a decimal.
  const t = text.trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  return t !== '' && NUM.test(t) ? Number(t) : null;
}

export function parsePasted(text: string): PastedRow[] {
  const rows: PastedRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const sep = raw.includes('\t') ? '\t' : raw.includes(';') ? ';' : ',';
    const cells = raw.split(sep).map((c) => c.trim());
    const [code = '', qtyText, costText] = cells;
    const qty = num(qtyText);
    // A heading row: no number where the quantity should be, on the first line with content.
    if (rows.length === 0 && qty === null && !/\d/.test(qtyText ?? '')) return;
    const costBlank = costText === undefined || costText.trim() === '';
    const cost = costBlank ? null : num(costText);
    let problem: string | null = null;
    if (code === '') problem = 'No code';
    else if (qty === null || !(qty > 0)) problem = 'Quantity must be a number above zero';
    else if (!costBlank && cost === null) problem = 'Cost is not a number';
    else if (cost !== null && Math.abs(cost * 10_000 - Math.round(cost * 10_000)) > 1e-6) problem = 'Cost has more than four decimal places';
    rows.push({ line: i + 1, code, qty, cost, problem });
  });
  return rows;
}
