/**
 * Check out a basket: many items, one receipt.
 *
 * A sale is ONE atomic document. Every line's stock movement, the receipt and
 * its lines, the payments, and the cash landing in the till all commit
 * together or not at all - there is no state in which the till has the money
 * and the ledger has not lost the stock, or the reverse.
 *
 * The rules that live here rather than in the caller:
 *
 *  - Prices come from the list. A price or discount away from it needs
 *    `price.override`, and using it raises a `price_override` exception with
 *    the money involved. A product with no price cannot be sold at all: a sale
 *    for nothing is worse than a refused one.
 *  - Cost of sales is captured on every line AT THE MOMENT OF SALE (weighted
 *    average cost per base unit), and the stock movement carries it too. That
 *    is what makes gross profit a fact instead of an estimate.
 *  - The cashier is the person signed in. Never a name in the request body:
 *    a receipt that anyone can post under someone else's name is not evidence.
 *  - Lines are posted in a fixed (product id) order regardless of the order
 *    they were scanned, so two tills selling overlapping baskets cannot
 *    deadlock each other on the per-product locks.
 *  - The receipt number is taken LAST. It is gapless per branch, which means
 *    a counter row held until the transaction ends; taking it first would
 *    serialise every till in the branch for the whole sale.
 *  - Retrying a sale is safe: the client supplies the sale id, and a second
 *    attempt with the same id returns the first receipt instead of selling
 *    the goods twice.
 */

import {
  fromCents,
  InvalidBasket,
  NegativeStockBlocked,
  packsToBase,
  PriceMissing,
  PriceOverrideRequired,
  priceLine,
  settlePayments,
  TillRequired,
  toCents,
  totalBasket,
  type PricedLine,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { postMovementInTx, wac } from './stock.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface CheckoutLineInput {
  productId: string;
  packId: string;
  qtyPacks: number;
  /** Absent means "the list price". Anything else needs price.override. */
  unitPrice?: number | undefined;
  discount?: number | undefined;
}

export interface CheckoutPaymentInput {
  paymentTypeId: string;
  amount: number;
  tendered?: number | undefined;
  reference?: string | null | undefined;
}

export interface CheckoutInput {
  saleId: string;
  branchId: string;
  cashPointId: string | null;
  terminalId: string | null;
  /** The signed-in person, taken from the session by the route, never from the request body. */
  cashierId: string;
  lines: CheckoutLineInput[];
  payments: CheckoutPaymentInput[];
  /** The caller holds price.override. */
  canOverridePrice: boolean;
  /** The caller asked for a negative-stock override AND holds stock.override. */
  overrideNegative: boolean;
}

export interface ReceiptView {
  id: string;
  receiptNo: string;
  occurredAt: string;
  branch: { id: string; code: string; name: string };
  cashier: { id: string; name: string };
  till: string | null;
  currency: string;
  lines: {
    lineNo: number;
    productId: string;
    sku: string;
    name: string;
    packLabel: string;
    qtyPacks: number;
    unitPrice: number;
    discount: number;
    lineTotal: number;
  }[];
  gross: number;
  discount: number;
  net: number;
  tendered: number;
  change: number;
  payments: { type: string; isCash: boolean; amount: number; tendered: number; reference: string | null }[];
  business: { name: string; address: string; phone: string; tin: string; footer: string; widthMm: number };
}

export interface CheckoutResult {
  receipt: ReceiptView;
  /** True when this sale id had already been completed: nothing was posted this time. */
  replayed: boolean;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === constraint;
}

export async function checkout(db: Db, input: CheckoutInput): Promise<CheckoutResult> {
  const already = await db.selectFrom('sale').select('id').where('id', '=', input.saleId).executeTakeFirst();
  if (already !== undefined) return { receipt: await getReceipt(db, input.saleId), replayed: true };

  try {
    await db.transaction().execute((tx) => runCheckout(tx, input));
  } catch (error) {
    // Two identical requests racing: the loser hits the primary key, and what
    // it should return is the winner's receipt.
    if (isUniqueViolation(error, 'sale_pkey')) {
      return { receipt: await getReceipt(db, input.saleId), replayed: true };
    }
    throw error;
  }
  return { receipt: await getReceipt(db, input.saleId), replayed: false };
}

async function runCheckout(tx: Tx, input: CheckoutInput): Promise<void> {
  if (input.lines.length === 0) throw new InvalidBasket('A sale needs at least one item.');

  const branch = await tx
    .selectFrom('branch')
    .select(['id', 'code', 'is_active'])
    .where('id', '=', input.branchId)
    .executeTakeFirst();
  if (branch === undefined || !branch.is_active) throw new InvalidBasket('That branch is not available for sales.');

  // -- what is being sold ------------------------------------------------------------
  const packIds = [...new Set(input.lines.map((l) => l.packId))];
  const packs = await tx
    .selectFrom('product_pack')
    .innerJoin('product', 'product.id', 'product_pack.product_id')
    .select([
      'product_pack.id as packId',
      'product_pack.product_id as productId',
      'product_pack.qty_base as qtyBase',
      'product_pack.sell_price as sellPrice',
      'product_pack.label as packLabel',
      'product.name as name',
      'product.sku as sku',
      'product.review_state as reviewState',
    ])
    .where('product_pack.id', 'in', packIds)
    .execute();
  const packById = new Map(packs.map((p) => [p.packId, p]));

  // -- price every line ------------------------------------------------------------------
  interface Working {
    index: number;
    line: CheckoutLineInput;
    pack: (typeof packs)[number];
    listPrice: number | null;
    unitPrice: number;
    priced: PricedLine;
    overridden: boolean;
    qtyBase: number;
  }
  const working: Working[] = input.lines.map((line, index) => {
    const pack = packById.get(line.packId);
    if (pack === undefined || pack.productId !== line.productId) {
      throw new InvalidBasket('An item in this sale is not a known product and pack.');
    }
    const listPrice = pack.sellPrice === null ? null : Number(pack.sellPrice);
    const asked = line.unitPrice;
    const discount = line.discount ?? 0;

    let unitPrice: number;
    let overridden = false;
    if (listPrice === null) {
      // Nothing to charge from. Only someone allowed to set a price at the till may name one.
      if (asked === undefined || !input.canOverridePrice) throw new PriceMissing(pack.name, pack.productId);
      unitPrice = asked;
      overridden = true;
    } else {
      unitPrice = asked ?? listPrice;
      overridden = toCents(unitPrice) !== toCents(listPrice) || discount > 0;
      if (overridden && !input.canOverridePrice) throw new PriceOverrideRequired(pack.name, pack.productId);
    }

    return {
      index,
      line,
      pack,
      listPrice,
      unitPrice,
      priced: priceLine({ qtyPacks: line.qtyPacks, unitPrice, discount }),
      overridden,
      qtyBase: packsToBase(line.qtyPacks, Number(pack.qtyBase)),
    };
  });

  const totals = totalBasket(working.map((w) => w.priced));

  // -- how it is paid ------------------------------------------------------------------------
  const typeIds = [...new Set(input.payments.map((p) => p.paymentTypeId))];
  const types = await tx
    .selectFrom('payment_type')
    .select(['id', 'name', 'is_cash', 'at_till', 'is_active'])
    .where('id', 'in', typeIds.length === 0 ? ['-'] : typeIds)
    .execute();
  const typeById = new Map(types.map((t) => [t.id, t]));
  for (const p of input.payments) {
    const t = typeById.get(p.paymentTypeId);
    if (t === undefined || !t.is_active || !t.at_till) {
      throw new InvalidBasket('That payment method is not available at the till.');
    }
  }
  const settlement = settlePayments(
    totals.netCents,
    input.payments.map((p) => ({
      isCash: typeById.get(p.paymentTypeId)?.is_cash === true,
      amount: p.amount,
      ...(p.tendered === undefined ? {} : { tendered: p.tendered }),
    })),
  );
  const cashCents = input.payments.reduce(
    (sum, p) => sum + (typeById.get(p.paymentTypeId)?.is_cash === true ? toCents(p.amount) : 0),
    0,
  );

  // -- which till gets the cash --------------------------------------------------------------------
  let cashPointId: string | null = null;
  if (input.cashPointId !== null) {
    const till = await tx
      .selectFrom('cash_point')
      .select(['id', 'branch_id', 'kind', 'is_active'])
      .where('id', '=', input.cashPointId)
      .executeTakeFirst();
    if (till === undefined || till.kind !== 'till' || till.branch_id !== input.branchId || !till.is_active) {
      throw new InvalidBasket('That till does not belong to this branch.');
    }
    cashPointId = till.id;
  } else if (cashCents > 0) {
    const tills = await tx
      .selectFrom('cash_point')
      .select('id')
      .where('branch_id', '=', input.branchId)
      .where('kind', '=', 'till')
      .where('is_active', '=', true)
      .execute();
    // A branch with tills must say which one took the money, or its cash-up can
    // never reconcile. A branch with none simply has no till to credit yet.
    if (tills.length > 0) throw new TillRequired();
  }

  // -- take the stock out, in a fixed order -------------------------------------------------------------
  const occurredAt = new Date();
  const movementSeqByIndex = new Map<number, number>();
  const costByIndex = new Map<number, number | null>();
  const negativeOverrides: { w: Working; available: unknown; requested: unknown; seq: number }[] = [];

  for (const w of [...working].sort((a, b) => a.pack.productId.localeCompare(b.pack.productId))) {
    const unitCost = await wac(tx, w.pack.productId, input.branchId);
    costByIndex.set(w.index, unitCost);

    const base = {
      productId: w.pack.productId,
      branchId: input.branchId,
      qtyBase: -w.qtyBase,
      reason: 'sale' as const,
      actorId: input.cashierId,
      unitCost,
      docType: 'SALE',
      docId: input.saleId,
      terminalId: input.terminalId,
      occurredAt,
    };

    // A product added at the till moments ago has no stock baseline anyone can
    // trust, so its first sales are not held to the negative-stock guard; the
    // "added at the till" exception it already raised is the control.
    const pending = w.pack.reviewState === 'pending';
    try {
      const posted = await postMovementInTx(tx, { ...base, allowNegative: pending });
      movementSeqByIndex.set(w.index, posted.seq);
    } catch (error) {
      if (!(error instanceof NegativeStockBlocked)) throw error;
      if (!input.overrideNegative) {
        // Say WHICH item, so a till can show it against the right line.
        Object.assign(error.detail, { productId: w.pack.productId, productName: w.pack.name, sku: w.pack.sku });
        throw error;
      }
      const posted = await postMovementInTx(tx, { ...base, allowNegative: true });
      movementSeqByIndex.set(w.index, posted.seq);
      negativeOverrides.push({ w, available: error.detail['available'], requested: error.detail['requested'], seq: posted.seq });
    }
  }

  // -- the receipt number: last, and gapless -------------------------------------------------------------------
  const counter = await sql<{ lastNo: number }>`
    INSERT INTO document_counter (branch_id, doc_kind, last_no)
    VALUES (${input.branchId}::uuid, 'SALE', 1)
    ON CONFLICT (branch_id, doc_kind) DO UPDATE SET last_no = document_counter.last_no + 1
    RETURNING last_no AS "lastNo"
  `.execute(tx);
  const receiptNo = `${branch.code}-${String(Number(counter.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;

  // -- write the document -------------------------------------------------------------------------------------------
  await tx
    .insertInto('sale')
    .values({
      id: input.saleId,
      receipt_no: receiptNo,
      branch_id: input.branchId,
      terminal_id: input.terminalId,
      cash_point_id: cashPointId,
      cashier_id: input.cashierId,
      occurred_at: occurredAt,
      gross_total: fromCents(totals.grossCents),
      discount_total: fromCents(totals.discountCents),
      net_total: fromCents(totals.netCents),
      tendered_total: fromCents(settlement.tenderedCents),
      change_given: fromCents(settlement.changeCents),
    })
    .execute();

  await tx
    .insertInto('sale_line')
    .values(
      working.map((w) => ({
        sale_id: input.saleId,
        line_no: w.index + 1,
        product_id: w.pack.productId,
        pack_id: w.pack.packId,
        qty_packs: w.line.qtyPacks,
        qty_base: w.qtyBase,
        list_price: w.listPrice,
        unit_price: w.unitPrice,
        discount: fromCents(w.priced.discountCents),
        line_total: fromCents(w.priced.totalCents),
        unit_cost: costByIndex.get(w.index) ?? null,
        movement_seq: movementSeqByIndex.get(w.index) as number,
      })),
    )
    .execute();

  await tx
    .insertInto('sale_payment')
    .values(
      input.payments.map((p) => ({
        sale_id: input.saleId,
        payment_type_id: p.paymentTypeId,
        amount: p.amount,
        tendered: p.tendered ?? p.amount,
        reference: p.reference ?? null,
      })),
    )
    .execute();

  // The till's cash position: what the drawer actually gained, i.e. cash applied
  // to the bill, not the note handed over (the change went back out).
  if (cashCents > 0 && cashPointId !== null) {
    await tx
      .insertInto('cash_movement')
      .values({
        event_id: crypto.randomUUID(),
        cash_point_id: cashPointId,
        amount: fromCents(cashCents),
        reason: 'sales_receipts',
        doc_type: 'SALE',
        doc_id: input.saleId,
        counterpart_seq: null,
        actor_id: input.cashierId,
        terminal_id: input.terminalId,
        occurred_at: occurredAt,
      })
      .execute();
  }

  // -- the controls that fired --------------------------------------------------------------------------------------------
  for (const w of working.filter((x) => x.overridden)) {
    const listTotalCents = w.listPrice === null ? null : Math.round(toCents(w.listPrice) * w.line.qtyPacks);
    await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'price_override',
        branch_id: input.branchId,
        terminal_id: input.terminalId,
        actor_id: input.cashierId,
        product_id: w.pack.productId,
        detail: JSON.stringify({
          receiptNo,
          saleId: input.saleId,
          listPrice: w.listPrice,
          chargedUnitPrice: w.unitPrice,
          discount: fromCents(w.priced.discountCents),
          qtyPacks: w.line.qtyPacks,
        }),
        // Negative: revenue given away against the list. Unknown when there was no list price.
        value_impact: listTotalCents === null ? null : fromCents(w.priced.totalCents - listTotalCents),
        currency: listTotalCents === null ? null : 'USD',
        occurred_at: occurredAt,
      })
      .execute();
  }

  for (const o of negativeOverrides) {
    await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'negative_stock_override',
        branch_id: input.branchId,
        terminal_id: input.terminalId,
        actor_id: input.cashierId,
        product_id: o.w.pack.productId,
        detail: JSON.stringify({
          movementSeq: o.seq,
          receiptNo,
          saleId: input.saleId,
          authorisedBy: input.cashierId,
          available: o.available ?? null,
          requested: o.requested ?? null,
        }),
        value_impact: null,
        currency: null,
        occurred_at: occurredAt,
      })
      .execute();
  }
}

// -- reading a receipt back ----------------------------------------------------------------------------------------------------

const BUSINESS_KEYS = ['business_name', 'business_address', 'business_phone', 'business_tin', 'receipt_footer', 'receipt_width_mm'];

export async function getReceipt(db: Db | Tx, saleId: string): Promise<ReceiptView> {
  const sale = await db
    .selectFrom('sale')
    .innerJoin('branch', 'branch.id', 'sale.branch_id')
    .innerJoin('person', 'person.id', 'sale.cashier_id')
    .leftJoin('cash_point', 'cash_point.id', 'sale.cash_point_id')
    .select([
      'sale.id',
      'sale.receipt_no as receiptNo',
      'sale.occurred_at as occurredAt',
      'sale.currency',
      'sale.gross_total as gross',
      'sale.discount_total as discount',
      'sale.net_total as net',
      'sale.tendered_total as tendered',
      'sale.change_given as change',
      'branch.id as branchId',
      'branch.code as branchCode',
      'branch.name as branchName',
      'person.id as cashierId',
      'person.full_name as cashierName',
      'cash_point.name as tillName',
    ])
    .where('sale.id', '=', saleId)
    .executeTakeFirstOrThrow();

  const [lines, payments, settings] = await Promise.all([
    db
      .selectFrom('sale_line')
      .innerJoin('product', 'product.id', 'sale_line.product_id')
      .innerJoin('product_pack', 'product_pack.id', 'sale_line.pack_id')
      .select([
        'sale_line.line_no as lineNo',
        'product.id as productId',
        'product.sku as sku',
        'product.name as name',
        'product_pack.label as packLabel',
        'sale_line.qty_packs as qtyPacks',
        'sale_line.unit_price as unitPrice',
        'sale_line.discount',
        'sale_line.line_total as lineTotal',
      ])
      .where('sale_line.sale_id', '=', saleId)
      .orderBy('sale_line.line_no', 'asc')
      .execute(),
    db
      .selectFrom('sale_payment')
      .innerJoin('payment_type', 'payment_type.id', 'sale_payment.payment_type_id')
      .select([
        'payment_type.name as type',
        'payment_type.is_cash as isCash',
        'sale_payment.amount',
        'sale_payment.tendered',
        'sale_payment.reference',
      ])
      .where('sale_payment.sale_id', '=', saleId)
      .execute(),
    db.selectFrom('system_setting').select(['key', 'value']).where('key', 'in', BUSINESS_KEYS).execute(),
  ]);

  const s = new Map(settings.map((r) => [r.key, r.value]));
  const width = Number(s.get('receipt_width_mm'));

  return {
    id: sale.id,
    receiptNo: sale.receiptNo,
    occurredAt: new Date(sale.occurredAt).toISOString(),
    branch: { id: sale.branchId, code: sale.branchCode, name: sale.branchName },
    cashier: { id: sale.cashierId, name: sale.cashierName },
    till: sale.tillName,
    currency: sale.currency,
    lines: lines.map((l) => ({
      ...l,
      qtyPacks: Number(l.qtyPacks),
      unitPrice: Number(l.unitPrice),
      discount: Number(l.discount),
      lineTotal: Number(l.lineTotal),
    })),
    gross: Number(sale.gross),
    discount: Number(sale.discount),
    net: Number(sale.net),
    tendered: Number(sale.tendered),
    change: Number(sale.change),
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount), tendered: Number(p.tendered) })),
    business: {
      name: s.get('business_name') ?? '',
      address: s.get('business_address') ?? '',
      phone: s.get('business_phone') ?? '',
      tin: s.get('business_tin') ?? '',
      footer: s.get('receipt_footer') ?? '',
      widthMm: width === 58 ? 58 : 80,
    },
  };
}
