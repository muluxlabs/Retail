/** Core domain types. Shared verbatim between the API and the offline POS. */

export type Uuid = string;

export type BranchKind = 'store' | 'warehouse';

export type MovementReason =
  | 'grn'
  | 'grn_reversal'
  | 'sale'
  | 'sale_refund'
  | 'transfer_out'
  | 'transfer_in'
  | 'transfer_loss'
  | 'count_adjustment'
  | 'write_off'
  | 'opening_balance'
  | 'stock_reset';

/** Reasons that represent stock entering at a known cost, used to derive WAC. */
export const RECEIPT_REASONS: readonly MovementReason[] = [
  'grn',
  'opening_balance',
  'transfer_in',
] as const;

export type ExceptionKind =
  | 'negative_stock_override'
  | 'unlisted_barcode_scan'
  | 'backdated_entry'
  | 'count_variance'
  | 'transit_loss'
  | 'cash_variance'
  | 'price_override'
  | 'void_after_tender'
  | 'stock_reset';

export type ExceptionState = 'open' | 'acknowledged' | 'cleared' | 'escalated';

export interface Product {
  id: Uuid;
  sku: string;
  name: string;
  /** The atomic unit every quantity converts to: 'each', 'kg', 'litre'. */
  baseUom: string;
  isWeighed: boolean;
  /** Set during master-data cleanse. Merged products reject new movements. */
  mergedIntoId: Uuid | null;
}

/**
 * One way a product is physically handled.
 *
 * `qtyBase` is how many base units the pack contains:
 *   Charhons 500g single           -> 1
 *   Charhons biscuits 10x500g case -> 10
 */
export interface ProductPack {
  id: Uuid;
  productId: Uuid;
  label: string;
  qtyBase: number;
}

/** A barcode resolves to exactly one pack, hence one product and one multiplier. */
export interface BarcodeBinding {
  code: string;
  packId: Uuid;
  productId: Uuid;
  qtyBase: number;
}

/**
 * One append-only row of the stock ledger.
 *
 * `occurredAt` is business time — it may be in the past if the till was
 * offline, or backdated by a user. `recordedAt` is server time. The gap
 * between them is how backdating becomes visible instead of invisible.
 */
export interface StockMovement {
  /** Client-generated before the network is available. Idempotency key. */
  eventId: Uuid;
  productId: Uuid;
  branchId: Uuid;
  /** Signed, in base units. Positive into the branch, negative out. */
  qtyBase: number;
  unitCost: number | null;
  currency: string;
  reason: MovementReason;
  docType: string | null;
  docId: Uuid | null;
  reversesSeq: number | null;
  actorId: Uuid;
  terminalId: Uuid | null;
  occurredAt: Date;
}

export interface ExceptionDraft {
  eventId: Uuid;
  kind: ExceptionKind;
  branchId: Uuid;
  terminalId: Uuid | null;
  actorId: Uuid;
  productId: Uuid | null;
  detail: Record<string, unknown>;
  valueImpact: number | null;
  currency: string | null;
  occurredAt: Date;
}
