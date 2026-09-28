/**
 * Opening stock: the rules for bringing stock onto the books at a branch.
 *
 * Opening stock is only for an item with nothing on hand at that branch. An
 * item already on the books with a different quantity on the shelf is a stock
 * take (a counted difference, which is investigated), not a second opening.
 */

import { DomainError } from './errors.js';

/** The document itself is not valid: empty, a duplicate item, a bad quantity or cost. */
export class InvalidOpeningStock extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_OPENING_STOCK', message, detail);
  }
}

/** Some items already have stock at the branch; opening stock cannot be added on top. */
export class OpeningStockNotEmpty extends DomainError {
  constructor(items: { productId: string; name: string; onHand: number }[]) {
    const first = items.slice(0, 3).map((i) => `${i.name} (${i.onHand} on hand)`).join(', ');
    super(
      'OPENING_STOCK_NOT_EMPTY',
      `${items.length === 1 ? 'This item already has' : `${items.length} items already have`} stock at this branch: ${first}${items.length > 3 ? ', …' : ''}. ` +
        'Opening stock is only for items with nothing on hand; correct an item already on the books with a stock take.',
      { items },
    );
  }
}

export interface OpeningLineInput {
  productId: string;
  qtyPacks: number;
  /** Per pack; null when not known. */
  unitCost: number | null;
}

/** Checks that do not need the database: something to post, no item twice, sensible numbers. */
export function checkOpeningLines(lines: readonly OpeningLineInput[]): void {
  if (lines.length === 0) throw new InvalidOpeningStock('Add at least one item.');
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.productId)) {
      throw new InvalidOpeningStock('An item appears twice. Put its whole quantity on one line.', { productId: l.productId });
    }
    seen.add(l.productId);
    if (!(l.qtyPacks > 0) || !Number.isFinite(l.qtyPacks)) throw new InvalidOpeningStock('Every line needs a quantity above zero.');
    if (l.unitCost !== null && (!(l.unitCost >= 0) || !Number.isFinite(l.unitCost))) {
      throw new InvalidOpeningStock('A cost must be zero or more, or left blank when it is not known.');
    }
  }
}
