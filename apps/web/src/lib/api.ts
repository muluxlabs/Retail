/**
 * API client.
 *
 * Thin on purpose. It knows how to call the server and how to surface a
 * domain error; it holds no business rules, because those live in
 * packages/domain and are enforced server-side.
 */

/**
 * Where the API lives. Empty in development, where Vite proxies /api to the
 * local server, and set at build time when the frontend is deployed apart
 * from the API.
 */
const API_BASE = (import.meta.env['VITE_API_URL'] ?? '').replace(/\/$/, '');

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

/**
 * An error the server refused on purpose.
 *
 * `code` is the domain's own identifier, so the UI can react to
 * NEGATIVE_STOCK_BLOCKED specifically rather than parsing a message.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.detail = body.error.detail ?? {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_BASE + path, {
    ...init,
    // The session is an httpOnly cookie; without this it is never sent.
    credentials: 'include',
    headers: {
      // Only when there is a body. Fastify's JSON parser rejects
      // Content-Type: application/json on an EMPTY body with its own 400
      // (FST_ERR_CTP_EMPTY_JSON_BODY) before the route ever runs - sending
      // this header unconditionally broke every bodiless call: sign-out,
      // password reset, barcode removal. Found by testing the new endpoints
      // directly against a running server rather than trusting the build.
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let body: ApiErrorBody;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = { error: { code: 'UNKNOWN', message: `${response.status} ${response.statusText}` } };
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
}

// -- shapes returned by the API ---------------------------------------------

export interface Branch {
  id: string;
  code: string;
  name: string;
  kind: 'store' | 'warehouse';
  isActive: boolean;
}

export interface Person {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
}

export interface Pack {
  id: string;
  label: string;
  qtyBase: number;
  isDefaultSell: boolean;
  isDefaultBuy: boolean;
  barcode: string | null;
  /** List price for one of this pack; null = not priced yet, so it cannot be sold. */
  sellPrice: number | null;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  baseUom: string;
  isWeighed: boolean;
  isActive: boolean;
  mergedIntoId: string | null;
  reviewState: 'approved' | 'pending';
  categoryName: string | null;
  packs: Pack[];
}

export interface SalesReportParams {
  from: string;
  to: string;
  groupBy?: 'hour' | 'day' | 'week' | 'month';
  branchId?: string;
  cashierId?: string;
  categoryId?: string;
  productId?: string;
  paymentTypeId?: string;
  fromHour?: number;
  toHour?: number;
}

/** The trading account, for one period or one slice of it. */
export interface SalesStatement {
  receipts: number;
  units: number;
  /** Total sales, before discounts. */
  gross: number;
  discounts: number;
  net: number;
  /** Cost of sales, on lines whose cost was known. */
  cost: number;
  grossProfit: number;
  /** On sales whose cost was known; null when there are none. */
  marginPercent: number | null;
  avgBasket: number;
  /** Sales with no cost on record: kept out of profit and margin, never treated as free. */
  uncostedNet: number;
  uncostedLines: number;
}

export interface SalesReport {
  timezone: string;
  period: { from: string; to: string; days: number };
  previousPeriod: { from: string; to: string };
  summary: SalesStatement;
  previous: SalesStatement;
  series: (SalesStatement & { bucket: string })[];
  byBranch: (SalesStatement & { branchId: string; branchCode: string; branchName: string })[];
  byCategory: (SalesStatement & { categoryName: string })[];
  byProduct: (SalesStatement & { productId: string; sku: string; productName: string })[];
  byCashier: (SalesStatement & { cashierId: string; cashierName: string })[];
  byHour: (SalesStatement & { hour: number })[];
  byPayment: { paymentTypeId: string; name: string; receipts: number; amount: number }[];
}

export type ItemStatus = 'out_of_stock' | 'not_selling' | 'fast' | 'steady' | 'slow';

export interface ItemRow {
  productId: string;
  sku: string;
  productName: string;
  categoryName: string;
  opening: number;
  received: number;
  transfersIn: number;
  transfersOut: number;
  adjustments: number;
  sold: number;
  closing: number;
  sellThroughPercent: number | null;
  perDay: number;
  perWeek: number;
  daysOfCover: number | null;
  lastSold: string | null;
  net: number;
  cost: number;
  grossProfit: number;
  marginPercent: number | null;
  status: ItemStatus;
}

export interface ItemReport {
  timezone: string;
  period: { from: string; to: string; days: number };
  summary: {
    items: number;
    itemsSold: number;
    opening: number;
    received: number;
    sold: number;
    closing: number;
    sellThroughPercent: number | null;
    outOfStock: number;
    notSelling: number;
    fast: number;
    steady: number;
    slow: number;
  };
  items: ItemRow[];
}

export interface ItemHistory {
  product: { productId: string; sku: string; productName: string; categoryName: string | null };
  timezone: string;
  opening: number;
  series: { bucket: string; received: number; sold: number; other: number; closing: number }[];
  totals: { received: number; sold: number; net: number; cost: number; grossProfit: number };
}

// -- buying: suppliers, orders, goods received, payments -------------------------------------------

export type SupplierTerms = 'prepaid' | 'cash_on_delivery' | 'credit';
export type PaymentTiming = 'prepaid' | 'on_delivery' | 'after_delivery' | 'on_account';
export type PoStatus = 'ordered' | 'part_received' | 'received' | 'closed' | 'cancelled';

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  terms: SupplierTerms;
  creditDays: number | null;
  isActive: boolean;
  /** Null when the viewer is tied to a branch: what the group owes is group-wide finance. */
  receivedCost: number | null;
  paid: number | null;
  balance: number | null;
  lastDelivery: string | null;
  openOrders: number;
}

export interface SupplierInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tin?: string | null;
  terms: SupplierTerms;
  creditDays?: number | null;
  notes?: string | null;
}

export interface StatementLine {
  at: string;
  kind: 'received' | 'payment' | 'void' | 'return';
  ref: string;
  description: string;
  id: string;
  debit: number;
  credit: number;
  balance: number;
  timing?: PaymentTiming;
}

export interface AgeingItem {
  grnId: string;
  grnNo: string;
  day: string;
  dueDay: string;
  amount: number;
  outstanding: number;
  daysOverdue: number;
}

export interface SupplierAccount {
  balance: number;
  receivedCost: number;
  returnedCost: number;
  paid: number;
  ageing: {
    buckets: { notDue: number; d1_30: number; d31_60: number; d61_90: number; over90: number };
    total: number;
    credit: number;
    items: AgeingItem[];
  };
  statement: StatementLine[];
}

export interface SupplierDetail {
  supplier: {
    id: string;
    code: string;
    name: string;
    contactPerson: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    tin: string | null;
    terms: SupplierTerms;
    creditDays: number | null;
    notes: string | null;
    isActive: boolean;
  };
  financeHidden: boolean;
  account: SupplierAccount | null;
}

export interface OrderSummary {
  id: string;
  poNo: string;
  status: PoStatus;
  orderedAt: string;
  expectedDate: string | null;
  terms: SupplierTerms;
  creditDays: number | null;
  supplier: { id: string; name: string; code: string };
  branch: { id: string; name: string; code: string };
  orderedByName: string;
  lineCount: number;
  ordered: number;
  received: number;
  paid: number | null;
  paymentStatus: 'unpaid' | 'part_paid' | 'paid' | null;
}

export interface OrderLine {
  id: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  packId: string;
  packLabel: string;
  qtyPacks: number;
  qtyBase: number;
  unitCost: number;
  lineTotal: number;
  receivedPacks: number;
  outstandingPacks: number;
}

export interface OrderPayment {
  id: string;
  paymentNo: string;
  amount: number;
  paidAt: string;
  reference: string | null;
  method: string;
  voidedAt: string | null;
  proofs: number;
  timing: PaymentTiming;
}

export interface OrderDetail extends OrderSummary {
  notes: string | null;
  cancelled: { at: string; reason: string } | null;
  closed: { at: string; note: string } | null;
  lines: OrderLine[];
  receipts: { id: string; grnNo: string; receivedAt: string; totalCost: number; invoiceNo: string | null; receivedByName: string }[];
  payments: OrderPayment[];
  financeHidden: boolean;
}

export interface OrderInput {
  supplierId: string;
  branchId: string;
  expectedDate?: string | null;
  terms?: SupplierTerms;
  creditDays?: number | null;
  notes?: string | null;
  lines: { productId: string; packId: string; qtyPacks: number; unitCost: number }[];
}

export interface GrnInput {
  id: string;
  branchId: string;
  supplierId: string;
  poId?: string | null;
  supplierInvoiceNo?: string | null;
  invoiceDate?: string | null;
  invoiceTotal?: number | null;
  notes?: string | null;
  lines: { productId: string; packId: string; qtyPacks: number; unitCost: number; poLineId?: string | null }[];
}

export interface GrnSummary {
  id: string;
  grnNo: string;
  receivedAt: string;
  totalCost: number;
  invoiceNo: string | null;
  invoiceDate: string | null;
  invoiceTotal: number | null;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  poNo: string | null;
  receivedByName: string;
  lineCount: number;
  paid: number | null;
}

export interface GrnDetail {
  id: string;
  grnNo: string;
  receivedAt: string;
  totalCost: number;
  invoiceNo: string | null;
  invoiceDate: string | null;
  invoiceTotal: number | null;
  notes: string | null;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  poId: string | null;
  poNo: string | null;
  receivedByName: string;
  lines: {
    lineNo: number;
    productId: string;
    sku: string;
    name: string;
    packLabel: string;
    qtyPacks: number;
    qtyBase: number;
    unitCost: number;
    lineTotal: number;
    orderedUnitCost: number | null;
    orderedPacks: number | null;
    id: string;
    packId: string;
    /** Base units already sent back to the supplier against this line. */
    returnedBase: number;
  }[];
}

export interface SupplierCashPoint {
  id: string;
  name: string;
  kind: 'till' | 'safe' | 'petty' | 'bank';
  branchId: string;
  branchName: string;
  amount: number;
}

export interface ReturnInput {
  id: string;
  supplierId: string;
  branchId: string;
  grnId?: string | null;
  reason: string;
  creditNoteNo?: string | null;
  lines: { productId: string; packId: string; qtyPacks: number; unitCost?: number | null; grnLineId?: string | null }[];
}

export interface ReturnSummary {
  id: string;
  prnNo: string;
  returnedAt: string;
  totalCost: number;
  reason: string;
  creditNoteNo: string | null;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  grnNo: string | null;
  returnedByName: string;
  lineCount: number;
}

export interface ReturnDetail extends Omit<ReturnSummary, 'lineCount'> {
  supplierCode: string;
  grnId: string | null;
  lines: { lineNo: number; productId: string; sku: string; name: string; packLabel: string; qtyPacks: number; qtyBase: number; unitCost: number; lineTotal: number }[];
}

export interface PaymentRow {
  id: string;
  paymentNo: string;
  amount: number;
  paidAt: string;
  reference: string | null;
  methodId: string;
  method: string;
  note: string | null;
  supplierId: string;
  supplierName: string;
  poNo: string | null;
  grnNo: string | null;
  recordedByName: string;
  voidedAt: string | null;
  voidReason: string | null;
  proofs: number;
  timing: PaymentTiming;
}

export interface PaymentDetail extends Omit<PaymentRow, 'methodId' | 'timing' | 'proofs'> {
  poId: string | null;
  grnId: string | null;
  recordedAt: string;
  voidedByName: string | null;
  cashPointName: string | null;
  cashPointBranch: string | null;
  proofs: { id: string; fileName: string; contentType: string; sizeBytes: number; sha256: string; uploadedAt: string; uploadedByName: string }[];
}

export interface PaymentInput {
  id: string;
  supplierId: string;
  amount: number;
  paymentTypeId: string;
  reference?: string | null;
  paidAt?: string;
  poId?: string | null;
  grnId?: string | null;
  note?: string | null;
  cashPointId?: string | null;
}

export interface Payables {
  asOf: string;
  totals: { notDue: number; d1_30: number; d31_60: number; d61_90: number; over90: number; total: number; credit: number };
  suppliers: {
    supplierId: string;
    code: string;
    name: string;
    terms: SupplierTerms;
    balance: number;
    owed: number;
    credit: number;
    overdue: number;
    oldestOverdueDays: number;
    buckets: { notDue: number; d1_30: number; d31_60: number; d61_90: number; over90: number };
  }[];
}

export interface OpeningMatch {
  productId: string;
  sku: string;
  name: string;
  packId: string;
  packs: { id: string; label: string; qtyBase: number }[];
  onHand: number;
}

export interface OpeningDocSummary {
  id: string;
  docNo: string;
  enteredAt: string;
  totalCost: number;
  note: string | null;
  branchId: string;
  branchName: string;
  enteredByName: string;
  lines: number;
  linesWithoutCost: number;
  units: number;
}

export interface OpeningDoc {
  id: string;
  docNo: string;
  enteredAt: string;
  totalCost: number;
  note: string | null;
  branchId: string;
  branchName: string;
  branchCode: string;
  enteredByName: string;
  lines: { lineNo: number; productId: string; sku: string; name: string; packLabel: string; qtyPacks: number; qtyBase: number; unitCost: number | null; lineTotal: number | null }[];
}

export interface PaymentType {
  id: string;
  name: string;
  isCash: boolean;
  atTill: boolean;
  forSuppliers: boolean;
}

export interface Till {
  id: string;
  name: string;
  terminalId: string | null;
}

export interface CheckoutBody {
  saleId: string;
  branchId: string;
  cashPointId: string | null;
  terminalId: string | null;
  lines: { productId: string; packId: string; qtyPacks: number; unitPrice?: number; discount?: number }[];
  payments: { paymentTypeId: string; amount: number; tendered?: number; reference?: string | null }[];
  overrideNegative: boolean;
}

export interface ReceiptLine {
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  packLabel: string;
  qtyPacks: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
}

export interface Receipt {
  id: string;
  receiptNo: string;
  occurredAt: string;
  branch: { id: string; code: string; name: string };
  cashier: { id: string; name: string };
  till: string | null;
  currency: string;
  lines: ReceiptLine[];
  gross: number;
  discount: number;
  net: number;
  tendered: number;
  change: number;
  payments: { type: string; isCash: boolean; amount: number; tendered: number; reference: string | null }[];
  business: { name: string; address: string; phone: string; tin: string; footer: string; widthMm: number };
}

export interface SaleSummary {
  id: string;
  receiptNo: string;
  occurredAt: string;
  branchCode: string;
  branchName: string;
  cashierName: string;
  net: number;
  discount: number;
  itemCount: number;
  paidBy: string | null;
}

export interface PriceRow {
  packId: string;
  packLabel: string;
  qtyBase: number;
  sellPrice: number | null;
  productId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  barcode: string | null;
  costPerPack: number | null;
}

export interface PriceList {
  items: PriceRow[];
  /** Items matching the filters (drives paging). */
  total: number;
  /** Every active item, filtered or not. */
  catalogue: number;
  unpriced: number;
  limit: number;
  offset: number;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
}

export interface NewPackInput {
  label: string;
  qtyBase: number;
  isDefaultSell?: boolean;
  isDefaultBuy?: boolean;
  barcode?: string;
  sellPrice?: number;
}

export interface NewProductInput {
  sku: string;
  name: string;
  baseUom: string;
  categoryId: string | null;
  isWeighed: boolean;
  packs: NewPackInput[];
}

export interface StockLine {
  productId: string;
  branchId: string;
  qtyBase: number;
  sku: string;
  productName: string;
  baseUom: string;
  branchCode: string;
  branchName: string;
  wac: number | null;
  value: number;
}

export interface BranchStock {
  branchId: string;
  branchCode: string;
  branchName: string;
  kind: 'store' | 'warehouse';
  lines: number;
  units: number;
  value: number;
  negativeLines: number;
}

export type ExceptionKind =
  | 'negative_stock_override'
  | 'unlisted_barcode_scan'
  | 'backdated_entry'
  | 'count_variance'
  | 'transit_loss'
  | 'cash_variance'
  | 'price_override'
  | 'void_after_tender'
  | 'unreviewed_product'
  | 'stock_reset'
  | 'opening_stock';

export type ExceptionState = 'open' | 'acknowledged' | 'cleared' | 'escalated';

export interface ExceptionRow {
  id: string;
  kind: ExceptionKind;
  state: ExceptionState;
  detail: Record<string, unknown>;
  valueImpact: number | null;
  currency: string | null;
  occurredAt: string;
  recordedAt: string;
  clearedAt: string | null;
  clearingNote: string | null;
  branchId: string;
  branchCode: string;
  branchName: string;
  actorName: string | null;
  clearedByName: string | null;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
}

export interface ExceptionList {
  items: ExceptionRow[];
  byState: { state: ExceptionState; n: number }[];
  byKind: { kind: ExceptionKind; n: number }[];
}

export interface Movement {
  seq: number;
  eventId: string;
  qtyBase: number;
  unitCost: number | null;
  reason: string;
  docType: string | null;
  occurredAt: string;
  recordedAt: string;
  reversesSeq: number | null;
  sku: string;
  productName: string;
  branchCode: string;
  actorName: string | null;
  backdateGapHours: number;
}

export interface Dashboard {
  inventory: { lines: number; value: number; linesWithoutCost: number };
  exceptions: {
    open: number;
    valueAtRisk: number;
    byKind: { kind: ExceptionKind; count: number; valueAtRisk: number }[];
  };
  controls: { backdatedMovements: number; negativeStockLines: number };
  master: { products: number; withoutPack: number; withoutBarcode: number; merged: number };
  activity: { day: string; unitsSold: number; unitsReceived: number }[];
  /** The last 30 days against the 30 before them. */
  trading: { soldNow: number; soldBefore: number; receivedNow: number; receivedBefore: number };
  topProducts: { productId: string; productName: string; sku: string; unitsSold: number }[];
  inventoryByCategory: { categoryName: string; value: number }[];
}

export interface CurrentUser {
  personId: string;
  fullName: string;
  email: string;
  roles: string[];
  permissions: string[];
  branchIds: string[];
  mustChangePassword: boolean;
}

export type CashPointKind = 'till' | 'safe' | 'petty' | 'bank';

export interface CashPointRef {
  id: string;
  branchId: string;
  branchCode: string;
  kind: CashPointKind;
  name: string;
  terminalId: string | null;
}

export interface CashPointPosition extends CashPointRef {
  amount: number;
}

export interface CashLedgerRow {
  seq: number;
  amount: number;
  reason: string;
  docType: string | null;
  occurredAt: string;
  cashPointName: string;
  actorName: string | null;
}

export type TransferState = 'dispatched' | 'received' | 'cancelled';

export interface TransferSummary {
  id: string;
  reference: string;
  state: TransferState;
  originBranchCode: string;
  destinationBranchCode: string;
  dispatchedAt: string;
  lineCount: number;
}

export interface TransferLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  qtyDispatched: number;
  qtyReceived: number | null;
  unitCost: number | null;
  variance: number | null;
  valueImpact: number | null;
}

export interface TransferDetail {
  id: string;
  reference: string;
  state: TransferState;
  originBranchId: string;
  originBranchCode: string;
  destinationBranchId: string;
  destinationBranchCode: string;
  dispatchedBy: string;
  dispatchedByName: string | null;
  dispatchedAt: string;
  receivedBy: string | null;
  receivedByName: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  lines: TransferLine[];
}

/** The seven figures every report cut carries, however it is grouped. */
export interface ReportFigures {
  unitsSold: number;
  unitsReceived: number;
  costReceived: number;
  unitsTransferredOut: number;
  unitsTransferredIn: number;
  unitsWrittenOff: number;
  unitsAdjustedNet: number;
  /** Stock zeroed by a branch reset (mostly negative). */
  unitsResetNet: number;
}

export interface ReportBucket extends ReportFigures {
  bucket: string;
}

export interface ReportProductRow extends ReportFigures {
  productId: string;
  sku: string;
  productName: string;
}

export interface MovementReport {
  from: string;
  to: string;
  groupBy: 'day' | 'week' | 'month' | 'year';
  summary: ReportFigures;
  buckets: ReportBucket[];
  byProduct: ReportProductRow[];
  /** Ranked by units sold, unlike byProduct, which is ranked by total activity. */
  topSellers: ReportProductRow[];
  byBranch: (ReportFigures & { branchId: string; branchName: string })[];
  byCategory: (ReportFigures & { categoryName: string })[];
  /** ISO weekday: 1 = Monday .. 7 = Sunday. Only weekdays with activity appear. */
  byWeekday: (ReportFigures & { weekday: number })[];
}

/** One entry on a bin card: a receipt or an issue, with the balance after it. */
export interface StockLedgerRow {
  seq: number;
  occurredAt: string;
  recordedAt: string;
  reason: string;
  docType: string | null;
  /** The number on the paper document, where there is one (a transfer's dispatch note). */
  reference: string | null;
  qtyIn: number;
  qtyOut: number;
  balance: number;
  unitCost: number | null;
  actorName: string | null;
  lateHours: number;
}

/** A stores ledger for one product at one branch over a period. */
export interface StockLedger {
  branch: { id: string; code: string; name: string };
  product: { id: string; sku: string; name: string; baseUom: string };
  from: string;
  to: string;
  opening: number;
  receipts: number;
  issues: number;
  closing: number;
  rows: StockLedgerRow[];
  onHandNow: number;
  /** null when the period ended in the past: nothing current to compare it to. */
  agreesToStockOnHand: boolean | null;
}

export interface ReconciliationLine {
  productId: string;
  sku: string;
  productName: string;
  baseUom: string;
  opening: number;
  /** Signed: what came in is positive, what went out is negative. */
  purchases: number;
  transfersIn: number;
  transfersOut: number;
  sales: number;
  /** Stock introduced when trading began here. A movement, not a balance, and not an adjustment. */
  openingStock: number;
  adjustments: number;
  closing: number;
  onHand: number;
  balanced: boolean;
  agreesToStockOnHand: boolean | null;
}

export interface StockReconciliation {
  branch: { id: string; code: string; name: string };
  from: string;
  to: string;
  reachesToday: boolean;
  lines: ReconciliationLine[];
  limit: number;
  offset: number;
  allBalanced: boolean;
  allAgreeToStockOnHand: boolean | null;
}

/** What a branch reset is about to zero, read at the moment it is asked for. */
export interface ResetPreview {
  branchId: string;
  branchCode: string;
  branchName: string;
  /** Positions that will be set to zero. */
  resettable: number;
  unitsOnHand: number;
  /** Units the ledger says are impossible, as a positive count. */
  unitsBelowZero: number;
  valueAtCost: number;
  withoutCost: number;
  /** Non-zero positions on merged products, which accept no movements and are left out. */
  skippedMerged: number;
}

export interface ResetResult extends ResetPreview {
  /** Null when there was nothing to zero. */
  docId: string | null;
  exceptionId: string | null;
}

export interface SettingRow {
  key: string;
  value: string;
  label: string;
  description: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface UserRow {
  id: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  loginEmail: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean | null;
  lockedUntil: string | null;
  canSignIn: boolean;
  roles: { roleId: string; branchId: string | null; branchCode: string | null }[];
}

// -- endpoints ---------------------------------------------------------------

export const api = {
  // -- authentication --------------------------------------------------------
  login: (body: { email: string; password: string }) =>
    request<{ user: CurrentUser; expiresAt: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<CurrentUser>('/api/auth/me'),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // -- staff accounts --------------------------------------------------------
  users: () => request<UserRow[]>('/api/users'),

  createUser: (body: {
    fullName: string;
    email: string;
    roleIds: string[];
    branchId: string | null;
  }) =>
    request<{ id: string; fullName: string; email: string; temporaryPassword?: string }>(
      '/api/users',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  updateUser: (id: string, body: { isActive?: boolean; roleIds?: string[] }) =>
    request<{ ok: true }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  resetPassword: (id: string) =>
    request<{ temporaryPassword: string }>(`/api/users/${id}/reset-password`, { method: 'POST' }),

  dashboard: () => request<Dashboard>('/api/dashboard'),

  branches: (params: { includeInactive?: boolean } = {}) =>
    request<Branch[]>(`/api/branches${qs(params)}`),

  branchCapacity: () => request<{ activeCount: number; limit: number }>('/api/branches/capacity'),

  createBranch: (body: { code: string; name: string; kind: 'store' | 'warehouse' }) =>
    request<Branch>('/api/branches', { method: 'POST', body: JSON.stringify(body) }),

  updateBranch: (
    id: string,
    body: Partial<{ code: string; name: string; kind: 'store' | 'warehouse'; isActive: boolean }>,
  ) => request<Branch>(`/api/branches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  people: () => request<Person[]>('/api/people'),

  products: (
    params: {
      search?: string;
      reviewState?: 'approved' | 'pending';
      limit?: number;
      offset?: number;
    } = {},
  ) =>
    request<{ items: Product[]; total: number; limit: number; offset: number }>(
      `/api/products${qs(params)}`,
    ),

  product: (id: string) =>
    request<Product & { stock: StockLine[]; movements: Movement[] }>(`/api/products/${id}`),

  categories: () => request<Category[]>('/api/categories'),

  createProduct: (body: NewProductInput) =>
    request<{ id: string; sku: string; name: string }>('/api/products', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateProduct: (
    id: string,
    body: Partial<{
      sku: string;
      name: string;
      baseUom: string;
      categoryId: string | null;
      isWeighed: boolean;
      isActive: boolean;
    }>,
  ) => request<unknown>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  /**
   * A cashier or receiver adds a product on the fly, mid-transaction. It
   * lands in review, not the trusted master - the response is enough to
   * finish the sale immediately (productId + packId, straight into `sell`).
   */
  quickAddProduct: (body: {
    name: string;
    sellPrice?: number;
    barcode?: string;
    branchId: string;
    terminalId?: string | null;
  }) =>
    request<{
      id: string;
      sku: string;
      name: string;
      packId: string;
      qtyBase: number;
      barcode: string | null;
      exceptionId: string;
    }>('/api/products/quick-add', { method: 'POST', body: JSON.stringify(body) }),

  /** Accept a pending product into the master under the right category. */
  approveProduct: (
    id: string,
    body: Partial<{
      categoryId: string | null;
      name: string;
      sku: string;
      baseUom: string;
      isWeighed: boolean;
      note: string;
    }>,
  ) => request<Product>(`/api/products/${id}/approve`, { method: 'POST', body: JSON.stringify(body) }),

  /** A pending product turns out to be a duplicate; point it at the real one. */
  mergeProduct: (id: string, body: { targetProductId: string; note?: string }) =>
    request<Product>(`/api/products/${id}/merge`, { method: 'POST', body: JSON.stringify(body) }),

  addPack: (productId: string, body: NewPackInput) =>
    request<Pack>(`/api/products/${productId}/packs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updatePack: (
    productId: string,
    packId: string,
    body: Partial<{ label: string; qtyBase: number; isDefaultSell: boolean; isDefaultBuy: boolean; sellPrice: number }>,
  ) =>
    request<unknown>(`/api/products/${productId}/packs/${packId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  attachBarcode: (productId: string, packId: string, code: string) =>
    request<unknown>(`/api/products/${productId}/packs/${packId}/barcodes`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  removeBarcode: (code: string) =>
    request<unknown>(`/api/barcodes/${encodeURIComponent(code)}`, { method: 'DELETE' }),

  stock: (params: { branchId?: string; search?: string; negativeOnly?: boolean; limit?: number } = {}) =>
    request<{ items: StockLine[] }>(`/api/stock${qs(params)}`),

  stockByBranch: () => request<BranchStock[]>('/api/stock/by-branch'),

  movements: (params: { branchId?: string; productId?: string; limit?: number } = {}) =>
    request<{ items: Movement[] }>(`/api/movements${qs(params)}`),

  /**
   * Post one ledger movement directly, in base units. This is what a
   * receiving screen uses: pick a pack, enter a quantity of that pack, the
   * UI multiplies to base units before calling this - the conversion always
   * happens at the edge, never inside the ledger (AD-2).
   */
  postMovement: (body: {
    productId: string;
    branchId: string;
    qtyBase: number;
    reason: string;
    actorId: string;
    unitCost?: number | null;
    docType?: string | null;
    occurredAt?: string;
  }) =>
    request<{ seq: number; eventId: string; replayed: boolean; qtyAfter: number; backdated: boolean }>(
      '/api/movements',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Resolve a scan to its product and pack multiplier. 404 if unlisted. */
  resolveBarcode: (code: string) =>
    request<{
      code: string;
      packId: string;
      productId: string;
      qtyBase: number;
      productName: string;
      packLabel: string;
      sku: string;
      sellPrice: number | null;
    }>(`/api/barcodes/${encodeURIComponent(code)}`),

  // -- sales: baskets, receipts, prices -------------------------------------
  paymentTypes: () => request<PaymentType[]>('/api/payment-types'),

  tills: (branchId: string) => request<Till[]>(`/api/branches/${branchId}/tills`),

  /** Check out a whole basket. The saleId makes a retry the same sale, not a second one. */
  checkout: (body: CheckoutBody) =>
    request<{ receipt: Receipt; replayed: boolean }>('/api/sales/checkout', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  receipt: (saleId: string) => request<Receipt>(`/api/sales/${saleId}`),

  sales: (params: { branchId?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number } = {}) =>
    request<{ items: SaleSummary[]; limit: number; offset: number }>(`/api/sales${qs(params)}`),

  itemReport: (params: { from: string; to: string; branchId?: string; categoryId?: string; search?: string }) =>
    request<ItemReport>(`/api/reports/items${qs({ ...params })}`),

  itemHistory: (
    id: string,
    params: { from: string; to: string; groupBy?: 'day' | 'week' | 'month'; branchId?: string },
  ) => request<ItemHistory>(`/api/reports/items/${id}/history${qs({ ...params })}`),

  // -- buying ------------------------------------------------------------------------------
  suppliers: (params: { q?: string; includeInactive?: boolean } = {}) =>
    request<{ items: SupplierRow[]; financeHidden: boolean }>(`/api/suppliers${qs({ ...params })}`),

  supplier: (id: string) => request<SupplierDetail>(`/api/suppliers/${id}`),

  createSupplier: (body: SupplierInput) =>
    request<{ id: string; code: string; name: string }>('/api/suppliers', { method: 'POST', body: JSON.stringify(body) }),

  updateSupplier: (id: string, body: Partial<SupplierInput> & { isActive?: boolean }) =>
    request<{ ok: true }>(`/api/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  payables: () => request<Payables>('/api/payables'),

  orders: (params: { supplierId?: string; branchId?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) =>
    request<{ items: OrderSummary[]; total: number; financeHidden: boolean }>(`/api/purchase-orders${qs({ ...params })}`),

  order: (id: string) => request<OrderDetail>(`/api/purchase-orders/${id}`),

  createOrder: (body: OrderInput) =>
    request<{ id: string; poNo: string }>('/api/purchase-orders', { method: 'POST', body: JSON.stringify(body) }),

  cancelOrder: (id: string, reason: string) =>
    request<{ ok: true }>(`/api/purchase-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),

  closeOrder: (id: string, reason: string) =>
    request<{ ok: true }>(`/api/purchase-orders/${id}/close`, { method: 'POST', body: JSON.stringify({ reason }) }),

  receiveGoods: (body: GrnInput) =>
    request<{ id: string; grnNo: string; totalCost: number; replayed: boolean }>('/api/goods-received', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  goodsReceived: (params: { supplierId?: string; branchId?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number } = {}) =>
    request<{ items: GrnSummary[]; financeHidden: boolean }>(`/api/goods-received${qs({ ...params })}`),

  goodsReceivedNote: (id: string) => request<GrnDetail>(`/api/goods-received/${id}`),

  supplierPayments: (params: { supplierId?: string; paymentTypeId?: string; from?: string; to?: string; includeVoided?: boolean; limit?: number; offset?: number } = {}) =>
    request<{ items: PaymentRow[]; total: number; count: number }>(`/api/supplier-payments${qs({ ...params })}`),

  supplierPayment: (id: string) => request<PaymentDetail>(`/api/supplier-payments/${id}`),

  paySupplier: (body: PaymentInput) =>
    request<{ id: string; paymentNo: string; replayed: boolean }>('/api/supplier-payments', { method: 'POST', body: JSON.stringify(body) }),

  voidPayment: (id: string, reason: string) =>
    request<{ ok: true }>(`/api/supplier-payments/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) }),

  /** Attach a screenshot, photo or PDF as the raw body; the name travels in a header. */
  attachProof: async (paymentId: string, file: File) => {
    const response = await fetch(`${API_BASE}/api/supplier-payments/${paymentId}/proofs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
    });
    if (!response.ok) {
      let body: ApiErrorBody;
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        body = { error: { code: 'UNKNOWN', message: `${response.status} ${response.statusText}` } };
      }
      throw new ApiError(response.status, body);
    }
    return (await response.json()) as { id: string; contentType: string; sizeBytes: number };
  },

  supplierCashPoints: () => request<{ items: SupplierCashPoint[] }>('/api/supplier-payments/cash-points'),

  returnGoods: (body: ReturnInput) =>
    request<{ id: string; prnNo: string; totalCost: number; replayed: boolean }>('/api/purchase-returns', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  purchaseReturns: (params: { supplierId?: string; branchId?: string; q?: string; limit?: number } = {}) =>
    request<{ items: ReturnSummary[] }>(`/api/purchase-returns${qs({ ...params })}`),

  purchaseReturn: (id: string) => request<ReturnDetail>(`/api/purchase-returns/${id}`),

  proofUrl: (proofId: string) => `${API_BASE}/api/supplier-payments/proofs/${proofId}`,

  postOpeningStock: (body: {
    id: string;
    branchId: string;
    note?: string | null;
    lines: { productId: string; packId: string; qtyPacks: number; unitCost: number | null }[];
  }) =>
    request<{ id: string; docNo: string; totalCost: number; lines: number; linesWithoutCost: number; replayed: boolean }>('/api/opening-stock', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resolveOpeningCodes: (branchId: string, codes: string[]) =>
    request<{ items: { code: string; match: OpeningMatch | null }[] }>('/api/opening-stock/resolve', {
      method: 'POST',
      body: JSON.stringify({ branchId, codes }),
    }),

  openingPositions: (branchId: string) =>
    request<{ items: { productId: string; qtyBase: number }[] }>(`/api/opening-stock/positions${qs({ branchId })}`),

  openingDocs: (params: { branchId?: string; limit?: number } = {}) =>
    request<{ items: OpeningDocSummary[] }>(`/api/opening-stock${qs({ ...params })}`),

  openingDoc: (id: string) => request<OpeningDoc>(`/api/opening-stock/${id}`),

  businessToday: () => request<{ timezone: string; today: string }>('/api/business/today'),

  salesReport: (params: SalesReportParams) =>
    request<SalesReport>(`/api/reports/sales${qs({ ...params })}`),

  priceList: (
    params: { search?: string; categoryId?: string; missingOnly?: boolean; limit?: number; offset?: number } = {},
  ) => request<PriceList>(`/api/price-list${qs(params)}`),

  savePrices: (changes: { packId: string; sellPrice: number | null }[]) =>
    request<{ updated: number; unchanged: number }>('/api/price-list', {
      method: 'PUT',
      body: JSON.stringify({ changes }),
    }),

  fillMissingPrices: (body: { markupPercent: number; roundTo: 0.01 | 0.05 | 0.1 | 0.5 | 1 }) =>
    request<{ updated: number; skippedNoCost: number }>('/api/price-list/fill-missing', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** The scan itself becomes evidence: an unresolved barcode logged as a work item. */
  logUnlistedScan: (body: { code: string; branchId: string; actorId: string }) =>
    request<{ id: string }>('/api/scans/unlisted', { method: 'POST', body: JSON.stringify(body) }),

  /** Post a stock count. Posting is the point - an unposted count changes nothing. */
  postCount: (body: {
    branchId: string;
    actorId: string;
    lines: { productId: string; countedBase: number }[];
  }) =>
    request<{
      docId: string;
      lines: {
        productId: string;
        expected: number;
        counted: number;
        variance: number;
        valueImpact: number | null;
        adjustmentSeq: number | null;
      }[];
      summary: {
        lines: number;
        reconciled: number;
        variances: number;
        netUnits: number;
        netValue: number;
      };
    }>('/api/counts', { method: 'POST', body: JSON.stringify(body) }),

  // -- transfers ---------------------------------------------------------
  transfers: (params: { branchId?: string; state?: TransferState } = {}) =>
    request<{ items: TransferSummary[] }>(`/api/transfers${qs(params)}`),

  transfer: (id: string) => request<TransferDetail>(`/api/transfers/${id}`),

  /** Dispatch stock to another branch. Blocked the same way overselling is. */
  // -- cash custody --------------------------------------------------------
  cashPositions: (params: { branchId?: string } = {}) =>
    request<{ items: CashPointPosition[] }>(`/api/cash${qs(params)}`),

  /** Names only, no balance - for a blind count's "which point" picker. */
  cashPoints: (params: { branchId?: string } = {}) =>
    request<{ items: CashPointRef[] }>(`/api/cash/points${qs(params)}`),

  createCashPoint: (body: {
    branchId: string;
    kind: CashPointKind;
    name: string;
    terminalId?: string | null;
    openingAmount?: number;
  }) => request<CashPointPosition>('/api/cash/points', { method: 'POST', body: JSON.stringify(body) }),

  cashLedger: (params: { cashPointId?: string; limit?: number } = {}) =>
    request<{ items: CashLedgerRow[] }>(`/api/cash/ledger${qs(params)}`),

  openCashPoint: (body: { cashPointId: string; amount: number }) =>
    request<{ seq: number }>('/api/cash/open', { method: 'POST', body: JSON.stringify(body) }),

  moveCash: (body: {
    fromCashPointId: string;
    toCashPointId: string;
    amount: number;
    reason: 'float_issue' | 'float_return' | 'bank_deposit';
  }) => request<{ outSeq: number; inSeq: number }>('/api/cash/move', { method: 'POST', body: JSON.stringify(body) }),

  /** The blind count. Only ever send what was physically counted. */
  postCashCount: (body: { cashPointId: string; countedAmount: number }) =>
    request<{ cashPointId: string; expected: number; counted: number; variance: number }>(
      '/api/cash/count',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  dispatchTransfer: (body: {
    originBranchId: string;
    destinationBranchId: string;
    notes?: string | null;
    lines: { productId: string; qtyDispatched: number }[];
  }) =>
    request<{ id: string; reference: string }>('/api/transfers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Credits the destination for exactly what this call says arrived. */
  receiveTransfer: (id: string, lines: { productId: string; qtyReceived: number }[]) =>
    request<TransferDetail>(`/api/transfers/${id}/receive`, {
      method: 'POST',
      body: JSON.stringify({ lines }),
    }),

  cancelTransfer: (id: string, reason?: string) =>
    request<TransferDetail>(`/api/transfers/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ ...(reason === undefined ? {} : { reason }) }),
    }),

  exceptions: (params: { state?: string; kind?: string; branchId?: string; limit?: number } = {}) =>
    request<ExceptionList>(`/api/exceptions${qs(params)}`),

  /** Clearing requires a named person and a note. The server enforces both. */
  clearException: (id: string, body: { clearedBy: string; note: string }) =>
    request<ExceptionRow>(`/api/exceptions/${id}/clear`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setExceptionState: (id: string, body: { state: 'acknowledged' | 'escalated'; actorId: string }) =>
    request<ExceptionRow>(`/api/exceptions/${id}/state`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reportMovements: (params: {
    from: string;
    to: string;
    groupBy: 'day' | 'week' | 'month' | 'year';
    branchId?: string;
    categoryId?: string;
    productId?: string;
  }) => request<MovementReport>(`/api/reports/movements${qs(params)}`),

  stockLedger: (params: { branchId: string; productId: string; from?: string; to?: string }) =>
    request<StockLedger>(`/api/stock-ledger${qs(params)}`),

  stockReconciliation: (params: {
    branchId: string;
    from?: string;
    to?: string;
    search?: string;
    limit?: number;
  }) => request<StockReconciliation>(`/api/stock-reconciliation${qs(params)}`),

  stockResetPreview: (branchId: string) =>
    request<ResetPreview>(`/api/branches/${branchId}/stock-reset/preview`),

  /** Cannot be undone. The server re-reads the stock and refuses if it differs from what was previewed. */
  resetBranchStock: (
    branchId: string,
    body: { confirmCode: string; reason: string; expectedPositions: number },
  ) =>
    request<ResetResult>(`/api/branches/${branchId}/stock-reset`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  settings: () => request<SettingRow[]>('/api/settings'),

  updateSetting: (key: string, value: string) =>
    request<SettingRow>(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    }),
};
