/**
 * Buying: purchase orders, goods received notes, and paying suppliers.
 *
 * Each of these is ONE atomic document, like a sale:
 *
 *   purchase order   the request for supplies. Lines are fixed once placed; it
 *                    can only be cancelled, or closed short.
 *   goods received   what actually arrived, at what cost. Posting it writes the
 *                    stock movements (reason 'grn') and the document together or
 *                    not at all, and is idempotent on the id the client made.
 *   payment          money paid to a supplier. Never edited; a mistake is voided.
 *
 * What is owed to a supplier is not stored. It is goods received at cost less
 * payments not voided - see the supplier_balance view - so it cannot drift from
 * the documents behind it.
 *
 * Numbering is gapless: taken last in the transaction, a document that fails
 * takes no number.
 */

import { createHash } from 'node:crypto';

import {
  ageDeliveries,
  costLineCents,
  costPerBaseUnit,
  dueDate,
  fromCents,
  InsufficientCash,
  InvalidPurchase,
  NegativeStockBlocked,
  paymentTiming,
  PaymentAlreadyVoided,
  ProofRejected,
  PurchaseOrderNotOpen,
  PurchasingDocumentNotFound,
  runStatement,
  toCents,
  type PaymentTiming,
  type SupplierTerms,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { onHand as cashOnHand, post as postCash } from './cash.js';
import { postMovementInTx, wac } from './stock.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

// -- business calendar -----------------------------------------------------------------------------

const DEFAULT_TIMEZONE = 'Africa/Harare';

export async function businessTimezone(db: Db | Tx): Promise<string> {
  const row = await db.selectFrom('system_setting').select('value').where('key', '=', 'business_timezone').executeTakeFirst();
  return row?.value.trim() || DEFAULT_TIMEZONE;
}

/** The business calendar day ('YYYY-MM-DD') an instant falls on. */
export function dayIn(tz: string, at: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

// -- numbering ----------------------------------------------------------------------------------------

export async function branchNumber(tx: Tx, branchId: string, kind: string, code: string): Promise<string> {
  const r = await sql<{ lastNo: number }>`
    INSERT INTO document_counter (branch_id, doc_kind, last_no) VALUES (${branchId}::uuid, ${kind}, 1)
    ON CONFLICT (branch_id, doc_kind) DO UPDATE SET last_no = document_counter.last_no + 1
    RETURNING last_no AS "lastNo"`.execute(tx);
  return `${code}-${kind}-${String(Number(r.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;
}

async function groupNumber(tx: Tx, kind: string): Promise<string> {
  const r = await sql<{ lastNo: number }>`
    INSERT INTO group_counter (doc_kind, last_no) VALUES (${kind}, 1)
    ON CONFLICT (doc_kind) DO UPDATE SET last_no = group_counter.last_no + 1
    RETURNING last_no AS "lastNo"`.execute(tx);
  return `${kind}-${String(Number(r.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;
}

async function audit(
  tx: Tx,
  action: string,
  actorId: string,
  branchId: string | null,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
  before: Record<string, unknown> | null = null,
): Promise<void> {
  await tx
    .insertInto('audit_log')
    .values({
      event_id: crypto.randomUUID(),
      action_code: action,
      actor_id: actorId,
      terminal_id: null,
      branch_id: branchId,
      entity_type: entityType,
      entity_id: entityId,
      state_before: before === null ? null : JSON.stringify(before),
      state_after: JSON.stringify(after),
      occurred_at: new Date(),
    })
    .execute();
}

// -- purchase orders --------------------------------------------------------------------------------------------

export interface OrderLineInput {
  productId: string;
  packId: string;
  qtyPacks: number;
  /** Price agreed for ONE PACK. */
  unitCost: number;
}

export interface PurchaseOrderInput {
  supplierId: string;
  branchId: string;
  orderedBy: string;
  expectedDate?: string | null;
  terms?: SupplierTerms | undefined;
  creditDays?: number | null | undefined;
  notes?: string | null;
  lines: OrderLineInput[];
}

interface PackInfo {
  packId: string;
  productId: string;
  qtyBase: number;
  name: string;
  sku: string;
  merged: boolean;
}

async function loadPacks(tx: Tx | Db, packIds: string[]): Promise<Map<string, PackInfo>> {
  const rows = await tx
    .selectFrom('product_pack')
    .innerJoin('product', 'product.id', 'product_pack.product_id')
    .select([
      'product_pack.id as packId',
      'product_pack.product_id as productId',
      'product_pack.qty_base as qtyBase',
      'product.name as name',
      'product.sku as sku',
      'product.merged_into_id as mergedInto',
    ])
    .where('product_pack.id', 'in', packIds)
    .execute();
  return new Map(
    rows.map((r) => [r.packId, { packId: r.packId, productId: r.productId, qtyBase: Number(r.qtyBase), name: r.name, sku: r.sku, merged: r.mergedInto !== null }]),
  );
}

function checkLines(lines: { productId: string; packId: string }[], packs: Map<string, PackInfo>): void {
  if (lines.length === 0) throw new InvalidPurchase('Add at least one item.');
  for (const l of lines) {
    const p = packs.get(l.packId);
    if (p === undefined || p.productId !== l.productId) throw new InvalidPurchase('An item is not a known product and pack.');
    if (p.merged) throw new InvalidPurchase(`${p.name} was merged into another product; order the product it was merged into.`);
  }
}

export async function createPurchaseOrder(db: Db, input: PurchaseOrderInput): Promise<{ id: string; poNo: string }> {
  return db.transaction().execute(async (tx) => {
    const supplier = await tx
      .selectFrom('supplier')
      .select(['id', 'name', 'is_active', 'terms', 'credit_days'])
      .where('id', '=', input.supplierId)
      .executeTakeFirst();
    if (supplier === undefined) throw new PurchasingDocumentNotFound('supplier', input.supplierId);
    if (!supplier.is_active) throw new InvalidPurchase(`${supplier.name} is not an active supplier.`);

    const branch = await tx.selectFrom('branch').select(['id', 'code', 'is_active']).where('id', '=', input.branchId).executeTakeFirst();
    if (branch === undefined || !branch.is_active) throw new InvalidPurchase('That branch is not available to deliver to.');

    const packs = await loadPacks(tx, [...new Set(input.lines.map((l) => l.packId))]);
    checkLines(input.lines, packs);

    const terms = input.terms ?? supplier.terms;
    const creditDays = terms === 'credit' ? (input.creditDays ?? supplier.credit_days ?? 0) : null;

    const priced = input.lines.map((l, i) => {
      const pack = packs.get(l.packId)!;
      return {
        line_no: i + 1,
        product_id: l.productId,
        pack_id: l.packId,
        qty_packs: l.qtyPacks,
        qty_base: round4(l.qtyPacks * pack.qtyBase),
        unit_cost: l.unitCost,
        line_total: fromCents(costLineCents(l.qtyPacks, l.unitCost)),
      };
    });

    const poNo = await branchNumber(tx, input.branchId, 'PO', branch.code);
    const po = await tx
      .insertInto('purchase_order')
      .values({
        po_no: poNo,
        supplier_id: input.supplierId,
        branch_id: input.branchId,
        ordered_by: input.orderedBy,
        expected_date: input.expectedDate ?? null,
        terms,
        credit_days: creditDays,
        notes: input.notes ?? null,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        closed_at: null,
        closed_by: null,
        close_note: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('purchase_order_line').values(priced.map((p) => ({ ...p, po_id: po.id }))).execute();

    await audit(tx, 'PO_PLACED', input.orderedBy, input.branchId, 'purchase_order', po.id, {
      poNo,
      supplier: supplier.name,
      lines: priced.length,
      total: fromCents(priced.reduce((s, p) => s + toCents(p.line_total), 0)),
    });
    return { id: po.id, poNo };
  });
}

export async function cancelPurchaseOrder(db: Db, id: string, by: string, reason: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const po = await tx.selectFrom('purchase_order').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', id);
    if (po.cancelled_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'already cancelled');
    if (po.closed_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'already closed');
    const received = await sql<{ n: number }>`SELECT count(*)::int AS n FROM goods_received WHERE po_id = ${id}`.execute(tx);
    if (Number(received.rows[0]?.n) > 0) {
      throw new InvalidPurchase(`${po.po_no} has goods received against it, so it cannot be cancelled. Close it instead to stop expecting the rest.`);
    }
    await sql`UPDATE purchase_order SET cancelled_at = now(), cancelled_by = ${by}::uuid, cancel_reason = ${reason} WHERE id = ${id}::uuid`.execute(tx);
    await audit(tx, 'PO_CANCELLED', by, po.branch_id, 'purchase_order', id, { poNo: po.po_no, reason });
  });
}

export async function closePurchaseOrder(db: Db, id: string, by: string, note: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const po = await tx.selectFrom('purchase_order').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', id);
    if (po.cancelled_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'cancelled');
    if (po.closed_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'already closed');
    await sql`UPDATE purchase_order SET closed_at = now(), closed_by = ${by}::uuid, close_note = ${note} WHERE id = ${id}::uuid`.execute(tx);
    await audit(tx, 'PO_CLOSED', by, po.branch_id, 'purchase_order', id, { poNo: po.po_no, note });
  });
}

export type PoStatus = 'ordered' | 'part_received' | 'received' | 'closed' | 'cancelled';
export type PoPayment = 'unpaid' | 'part_paid' | 'paid';

/** Where an order stands, from what was ordered against what has arrived. */
export function poStatus(header: { cancelled_at: unknown; closed_at: unknown }, lines: { ordered: number; received: number }[]): PoStatus {
  if (header.cancelled_at !== null) return 'cancelled';
  if (header.closed_at !== null) return 'closed';
  const any = lines.some((l) => l.received > 0);
  if (!any) return 'ordered';
  return lines.every((l) => l.received + 1e-9 >= l.ordered) ? 'received' : 'part_received';
}

// -- goods received -------------------------------------------------------------------------------------------------

export interface GrnLineInput {
  productId: string;
  packId: string;
  qtyPacks: number;
  /** What was actually charged for ONE PACK. */
  unitCost: number;
  poLineId?: string | null | undefined;
}

export interface GrnInput {
  id: string;
  branchId: string;
  supplierId: string;
  poId?: string | null | undefined;
  receivedBy: string;
  supplierInvoiceNo?: string | null | undefined;
  invoiceDate?: string | null | undefined;
  invoiceTotal?: number | null | undefined;
  notes?: string | null | undefined;
  lines: GrnLineInput[];
}

export async function receiveGoods(db: Db, input: GrnInput): Promise<{ id: string; grnNo: string; totalCost: number; replayed: boolean }> {
  const existing = await db.selectFrom('goods_received').select(['id', 'grn_no', 'total_cost']).where('id', '=', input.id).executeTakeFirst();
  if (existing !== undefined) return { id: existing.id, grnNo: existing.grn_no, totalCost: Number(existing.total_cost), replayed: true };

  try {
    const r = await db.transaction().execute((tx) => runReceive(tx, input));
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'goods_received_pkey') {
      const won = await db.selectFrom('goods_received').select(['id', 'grn_no', 'total_cost']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, grnNo: won.grn_no, totalCost: Number(won.total_cost), replayed: true };
    }
    throw error;
  }
}

async function runReceive(tx: Tx, input: GrnInput): Promise<{ id: string; grnNo: string; totalCost: number }> {
  const supplier = await tx.selectFrom('supplier').select(['id', 'name', 'is_active']).where('id', '=', input.supplierId).executeTakeFirst();
  if (supplier === undefined) throw new PurchasingDocumentNotFound('supplier', input.supplierId);
  if (!supplier.is_active) throw new InvalidPurchase(`${supplier.name} is not an active supplier.`);

  const branch = await tx.selectFrom('branch').select(['id', 'code', 'is_active']).where('id', '=', input.branchId).executeTakeFirst();
  if (branch === undefined || !branch.is_active) throw new InvalidPurchase('That branch is not available to receive goods.');

  const packs = await loadPacks(tx, [...new Set(input.lines.map((l) => l.packId))]);
  checkLines(input.lines, packs);

  // -- the order this delivery is against, if any -----------------------------------------------------------
  let poLineIds = new Map<string, { productId: string }>();
  if (input.poId !== undefined && input.poId !== null) {
    const po = await tx.selectFrom('purchase_order').selectAll().where('id', '=', input.poId).executeTakeFirst();
    if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', input.poId);
    if (po.supplier_id !== input.supplierId) throw new InvalidPurchase(`${po.po_no} was placed with a different supplier.`);
    if (po.branch_id !== input.branchId) throw new InvalidPurchase(`${po.po_no} is for a different branch.`);
    if (po.cancelled_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'cancelled');
    if (po.closed_at !== null) throw new PurchaseOrderNotOpen(po.po_no, 'closed');
    const pl = await tx.selectFrom('purchase_order_line').select(['id', 'product_id']).where('po_id', '=', input.poId).execute();
    poLineIds = new Map(pl.map((l) => [l.id, { productId: l.product_id }]));
  }
  for (const l of input.lines) {
    if (l.poLineId !== undefined && l.poLineId !== null) {
      const pl = poLineIds.get(l.poLineId);
      if (pl === undefined) throw new InvalidPurchase('A line points at an order line that is not on this order.');
      if (pl.productId !== l.productId) throw new InvalidPurchase('A line does not match the product on the order line it points at.');
    }
  }

  const occurredAt = new Date();
  const priced = input.lines.map((l, index) => {
    const pack = packs.get(l.packId)!;
    const cents = costLineCents(l.qtyPacks, l.unitCost);
    return { index, l, pack, cents, qtyBase: round4(l.qtyPacks * pack.qtyBase), costBase: costPerBaseUnit(l.unitCost, pack.qtyBase) };
  });
  const totalCents = priced.reduce((s, p) => s + p.cents, 0);

  // -- stock in, in a fixed order so two deliveries cannot deadlock --------------------------------------------
  const seqByIndex = new Map<number, number>();
  for (const p of [...priced].sort((a, b) => a.pack.productId.localeCompare(b.pack.productId) || a.index - b.index)) {
    const posted = await postMovementInTx(tx, {
      productId: p.pack.productId,
      branchId: input.branchId,
      qtyBase: p.qtyBase,
      reason: 'grn',
      actorId: input.receivedBy,
      unitCost: p.costBase,
      docType: 'GRN',
      docId: input.id,
      occurredAt,
    });
    seqByIndex.set(p.index, posted.seq);
  }

  const grnNo = await branchNumber(tx, input.branchId, 'GRN', branch.code);
  await tx
    .insertInto('goods_received')
    .values({
      id: input.id,
      grn_no: grnNo,
      supplier_id: input.supplierId,
      branch_id: input.branchId,
      po_id: input.poId ?? null,
      received_by: input.receivedBy,
      received_at: occurredAt,
      supplier_invoice_no: input.supplierInvoiceNo ?? null,
      invoice_date: input.invoiceDate ?? null,
      invoice_total: input.invoiceTotal ?? null,
      notes: input.notes ?? null,
      total_cost: fromCents(totalCents),
    })
    .execute();
  await tx
    .insertInto('goods_received_line')
    .values(
      priced.map((p) => ({
        grn_id: input.id,
        line_no: p.index + 1,
        po_line_id: p.l.poLineId ?? null,
        product_id: p.pack.productId,
        pack_id: p.pack.packId,
        qty_packs: p.l.qtyPacks,
        qty_base: p.qtyBase,
        unit_cost: p.l.unitCost,
        line_total: fromCents(p.cents),
        movement_seq: seqByIndex.get(p.index) ?? 0,
      })),
    )
    .execute();

  await audit(tx, 'GRN_POSTED', input.receivedBy, input.branchId, 'goods_received', input.id, {
    grnNo,
    supplier: supplier.name,
    lines: priced.length,
    total: fromCents(totalCents),
    invoiceNo: input.supplierInvoiceNo ?? null,
  });
  return { id: input.id, grnNo, totalCost: fromCents(totalCents) };
}

// -- returns to the supplier -----------------------------------------------------------------------------------------

export interface ReturnLineInput {
  productId: string;
  packId: string;
  qtyPacks: number;
  /** Per pack. Left out: the cost it came in at (its delivery line, else the branch's average cost). */
  unitCost?: number | null | undefined;
  grnLineId?: string | null | undefined;
}

export interface ReturnInput {
  id: string;
  supplierId: string;
  branchId: string;
  grnId?: string | null | undefined;
  returnedBy: string;
  reason: string;
  creditNoteNo?: string | null | undefined;
  lines: ReturnLineInput[];
}

/**
 * Send goods back to a supplier. The stock leaves at what it cost (reason
 * 'grn_reversal'), and what is owed to the supplier goes down by the same. A
 * line against a delivery cannot send back more than that delivery brought in,
 * less what has already gone back; no line can send back more than is on hand.
 */
export async function returnGoods(db: Db, input: ReturnInput): Promise<{ id: string; prnNo: string; totalCost: number; replayed: boolean }> {
  const existing = await db.selectFrom('purchase_return').select(['id', 'prn_no', 'total_cost']).where('id', '=', input.id).executeTakeFirst();
  if (existing !== undefined) return { id: existing.id, prnNo: existing.prn_no, totalCost: Number(existing.total_cost), replayed: true };
  try {
    const r = await db.transaction().execute((tx) => runReturn(tx, input));
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'purchase_return_pkey') {
      const won = await db.selectFrom('purchase_return').select(['id', 'prn_no', 'total_cost']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, prnNo: won.prn_no, totalCost: Number(won.total_cost), replayed: true };
    }
    throw error;
  }
}

async function runReturn(tx: Tx, input: ReturnInput): Promise<{ id: string; prnNo: string; totalCost: number }> {
  if (input.reason.trim().length < 3) throw new InvalidPurchase('Say why the goods are going back.');
  const supplier = await tx.selectFrom('supplier').select(['id', 'name']).where('id', '=', input.supplierId).executeTakeFirst();
  if (supplier === undefined) throw new PurchasingDocumentNotFound('supplier', input.supplierId);
  const branch = await tx.selectFrom('branch').select(['id', 'code', 'is_active']).where('id', '=', input.branchId).executeTakeFirst();
  if (branch === undefined || !branch.is_active) throw new InvalidPurchase('That branch is not available.');

  const packs = await loadPacks(tx, [...new Set(input.lines.map((l) => l.packId))]);
  checkLines(input.lines, packs);

  // The delivery the goods came in on, and what each of its lines can still send back.
  const grnLines = new Map<string, { productId: string; qtyBase: number; costPerBase: number; returnedBase: number; grnNo: string }>();
  if (input.grnId !== undefined && input.grnId !== null) {
    const g = await tx.selectFrom('goods_received').select(['id', 'grn_no', 'supplier_id', 'branch_id']).where('id', '=', input.grnId).executeTakeFirst();
    if (g === undefined) throw new PurchasingDocumentNotFound('goods received note', input.grnId);
    if (g.supplier_id !== input.supplierId) throw new InvalidPurchase(`${g.grn_no} came from a different supplier.`);
    if (g.branch_id !== input.branchId) throw new InvalidPurchase(`${g.grn_no} was received at a different branch.`);
    const rows = await sql<{ id: string; productId: string; qtyBase: number; qtyPacks: number; unitCost: number; returnedBase: number }>`
      SELECT l.id, l.product_id AS "productId", l.qty_base AS "qtyBase", l.qty_packs AS "qtyPacks", l.unit_cost AS "unitCost",
             coalesce((SELECT sum(r.qty_base) FROM purchase_return_line r WHERE r.grn_line_id = l.id), 0) AS "returnedBase"
      FROM goods_received_line l WHERE l.grn_id = ${input.grnId}::uuid FOR UPDATE`.execute(tx);
    for (const r of rows.rows) {
      grnLines.set(r.id, {
        productId: r.productId,
        qtyBase: Number(r.qtyBase),
        // What one base unit cost on that delivery.
        costPerBase: (Number(r.unitCost) * Number(r.qtyPacks)) / Number(r.qtyBase),
        returnedBase: Number(r.returnedBase),
        grnNo: g.grn_no,
      });
    }
  }

  const wanted = new Map<string, number>();
  const priced = [];
  for (const [index, l] of input.lines.entries()) {
    const pack = packs.get(l.packId)!;
    const qtyBase = round4(l.qtyPacks * pack.qtyBase);
    let unitCost = l.unitCost ?? null;
    if (l.grnLineId !== undefined && l.grnLineId !== null) {
      const gl = grnLines.get(l.grnLineId);
      if (gl === undefined) throw new InvalidPurchase('A line points at a delivery line that is not on that delivery.');
      if (gl.productId !== l.productId) throw new InvalidPurchase('A line does not match the product on the delivery line it points at.');
      const total = (wanted.get(l.grnLineId) ?? 0) + qtyBase;
      wanted.set(l.grnLineId, total);
      if (total + gl.returnedBase > gl.qtyBase + 1e-9) {
        throw new InvalidPurchase(
          `${pack.name}: ${gl.grnNo} brought in ${gl.qtyBase}${gl.returnedBase > 0 ? `, ${gl.returnedBase} already went back,` : ''} so at most ${round4(gl.qtyBase - gl.returnedBase)} can be returned against it.`,
        );
      }
      unitCost ??= Math.round(gl.costPerBase * pack.qtyBase * 10_000) / 10_000;
    }
    if (unitCost === null) {
      const avg = await wac(tx, l.productId, input.branchId);
      if (avg === null) throw new InvalidPurchase(`${pack.name} has no cost on record here. Enter the cost the supplier is crediting.`);
      unitCost = Math.round(Number(avg) * pack.qtyBase * 10_000) / 10_000;
    }
    priced.push({ index, l, pack, qtyBase, unitCost, cents: costLineCents(l.qtyPacks, unitCost) });
  }

  const at = new Date();
  const seqByIndex = new Map<number, number>();
  for (const p of [...priced].sort((a, b) => a.pack.productId.localeCompare(b.pack.productId) || a.index - b.index)) {
    try {
      const posted = await postMovementInTx(tx, {
        productId: p.pack.productId,
        branchId: input.branchId,
        qtyBase: -p.qtyBase,
        reason: 'grn_reversal',
        actorId: input.returnedBy,
        unitCost: costPerBaseUnit(p.unitCost, p.pack.qtyBase),
        docType: 'PRN',
        docId: input.id,
        occurredAt: at,
      });
      seqByIndex.set(p.index, posted.seq);
    } catch (error) {
      // Nothing can go back that is not on the shelf; say which item.
      if (error instanceof NegativeStockBlocked) Object.assign(error.detail, { productId: p.pack.productId, productName: p.pack.name });
      throw error;
    }
  }

  const totalCents = priced.reduce((s, p) => s + p.cents, 0);
  const prnNo = await branchNumber(tx, input.branchId, 'PRN', branch.code);
  await tx
    .insertInto('purchase_return')
    .values({
      id: input.id,
      prn_no: prnNo,
      supplier_id: input.supplierId,
      branch_id: input.branchId,
      grn_id: input.grnId ?? null,
      returned_by: input.returnedBy,
      returned_at: at,
      reason: input.reason.trim(),
      credit_note_no: input.creditNoteNo ?? null,
      total_cost: fromCents(totalCents),
    })
    .execute();
  await tx
    .insertInto('purchase_return_line')
    .values(
      priced.map((p) => ({
        return_id: input.id,
        line_no: p.index + 1,
        grn_line_id: p.l.grnLineId ?? null,
        product_id: p.pack.productId,
        pack_id: p.pack.packId,
        qty_packs: p.l.qtyPacks,
        qty_base: p.qtyBase,
        unit_cost: p.unitCost,
        line_total: fromCents(p.cents),
        movement_seq: seqByIndex.get(p.index) ?? 0,
      })),
    )
    .execute();
  await audit(tx, 'PURCHASE_RETURN_POSTED', input.returnedBy, input.branchId, 'purchase_return', input.id, {
    prnNo,
    supplier: supplier.name,
    lines: priced.length,
    total: fromCents(totalCents),
    reason: input.reason.trim(),
  });
  return { id: input.id, prnNo, totalCost: fromCents(totalCents) };
}

// -- paying suppliers ---------------------------------------------------------------------------------------------------

export interface PaymentInput {
  id: string;
  supplierId: string;
  amount: number;
  paymentTypeId: string;
  reference?: string | null | undefined;
  paidAt?: Date | undefined;
  poId?: string | null | undefined;
  grnId?: string | null | undefined;
  note?: string | null | undefined;
  /** For cash: the safe, petty cash or till it was paid out of. */
  cashPointId?: string | null | undefined;
  recordedBy: string;
}

export async function recordPayment(db: Db, input: PaymentInput): Promise<{ id: string; paymentNo: string; replayed: boolean }> {
  const existing = await db.selectFrom('supplier_payment').select(['id', 'payment_no']).where('id', '=', input.id).executeTakeFirst();
  if (existing !== undefined) return { id: existing.id, paymentNo: existing.payment_no, replayed: true };

  try {
    const r = await db.transaction().execute(async (tx) => {
      const supplier = await tx.selectFrom('supplier').select(['id', 'name']).where('id', '=', input.supplierId).executeTakeFirst();
      if (supplier === undefined) throw new PurchasingDocumentNotFound('supplier', input.supplierId);

      const method = await tx
        .selectFrom('payment_type')
        .select(['id', 'name', 'is_cash', 'for_suppliers', 'is_active'])
        .where('id', '=', input.paymentTypeId)
        .executeTakeFirst();
      if (method === undefined || !method.is_active || !method.for_suppliers) throw new InvalidPurchase('Choose how it was paid: that method is not available for suppliers.');
      // Cash leaves no trace of its own; anything else has a number someone can check.
      if (!method.is_cash && (input.reference ?? '').trim() === '') {
        throw new InvalidPurchase(`Enter the ${method.name.toLowerCase()} reference (transaction number, cheque number or similar) so the payment can be traced.`);
      }

      const cents = toCents(input.amount);
      if (!(cents > 0)) throw new InvalidPurchase('A payment must be more than zero.');

      const paidAt = input.paidAt ?? new Date();
      if (paidAt.getTime() > Date.now() + 5 * 60_000) throw new InvalidPurchase('A payment cannot be dated in the future.');
      if (paidAt.getTime() < Date.now() - 400 * 86_400_000) throw new InvalidPurchase('A payment cannot be dated more than 400 days ago.');

      let poId = input.poId ?? null;
      if (input.grnId !== undefined && input.grnId !== null) {
        const g = await tx.selectFrom('goods_received').select(['id', 'grn_no', 'supplier_id', 'po_id']).where('id', '=', input.grnId).executeTakeFirst();
        if (g === undefined) throw new PurchasingDocumentNotFound('goods received note', input.grnId);
        if (g.supplier_id !== input.supplierId) throw new InvalidPurchase(`${g.grn_no} is from a different supplier.`);
        if (poId !== null && g.po_id !== poId) throw new InvalidPurchase(`${g.grn_no} is not against that purchase order.`);
        poId = poId ?? g.po_id;
      }
      if (poId !== null) {
        const po = await tx.selectFrom('purchase_order').select(['id', 'po_no', 'supplier_id']).where('id', '=', poId).executeTakeFirst();
        if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', poId);
        if (po.supplier_id !== input.supplierId) throw new InvalidPurchase(`${po.po_no} was placed with a different supplier.`);
      }

      // Cash leaves a cash point: say which, so its expected cash is right at the
      // next count. Required whenever the business keeps any cash points at all.
      let cashPoint: { id: string; name: string } | null = null;
      if (method.is_cash) {
        if (input.cashPointId === undefined || input.cashPointId === null) {
          const any = await tx.selectFrom('cash_point').select('id').where('is_active', '=', true).executeTakeFirst();
          if (any !== undefined) throw new InvalidPurchase('Choose the cash point the cash was paid out of (the safe, petty cash or a till).');
        } else {
          const cp = await sql<{ id: string; name: string; isActive: boolean }>`
            SELECT id, name, is_active AS "isActive" FROM cash_point WHERE id = ${input.cashPointId}::uuid FOR UPDATE`.execute(tx);
          const row = cp.rows[0];
          if (row === undefined || !row.isActive) throw new InvalidPurchase('That cash point is not available.');
          const available = await cashOnHand(tx, row.id);
          if (toCents(available) < cents) throw new InsufficientCash(Number(available), fromCents(cents));
          cashPoint = { id: row.id, name: row.name };
        }
      } else if (input.cashPointId !== undefined && input.cashPointId !== null) {
        throw new InvalidPurchase(`A ${method.name.toLowerCase()} payment does not come out of a cash point.`);
      }

      const paymentNo = await groupNumber(tx, 'PAY');
      await tx
        .insertInto('supplier_payment')
        .values({
          id: input.id,
          payment_no: paymentNo,
          supplier_id: input.supplierId,
          amount: fromCents(cents),
          payment_type_id: input.paymentTypeId,
          reference: (input.reference ?? '').trim() === '' ? null : (input.reference ?? '').trim(),
          paid_at: paidAt,
          po_id: poId,
          grn_id: input.grnId ?? null,
          note: input.note ?? null,
          recorded_by: input.recordedBy,
          voided_at: null,
          voided_by: null,
          void_reason: null,
          cash_point_id: cashPoint?.id ?? null,
        })
        .execute();
      if (cashPoint !== null) {
        await postCash(tx, {
          cashPointId: cashPoint.id,
          amount: -fromCents(cents),
          reason: 'supplier_payment',
          actorId: input.recordedBy,
          docType: 'SUPPLIER_PAY',
          docId: input.id,
          occurredAt: paidAt,
        });
      }
      await audit(tx, 'SUPPLIER_PAID', input.recordedBy, null, 'supplier_payment', input.id, {
        paymentNo,
        supplier: supplier.name,
        amount: fromCents(cents),
        method: method.name,
        reference: input.reference ?? null,
        cashPoint: cashPoint?.name ?? null,
      });
      return { id: input.id, paymentNo };
    });
    return { ...r, replayed: false };
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'supplier_payment_pkey') {
      const won = await db.selectFrom('supplier_payment').select(['id', 'payment_no']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, paymentNo: won.payment_no, replayed: true };
    }
    throw error;
  }
}

export async function voidPayment(db: Db, id: string, by: string, reason: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const p = await tx.selectFrom('supplier_payment').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (p === undefined) throw new PurchasingDocumentNotFound('payment', id);
    if (p.voided_at !== null) throw new PaymentAlreadyVoided(p.payment_no);
    await sql`UPDATE supplier_payment SET voided_at = now(), voided_by = ${by}::uuid, void_reason = ${reason} WHERE id = ${id}::uuid`.execute(tx);
    // Cash that was paid out of a cash point goes back into it.
    if (p.cash_point_id !== null) {
      await postCash(tx, {
        cashPointId: p.cash_point_id,
        amount: Number(p.amount),
        reason: 'supplier_payment_void',
        actorId: by,
        docType: 'SUPPLIER_PAY',
        docId: id,
      });
    }
    await audit(tx, 'SUPPLIER_PAYMENT_VOIDED', by, null, 'supplier_payment', id, { paymentNo: p.payment_no, amount: Number(p.amount), reason });
  });
}

// -- proof of payment ----------------------------------------------------------------------------------------------------

export const MAX_PROOF_BYTES = 3 * 1024 * 1024;
export const MAX_PROOFS_PER_PAYMENT = 5;

/** What the file really is, from its first bytes - never from the name or the header the client sent. */
export function sniffProofType(data: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export async function addProof(db: Db, paymentId: string, by: string, fileName: string, data: Buffer): Promise<{ id: string; contentType: string; sizeBytes: number }> {
  if (data.length === 0) throw new ProofRejected('That file is empty.');
  if (data.length > MAX_PROOF_BYTES) throw new ProofRejected(`That file is ${(data.length / 1_048_576).toFixed(1)} MB; the limit is 3 MB. A screenshot or a photo scaled down is plenty.`);
  const type = sniffProofType(data);
  if (type === null) throw new ProofRejected('Only a PNG, JPEG or WebP image, or a PDF, can be attached as proof.');

  const clean = fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'proof';
  return db.transaction().execute(async (tx) => {
    const p = await tx.selectFrom('supplier_payment').select(['id', 'payment_no', 'voided_at']).where('id', '=', paymentId).forUpdate().executeTakeFirst();
    if (p === undefined) throw new PurchasingDocumentNotFound('payment', paymentId);
    if (p.voided_at !== null) throw new PaymentAlreadyVoided(p.payment_no);
    const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM supplier_payment_proof WHERE payment_id = ${paymentId}::uuid`.execute(tx);
    if (Number(n.rows[0]?.n) >= MAX_PROOFS_PER_PAYMENT) throw new ProofRejected(`A payment can carry at most ${MAX_PROOFS_PER_PAYMENT} files.`);

    const row = await tx
      .insertInto('supplier_payment_proof')
      .values({
        payment_id: paymentId,
        file_name: clean,
        content_type: type,
        size_bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        data,
        uploaded_by: by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, 'PAYMENT_PROOF_ATTACHED', by, null, 'supplier_payment', paymentId, { paymentNo: p.payment_no, file: clean, bytes: data.length });
    return { id: row.id, contentType: type, sizeBytes: data.length };
  });
}

// -- a supplier's account ------------------------------------------------------------------------------------------------------

export interface SupplierAccount {
  balance: number;
  receivedCost: number;
  /** Goods sent back to the supplier, at cost: what the supplier owes us credit for. */
  returnedCost: number;
  paid: number;
  ageing: {
    buckets: Record<string, number>;
    total: number;
    credit: number;
    items: { grnId: string; grnNo: string; day: string; dueDay: string; amount: number; outstanding: number; daysOverdue: number }[];
  };
  statement: {
    at: string;
    kind: 'received' | 'payment' | 'void' | 'return';
    ref: string;
    description: string;
    id: string;
    debit: number;
    credit: number;
    balance: number;
    timing?: PaymentTiming;
  }[];
}

/** Terms a delivery falls due on: the order it was against, else the supplier's own. */
export async function supplierAccount(db: Db, supplierId: string, asOf: Date = new Date()): Promise<SupplierAccount> {
  const tz = await businessTimezone(db);
  const supplier = await db.selectFrom('supplier').select(['terms', 'credit_days']).where('id', '=', supplierId).executeTakeFirst();
  if (supplier === undefined) throw new PurchasingDocumentNotFound('supplier', supplierId);

  const grns = await sql<{
    id: string; grnNo: string; receivedAt: Date; total: number; invoiceNo: string | null; branchCode: string;
    poNo: string | null; poTerms: SupplierTerms | null; poCreditDays: number | null;
  }>`
    SELECT g.id, g.grn_no AS "grnNo", g.received_at AS "receivedAt", g.total_cost AS total, g.supplier_invoice_no AS "invoiceNo",
           b.code AS "branchCode", po.po_no AS "poNo", po.terms AS "poTerms", po.credit_days AS "poCreditDays"
    FROM goods_received g JOIN branch b ON b.id = g.branch_id LEFT JOIN purchase_order po ON po.id = g.po_id
    WHERE g.supplier_id = ${supplierId}::uuid ORDER BY g.received_at`.execute(db);

  const pays = await sql<{
    id: string; paymentNo: string; amount: number; paidAt: Date; reference: string | null; method: string;
    poId: string | null; grnId: string | null; voidedAt: Date | null; voidReason: string | null;
  }>`
    SELECT p.id, p.payment_no AS "paymentNo", p.amount, p.paid_at AS "paidAt", p.reference, t.name AS method,
           p.po_id AS "poId", p.grn_id AS "grnId", p.voided_at AS "voidedAt", p.void_reason AS "voidReason"
    FROM supplier_payment p JOIN payment_type t ON t.id = p.payment_type_id
    WHERE p.supplier_id = ${supplierId}::uuid ORDER BY p.paid_at`.execute(db);

  const rets = await sql<{ id: string; prnNo: string; returnedAt: Date; total: number; reason: string; creditNoteNo: string | null; grnNo: string | null }>`
    SELECT r.id, r.prn_no AS "prnNo", r.returned_at AS "returnedAt", r.total_cost AS total, r.reason,
           r.credit_note_no AS "creditNoteNo", g.grn_no AS "grnNo"
    FROM purchase_return r LEFT JOIN goods_received g ON g.id = r.grn_id
    WHERE r.supplier_id = ${supplierId}::uuid ORDER BY r.returned_at`.execute(db);

  // First delivery day per order and the day of each delivery, to say prepaid / on delivery / after.
  const deliveryDayByGrn = new Map(grns.rows.map((g) => [g.id, dayIn(tz, g.receivedAt)]));
  const firstDeliveryByPo = new Map<string, string>();
  const poOfGrn = await sql<{ id: string; poId: string | null }>`SELECT id, po_id AS "poId" FROM goods_received WHERE supplier_id = ${supplierId}::uuid`.execute(db);
  for (const g of poOfGrn.rows) {
    if (g.poId === null) continue;
    const d = deliveryDayByGrn.get(g.id);
    if (d !== undefined && (firstDeliveryByPo.get(g.poId) ?? '9999') > d) firstDeliveryByPo.set(g.poId, d);
  }

  const entries = [
    ...grns.rows.map((g) => ({
      at: iso(g.receivedAt),
      kind: 'received' as const,
      id: g.id,
      ref: g.grnNo,
      description: `Goods received${g.poNo === null ? '' : ` against ${g.poNo}`}${g.invoiceNo === null ? '' : ` · supplier invoice ${g.invoiceNo}`}`,
      debitCents: toCents(Number(g.total)),
      creditCents: 0,
    })),
    ...pays.rows.map((p) => {
      const day = dayIn(tz, p.paidAt);
      const linked = p.poId !== null || p.grnId !== null;
      const deliveryDay = p.grnId !== null ? (deliveryDayByGrn.get(p.grnId) ?? null) : p.poId !== null ? (firstDeliveryByPo.get(p.poId) ?? null) : null;
      return {
        at: iso(p.paidAt),
        kind: 'payment' as const,
        id: p.id,
        ref: p.paymentNo,
        description: `Payment by ${p.method}${p.reference === null ? '' : ` · ${p.reference}`}`,
        debitCents: 0,
        creditCents: toCents(Number(p.amount)),
        timing: paymentTiming(day, linked, deliveryDay),
      };
    }),
    ...rets.rows.map((r) => ({
      at: iso(r.returnedAt),
      kind: 'return' as const,
      id: r.id,
      ref: r.prnNo,
      description: `Goods returned${r.grnNo === null ? '' : ` from ${r.grnNo}`} · ${r.reason}${r.creditNoteNo === null ? '' : ` · credit note ${r.creditNoteNo}`}`,
      debitCents: 0,
      creditCents: toCents(Number(r.total)),
    })),
    // A void puts the money back on the account at the moment it was voided.
    ...pays.rows
      .filter((p) => p.voidedAt !== null)
      .map((p) => ({
        at: iso(p.voidedAt as Date),
        kind: 'void' as const,
        id: p.id,
        ref: p.paymentNo,
        description: `Payment voided${p.voidReason === null ? '' : ` · ${p.voidReason}`}`,
        debitCents: toCents(Number(p.amount)),
        creditCents: 0,
      })),
  ];
  const statement = runStatement(entries).map((e) => ({
    at: e.at,
    kind: e.kind,
    ref: e.ref,
    description: e.description,
    id: e.id,
    debit: fromCents(e.debitCents),
    credit: fromCents(e.creditCents),
    balance: fromCents(e.balanceCents),
    ...('timing' in e ? { timing: e.timing } : {}),
  }));

  const receivedCents = entries.reduce((s, e) => s + (e.kind === 'received' ? e.debitCents : 0), 0);
  const paidCents = entries.reduce((s, e) => s + (e.kind === 'payment' ? e.creditCents : e.kind === 'void' ? -e.debitCents : 0), 0);
  const returnedCents = entries.reduce((s, e) => s + (e.kind === 'return' ? e.creditCents : 0), 0);

  const today = dayIn(tz, asOf);
  const ageing = ageDeliveries(
    grns.rows.map((g) => {
      const day = dayIn(tz, g.receivedAt);
      const terms: SupplierTerms = g.poTerms ?? supplier.terms;
      const days = g.poTerms !== null ? g.poCreditDays : supplier.credit_days;
      return { id: g.id, day, cents: toCents(Number(g.total)), dueDay: dueDate(day, terms, days) };
    }),
    // Credit notes for returned goods settle the oldest deliveries just as payments do.
    paidCents + returnedCents,
    today,
  );
  const grnNo = new Map(grns.rows.map((g) => [g.id, g.grnNo]));

  return {
    balance: fromCents(receivedCents - returnedCents - paidCents),
    receivedCost: fromCents(receivedCents),
    returnedCost: fromCents(returnedCents),
    paid: fromCents(paidCents),
    ageing: {
      buckets: Object.fromEntries(Object.entries(ageing.buckets).map(([k, v]) => [k, fromCents(v)])),
      total: fromCents(ageing.totalCents),
      credit: fromCents(ageing.creditCents),
      items: ageing.items.map((i) => ({
        grnId: i.id,
        grnNo: grnNo.get(i.id) ?? '',
        day: i.day,
        dueDay: i.dueDay,
        amount: fromCents(i.cents),
        outstanding: fromCents(i.outstandingCents),
        daysOverdue: i.daysOverdue,
      })),
    },
    statement,
  };
}
