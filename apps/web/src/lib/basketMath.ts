/**
 * The till's arithmetic: what a basket adds up to before it is sent.
 *
 * This mirrors packages/domain/src/basket.ts (the server's authority, which
 * recomputes everything and refuses a mismatch); apps/web does not import the
 * domain package, so the rule is restated here and apps/web/test proves the
 * two agree. The rule: each line is rounded to the cent (half away from
 * zero), and the basket is the sum of the rounded lines.
 */

export function toCents(amount: number): number {
  const cleaned = Number(Math.abs(amount * 100).toFixed(6));
  return Math.sign(amount) * Math.round(cleaned);
}

export const fromCents = (cents: number): number => cents / 100;

/** Parse what someone typed into a money field. null = blank or not a valid amount. */
export function parseMoney(text: string): number | null {
  const t = text.trim();
  if (t === '' || !/^\d*\.?\d{0,2}$/.test(t) || t === '.') return null;
  return Number(t);
}

export interface CartLineMath {
  qtyPacks: number;
  unitPrice: number;
  discount: number;
}

export function lineCents(l: CartLineMath): { grossCents: number; discountCents: number; totalCents: number } {
  const grossCents = Math.sign(l.qtyPacks) * Math.round(Number(Math.abs(l.qtyPacks * toCents(l.unitPrice)).toFixed(6)));
  const discountCents = toCents(l.discount);
  return { grossCents, discountCents, totalCents: grossCents - discountCents };
}

export function basketCents(lines: readonly CartLineMath[]): { grossCents: number; discountCents: number; netCents: number } {
  let grossCents = 0;
  let discountCents = 0;
  for (const l of lines) {
    const c = lineCents(l);
    grossCents += c.grossCents;
    discountCents += c.discountCents;
  }
  return { grossCents, discountCents, netCents: grossCents - discountCents };
}

export interface PaymentRowInput {
  isCash: boolean;
  /** What the customer hands over for this row; null = "the rest of the bill". */
  received: number | null;
}

export interface PaymentRowResult {
  appliedCents: number;
  receivedCents: number;
  ok: boolean;
}

export interface TenderResult {
  rows: PaymentRowResult[];
  /** Still owed after every row. 0 = fully paid. */
  remainingCents: number;
  changeCents: number;
  /** Null when it can be submitted; otherwise why not, in words for the cashier. */
  problem: string | null;
}

/**
 * Work out how each payment row applies to the bill. Card / transfer rows are
 * settled first and cannot overpay; cash goes last and is the only tender that
 * can be more than what is owed - the excess comes back as change.
 */
export function settleRows(netCents: number, rows: readonly PaymentRowInput[]): TenderResult {
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.isCash) - Number(b.r.isCash) || a.i - b.i);
  const results: PaymentRowResult[] = rows.map(() => ({ appliedCents: 0, receivedCents: 0, ok: true }));
  let remaining = netCents;
  let change = 0;
  let problem: string | null = null;

  for (const { r, i } of order) {
    const received = r.received === null ? remaining : toCents(r.received);
    let applied = Math.min(received, remaining);
    if (!r.isCash && received > remaining) {
      results[i] = { appliedCents: 0, receivedCents: received, ok: false };
      problem ??= 'A card or transfer cannot be more than what is still owed.';
      continue;
    }
    if (applied <= 0 && netCents > 0) {
      results[i] = { appliedCents: 0, receivedCents: received, ok: false };
      problem ??= 'Every payment line needs an amount above zero.';
      continue;
    }
    if (applied < 0) applied = 0;
    results[i] = { appliedCents: applied, receivedCents: received, ok: true };
    remaining -= applied;
    change += received - applied;
  }

  if (problem === null && remaining > 0) problem = 'The payments do not cover the total yet.';
  return { rows: results, remainingCents: remaining, changeCents: change, problem };
}

/**
 * What a line of a delivery or order costs, in whole cents: packs times the
 * price of one pack, rounded to the cent. Mirrors costLineCents in the domain
 * package (the server recomputes it and is the authority).
 */
export function costLineCents(qtyPacks: number, unitCostPerPack: number): number {
  return Math.round(Number((qtyPacks * unitCostPerPack * 100).toFixed(6)));
}

/** A per-pack cost as typed: up to four decimal places. null = blank or invalid. */
export function parseCost(text: string): number | null {
  const t = text.trim();
  if (t === '' || !/^\d*\.?\d{0,4}$/.test(t) || t === '.') return null;
  return Number(t);
}

/** A quantity as typed: a positive number. null = blank or invalid. */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (t === '' || !/^\d*\.?\d{0,4}$/.test(t) || t === '.') return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
