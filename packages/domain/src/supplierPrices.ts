/**
 * A supplier's price list: reading what was pasted, and the new selling price
 * each changed cost suggests.
 *
 * Suppliers send lists as spreadsheets, e-mails or PDFs copied out: one item a
 * line, a code somewhere at the start and the price somewhere at the end. So a
 * line is read as: the first cell is the code (the supplier's own code, a
 * barcode or our SKU); the LAST cell that is a number is the cost per pack.
 * Anything between (a description, a pack size) is kept for display only.
 *
 * Costs may have up to four decimals (a supplier's price per unit is often
 * fractional); selling prices are whole cents.
 */

import { DomainError } from './errors.js';

export class InvalidPriceList extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_PRICE_LIST', message, detail);
  }
}

export class PriceBelowCost extends DomainError {
  constructor(items: { name: string; cost: number; sellPrice: number }[]) {
    super(
      'PRICE_BELOW_COST',
      `A selling price would be below its new cost: ${items
        .slice(0, 3)
        .map((i) => `${i.name} (${i.sellPrice.toFixed(2)} against ${i.cost.toFixed(2)})`)
        .join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}.`,
      { items },
    );
  }
}

export interface PastedLine {
  /** 1-based line number in what was pasted. */
  row: number;
  code: string;
  description: string;
  /** Cost per pack in ten-thousandths of a dollar (4 dp), or null with a problem. */
  costMicro: number | null;
  problem: string | null;
}

/** Split one CSV-style line on a separator, honouring "quoted, cells" (so "1,234.50" stays one cell). */
function splitQuoted(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * The cells of a line: tab-separated (copied from a spreadsheet), else
 * semicolons, else commas (CSV), else runs of spaces with the first word the code.
 */
function splitCells(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : null;
  const cells = sep === null ? line.trim().split(/\s+/) : splitQuoted(line, sep);
  return cells.map((c) => c.trim()).filter((c) => c !== '');
}

/** A money amount with up to four decimals, as ten-thousandths; null if it is not one. */
export function parseCostMicro(raw: string): number | null {
  const s = raw.replace(/^\$|^US\$|^USD\s*/i, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 10_000 + Number(frac.padEnd(4, '0'));
}

export function parsePriceList(text: string): PastedLine[] {
  const out: PastedLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === '') return;
    const cells = splitCells(raw);
    const code = cells[0] ?? '';
    let costIdx = -1;
    for (let k = cells.length - 1; k >= 1; k -= 1) {
      if (parseCostMicro(cells[k]!) !== null) {
        costIdx = k;
        break;
      }
    }
    const costMicro = costIdx === -1 ? null : parseCostMicro(cells[costIdx]!);
    const description = cells.slice(1, costIdx === -1 ? undefined : costIdx).join(' ');
    // A header row ("Code, Description, Price") has no price: skip it quietly if it is the first line.
    if (costMicro === null && out.length === 0 && i === 0 && !/\d/.test(raw)) return;
    out.push({
      row: i + 1,
      code,
      description,
      costMicro,
      problem: code === '' ? 'No code' : costMicro === null ? 'No price found on this line' : costMicro === 0 ? 'A price of zero' : null,
    });
  });
  return out;
}

export type PriceRule =
  | { mode: 'keep_margin'; roundToCents: number }
  | { mode: 'markup'; markupPercent: number; roundToCents: number }
  | { mode: 'costs_only' };

/** Round up to a step in cents. */
function roundUp(cents: number, stepCents: number): number {
  const exact = Math.round(cents * 1e6) / 1e6;
  return Math.ceil(exact / stepCents) * stepCents;
}

/**
 * The selling price (cents) a new cost suggests, or null to leave the price alone.
 *
 * keep_margin: the price moves in proportion to the cost, so the margin
 * percentage stays what it was. Needs both an old cost and a current price.
 * markup: cost plus a percentage. Both round UP to the step, so the margin is
 * never less than intended.
 */
export function suggestedPrice(
  input: { newCostMicro: number; oldCostMicro: number | null; currentSellCents: number | null },
  rule: PriceRule,
): number | null {
  if (rule.mode === 'costs_only') return null;
  if (rule.mode === 'markup') {
    const raw = (input.newCostMicro / 100) * (1 + rule.markupPercent / 100);
    return roundUp(raw, rule.roundToCents);
  }
  if (input.oldCostMicro === null || input.oldCostMicro <= 0 || input.currentSellCents === null) return null;
  if (input.oldCostMicro === input.newCostMicro) return input.currentSellCents;
  const raw = (input.currentSellCents * input.newCostMicro) / input.oldCostMicro;
  return roundUp(raw, rule.roundToCents);
}

/** Gross margin as a percentage of the price, one decimal; null without both. */
export function marginPercent(sellCents: number | null, costMicro: number | null): number | null {
  if (sellCents === null || sellCents <= 0 || costMicro === null) return null;
  return Math.round(((sellCents * 100 - costMicro) / (sellCents * 100)) * 1000) / 10;
}
