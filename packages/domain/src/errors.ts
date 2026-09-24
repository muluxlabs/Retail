/**
 * Domain errors.
 *
 * These are thrown by rules in this package and mapped to HTTP status codes at
 * the API edge. The offline POS catches the same classes locally — that is the
 * point of putting the rules here rather than in the server.
 */

export class DomainError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** Selling more than is on hand, without an authorised override. */
export class NegativeStockBlocked extends DomainError {
  constructor(available: number, requested: number) {
    super(
      'NEGATIVE_STOCK_BLOCKED',
      `Insufficient stock: ${available} on hand, ${requested} requested`,
      { available, requested },
    );
  }
}

/**
 * Moving more cash out of a custody point than it holds.
 *
 * The same shape as NegativeStockBlocked - a resource going negative without
 * authorisation - but named for what it actually is, so a client debugging a
 * blocked float issue is not reading "NEGATIVE_STOCK_BLOCKED" for a cash
 * shortfall.
 */
export class InsufficientCash extends DomainError {
  constructor(available: number, requested: number) {
    super(
      'INSUFFICIENT_CASH',
      `Insufficient cash: ${available} available, ${requested} requested`,
      { available, requested },
    );
  }
}

/**
 * A barcode that resolves to nothing in the master.
 *
 * The old platform let these pass silently, which is how "under the counter"
 * sales stayed invisible. Here it is an incident with a cashier attached.
 */
export class UnlistedBarcode extends DomainError {
  constructor(code: string) {
    super('UNLISTED_BARCODE', `Barcode not in master data: ${code}`, { code });
  }
}

/** A write that would mutate history rather than append to it. */
export class LedgerImmutable extends DomainError {
  constructor(operation: string) {
    super(
      'LEDGER_IMMUTABLE',
      `The stock ledger is append-only; ${operation} is not permitted. ` +
        'Post a reversing movement instead.',
      { operation },
    );
  }
}

/** Master data that would reintroduce a known defect. */
export class InvalidMasterData extends DomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('INVALID_MASTER_DATA', message, detail);
  }
}

/** Attempting to transact against a product merged into another during cleanse. */
export class ProductMerged extends DomainError {
  constructor(productId: string, mergedIntoId: string) {
    super(
      'PRODUCT_MERGED',
      `Product ${productId} was merged into ${mergedIntoId} and no longer accepts movements`,
      { productId, mergedIntoId },
    );
  }
}

/**
 * The stock the manager reviewed is not the stock that is there now.
 *
 * A reset shows exactly what it is about to zero, and then acts on what is
 * in the ledger at the instant it runs. If those disagree - a sale, a receipt,
 * a count landed in between - it refuses and makes the person look again,
 * because "I approved that" must mean what was on the screen.
 */
export class StockResetStale extends DomainError {
  constructor(expected: number, actual: number) {
    super(
      'STOCK_RESET_STALE',
      `Stock changed while you were reviewing it: you saw ${expected} positions, there are now ${actual}. Nothing was changed - review it again.`,
      { expected, actual },
    );
  }
}

/** The typed confirmation did not match the branch. */
export class StockResetNotConfirmed extends DomainError {
  constructor() {
    super(
      'CONFIRMATION_MISMATCH',
      'The branch code you typed does not match. Nothing was changed.',
    );
  }
}

/** A branch-scoped person reaching for a branch that is not theirs. */
export class OutsideBranchScope extends DomainError {
  constructor(branchId: string) {
    super('OUTSIDE_BRANCH_SCOPE', 'You are not assigned to that branch.', { branchId });
  }
}
