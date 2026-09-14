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
