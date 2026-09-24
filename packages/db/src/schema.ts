/**
 * Kysely type definitions for the core schema.
 *
 * Hand-written against `migrations/001_core.sql`, which is the source of truth
 * (HANDOFF section 7). These types describe the schema; they never define it.
 * If the two disagree, the SQL is right and this file is wrong.
 *
 * Kysely gives typed queries over that schema without an ORM. The schema leans
 * on triggers, partial unique indexes and views that an ORM would fight.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** Set by the database on insert, never written by us, not updatable. */
type Timestamp = ColumnType<Date, Date | string | undefined, never>;
/** Business time. We always supply it - that is the point of occurred_at. */
type SuppliedTimestamp = ColumnType<Date, Date | string, Date | string>;

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
  | 'opening_balance';

export type ExceptionKind =
  | 'negative_stock_override'
  | 'unlisted_barcode_scan'
  | 'backdated_entry'
  | 'count_variance'
  | 'transit_loss'
  | 'cash_variance'
  | 'price_override'
  | 'void_after_tender'
  | 'unreviewed_product';

export type ProductReviewState = 'approved' | 'pending';

export type ExceptionState = 'open' | 'acknowledged' | 'cleared' | 'escalated';

export interface BranchTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: ColumnType<BranchKind, BranchKind | undefined, BranchKind>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

export interface TerminalTable {
  id: Generated<string>;
  branch_id: string;
  code: string;
  /** Sync cursor: the highest stock_movement.seq this terminal has pulled. */
  last_synced_seq: ColumnType<number, number | undefined, number>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface PersonTable {
  id: Generated<string>;
  full_name: string;
  /**
   * Nullable by design. Populating it engages the Cyber and Data Protection
   * Act [Chapter 12:07]; it points at a separately permissioned vault table,
   * never at a plain column. Do not make this NOT NULL without a signed
   * lawful-basis assessment (HANDOFF section 3.2).
   */
  national_id_ref: string | null;
  phone: string | null;
  email: string | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

export interface RoleTable {
  id: string;
  name: string;
}

export interface PersonRoleTable {
  /** Surrogate key: see migration 002. branch_id is nullable, so it cannot
   *  take part in a composite primary key. */
  id: Generated<string>;
  person_id: string;
  role_id: string;
  /** NULL means the role is group-wide rather than scoped to one branch. */
  branch_id: string | null;
}

export interface ProductCategoryTable {
  id: Generated<string>;
  parent_id: string | null;
  name: string;
}

export interface ProductTable {
  id: Generated<string>;
  sku: string;
  name: string;
  category_id: string | null;
  base_uom: string;
  is_weighed: ColumnType<boolean, boolean | undefined, boolean>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  /** Set during master-data cleanse. Merged products keep history, reject movements. */
  merged_into_id: string | null;
  /** 'pending' when created via quick-add at the till; a work item until reviewed. */
  review_state: ColumnType<ProductReviewState, ProductReviewState | undefined, ProductReviewState>;
  created_by: string | null;
}

export interface ProductPackTable {
  id: Generated<string>;
  product_id: string;
  label: string;
  /** How many base units this pack contains. Case of 10 -> 10. */
  qty_base: number;
  is_default_sell: ColumnType<boolean, boolean | undefined, boolean>;
  is_default_buy: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface BarcodeTable {
  /** PRIMARY KEY. One code, one pack, one product, one multiplier. */
  code: string;
  pack_id: string;
  symbology: ColumnType<string, string | undefined, string>;
  created_at: Timestamp;
}

/**
 * The append-only ledger.
 *
 * UPDATE and DELETE raise in the database via `ledger_is_append_only()`. The
 * Updateable type is therefore a lie the compiler should never let anyone
 * tell: every column is `never` for update.
 */
export interface StockMovementTable {
  seq: Generated<number>;
  event_id: string;
  product_id: string;
  branch_id: string;
  qty_base: number;
  unit_cost: number | null;
  currency: ColumnType<string, string | undefined, never>;
  reason: MovementReason;
  doc_type: string | null;
  doc_id: string | null;
  reverses_seq: number | null;
  actor_id: string;
  terminal_id: string | null;
  occurred_at: ColumnType<Date, Date | string, never>;
  recorded_at: Timestamp;
}

export interface ExceptionEventTable {
  id: Generated<string>;
  event_id: string;
  kind: ExceptionKind;
  state: ColumnType<ExceptionState, ExceptionState | undefined, ExceptionState>;
  branch_id: string;
  terminal_id: string | null;
  actor_id: string;
  product_id: string | null;
  detail: ColumnType<Record<string, unknown>, string | undefined, string>;
  value_impact: number | null;
  currency: string | null;
  occurred_at: SuppliedTimestamp;
  recorded_at: Timestamp;
  /** CHECK: a cleared row must carry both a person and a time. */
  cleared_by: string | null;
  cleared_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  clearing_note: string | null;
}

export interface AuditLogTable {
  seq: Generated<number>;
  event_id: string;
  action_code: string;
  actor_id: string | null;
  terminal_id: string | null;
  branch_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  state_before: ColumnType<Record<string, unknown> | null, string | null, never>;
  state_after: ColumnType<Record<string, unknown> | null, string | null, never>;
  occurred_at: ColumnType<Date, Date | string, never>;
  recorded_at: Timestamp;
}

/** VIEW. Stock is SUM(qty_base) and is never stored (AD-1). */
export interface StockOnHandView {
  product_id: string;
  branch_id: string;
  qty_base: number;
}

/** VIEW. Weighted-average cost, derived from receipt movements only. */
export interface ProductWacView {
  product_id: string;
  branch_id: string;
  wac: number | null;
}

/** VIEW. Movements whose recorded_at outruns occurred_at by over 48 hours. */
export interface BackdatedMovementView {
  seq: number;
  event_id: string;
  branch_id: string;
  product_id: string;
  actor_id: string;
  occurred_at: Date;
  recorded_at: Date;
  backdate_gap: string;
}

/** Sign-in credentials, one row per person. See migration 003. */
export interface UserCredentialTable {
  person_id: string;
  email: string;
  password_hash: string;
  password_algo: ColumnType<string, string | undefined, string>;
  must_change_password: ColumnType<boolean, boolean | undefined, boolean>;
  failed_attempts: ColumnType<number, number | undefined, number>;
  locked_until: ColumnType<Date | null, Date | string | null, Date | string | null>;
  last_login_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: Timestamp;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Live and historic sessions.
 *
 * `token_hash` is the SHA-256 of the cookie value; the value itself is never
 * stored. Sessions are revoked rather than deleted, so who was signed in when
 * something happened stays answerable (HANDOFF section 10).
 */
export interface UserSessionTable {
  id: Generated<string>;
  token_hash: string;
  person_id: string;
  issued_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revoked_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface PermissionTable {
  id: string;
  description: string;
}

/** Named capabilities granted to a role, not a rank ordering. */
export interface RolePermissionTable {
  role_id: string;
  permission_id: string;
}

export type TransferState = 'dispatched' | 'received' | 'cancelled';

/**
 * Branch-to-branch transfer. See migration 004: the workflow state lives
 * here, the ledger only ever records the two definitive events (dispatch,
 * confirmed receipt).
 */
export interface TransferTable {
  id: Generated<string>;
  reference: string;
  origin_branch_id: string;
  destination_branch_id: string;
  state: ColumnType<TransferState, TransferState | undefined, TransferState>;
  dispatched_by: string;
  dispatched_at: SuppliedTimestamp;
  received_by: string | null;
  received_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelled_by: string | null;
  cancelled_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  notes: string | null;
}

export interface TransferLineTable {
  id: Generated<string>;
  transfer_id: string;
  product_id: string;
  /** What left the origin, in base units. Set at dispatch, never revised. */
  qty_dispatched: number;
  /** What arrived, in base units. NULL until received. */
  qty_received: number | null;
  unit_cost: number | null;
  dispatch_movement_seq: number | null;
  receipt_movement_seq: number | null;
}

export type CashPointKind = 'till' | 'safe' | 'petty' | 'bank';

export type CashReason =
  | 'opening_balance'
  | 'float_issue'
  | 'float_return'
  | 'bank_deposit'
  | 'cash_variance'
  | 'petty_disbursement'
  | 'write_off';

/** One row per place cash can sit. See migration 005. */
export interface CashPointTable {
  id: Generated<string>;
  branch_id: string;
  kind: CashPointKind;
  terminal_id: string | null;
  name: string;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
}

/**
 * Append-only cash ledger - the same discipline as stock_movement, applied
 * to cash. Cash on hand is SUM(amount), never a stored balance.
 */
export interface CashMovementTable {
  seq: Generated<number>;
  event_id: string;
  cash_point_id: string;
  amount: number;
  currency: ColumnType<string, string | undefined, string>;
  reason: CashReason;
  doc_type: string | null;
  doc_id: string | null;
  counterpart_seq: number | null;
  actor_id: string;
  terminal_id: string | null;
  occurred_at: ColumnType<Date, Date | string, never>;
  recorded_at: Timestamp;
}

/** VIEW. Cash on hand at one custody point. */
export interface CashOnHandView {
  cash_point_id: string;
  amount: number;
}

/**
 * Operator-adjustable limits and toggles - key/value rather than bespoke
 * columns, because the point of these is changing them without a deploy.
 * See migration 006.
 */
export interface SystemSettingTable {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: Timestamp;
}

/** Applied-migration log. Owned by the runner, not by 001_core.sql. */
export interface SchemaMigrationTable {
  filename: string;
  checksum: string;
  applied_at: Timestamp;
}

export interface Database {
  branch: BranchTable;
  terminal: TerminalTable;
  person: PersonTable;
  role: RoleTable;
  person_role: PersonRoleTable;
  product_category: ProductCategoryTable;
  product: ProductTable;
  product_pack: ProductPackTable;
  barcode: BarcodeTable;
  stock_movement: StockMovementTable;
  exception_event: ExceptionEventTable;
  audit_log: AuditLogTable;
  user_credential: UserCredentialTable;
  user_session: UserSessionTable;
  permission: PermissionTable;
  role_permission: RolePermissionTable;
  transfer: TransferTable;
  transfer_line: TransferLineTable;
  cash_point: CashPointTable;
  cash_movement: CashMovementTable;
  cash_on_hand: CashOnHandView;
  system_setting: SystemSettingTable;
  schema_migration: SchemaMigrationTable;
  stock_on_hand: StockOnHandView;
  product_wac: ProductWacView;
  backdated_movement: BackdatedMovementView;
}

export type Branch = Selectable<BranchTable>;
export type NewBranch = Insertable<BranchTable>;
export type Person = Selectable<PersonTable>;
export type NewPerson = Insertable<PersonTable>;
export type Product = Selectable<ProductTable>;
export type NewProduct = Insertable<ProductTable>;
export type ProductUpdate = Updateable<ProductTable>;
export type ProductPack = Selectable<ProductPackTable>;
export type NewProductPack = Insertable<ProductPackTable>;
export type Barcode = Selectable<BarcodeTable>;
export type NewBarcode = Insertable<BarcodeTable>;
export type StockMovement = Selectable<StockMovementTable>;
export type NewStockMovement = Insertable<StockMovementTable>;
export type ExceptionEvent = Selectable<ExceptionEventTable>;
export type NewExceptionEvent = Insertable<ExceptionEventTable>;
