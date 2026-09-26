/**
 * End of day: the rules for closing the day at a branch.
 *
 * Every till at the branch is counted at the close - none may be left out,
 * and nothing that is not a till there may be slipped in. The count is blind:
 * whoever counts does not see what the books expect until the close is posted.
 * Everything is worked in whole cents.
 */

import { DomainError } from './errors.js';

/** The close is not valid as asked: a till not counted, a count that is not a till here, a bad amount. */
export class InvalidDayClose extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_DAY_CLOSE', message, detail);
  }
}

export interface TillExpected {
  id: string;
  name: string;
  expectedCents: number;
}

export interface TillCount {
  cashPointId: string;
  countedCents: number;
}

export interface TillReconciled extends TillExpected {
  countedCents: number;
  /** Counted less expected: positive is cash over, negative is cash short. */
  varianceCents: number;
}

export function reconcileTills(tills: readonly TillExpected[], counts: readonly TillCount[]): TillReconciled[] {
  const byId = new Map<string, number>();
  for (const c of counts) {
    if (byId.has(c.cashPointId)) throw new InvalidDayClose('A till was counted twice.', { cashPointId: c.cashPointId });
    if (!Number.isInteger(c.countedCents) || c.countedCents < 0) throw new InvalidDayClose('A count must be zero or more, in whole cents.');
    byId.set(c.cashPointId, c.countedCents);
  }
  const known = new Set(tills.map((t) => t.id));
  const stray = counts.find((c) => !known.has(c.cashPointId));
  if (stray !== undefined) throw new InvalidDayClose('A count was given for a cash point that is not a till at this branch.', { cashPointId: stray.cashPointId });
  const missing = tills.filter((t) => !byId.has(t.id));
  if (missing.length > 0) {
    throw new InvalidDayClose(`Count every till before closing: ${missing.map((t) => t.name).join(', ')} not counted.`, { missing: missing.map((t) => t.id) });
  }
  return tills.map((t) => {
    const countedCents = byId.get(t.id)!;
    return { ...t, countedCents, varianceCents: countedCents - t.expectedCents };
  });
}

/** The number on the end of a receipt number: 'KANA-000123' is 123. */
export function receiptNumber(receiptNo: string): number {
  const m = /(\d+)$/.exec(receiptNo);
  if (m === null) throw new InvalidDayClose(`Not a receipt number: ${receiptNo}`);
  return Number(m[1]);
}
