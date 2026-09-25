/**
 * Suppliers, purchase orders, goods received notes and supplier payments.
 *
 * Branch scope: a manager tied to particular branches sees only those branches
 * orders and deliveries. What the group owes a supplier, and what has been paid
 * to it, is group-wide finance, so it is withheld from them altogether rather
 * than shown in part.
 */

import { isMoney, OutsideBranchScope, paymentTiming, PurchasingDocumentNotFound } from '@retail-ops/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import {
  addProof,
  businessTimezone,
  cancelPurchaseOrder,
  closePurchaseOrder,
  dayIn,
  MAX_PROOF_BYTES,
  poStatus,
  receiveGoods,
  recordPayment,
  supplierAccount,
  voidPayment,
  type PoPayment,
} from '../services/purchasing.js';
import { parseBody, parseParams, parseQuery, queryBool } from '../validation.js';

// -- shapes -------------------------------------------------------------------------------------------

const money = z.number().min(0).max(100_000_000).refine(isMoney, 'An amount has at most two decimal places.');
const unitCost = z
  .number()
  .min(0)
  .max(10_000_000)
  .refine((n) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, 'A cost has at most four decimal places.');
const qtyPacks = z.number().positive().max(1_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-25.');
const terms = z.enum(['prepaid', 'cash_on_delivery', 'credit']);
const idParams = z.object({ id: z.uuid() });
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z.union([z.literal('').transform(() => null), text(max)]).nullable().optional();

const supplierBody = z.object({
  name: text(120).min(2, 'Give the supplier a name.'),
  contactPerson: optText(120),
  phone: optText(40),
  email: optText(120),
  address: optText(300),
  tin: optText(40),
  terms: terms.default('credit'),
  creditDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: optText(500),
});
const supplierPatch = supplierBody.partial().extend({ isActive: z.boolean().optional() });

const orderBody = z.object({
  supplierId: z.uuid(),
  branchId: z.uuid(),
  expectedDate: day.nullable().optional(),
  terms: terms.optional(),
  creditDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: optText(500),
  lines: z
    .array(z.object({ productId: z.uuid(), packId: z.uuid(), qtyPacks, unitCost }))
    .min(1, 'Add at least one item.')
    .max(300),
});

const grnBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  supplierId: z.uuid(),
  poId: z.uuid().nullable().optional(),
  supplierInvoiceNo: optText(60),
  invoiceDate: day.nullable().optional(),
  invoiceTotal: money.nullable().optional(),
  notes: optText(500),
  lines: z
    .array(z.object({ productId: z.uuid(), packId: z.uuid(), qtyPacks, unitCost, poLineId: z.uuid().nullable().optional() }))
    .min(1, 'Add at least one item.')
    .max(300),
});

const paymentBody = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  amount: money.refine((n) => n > 0, 'A payment must be more than zero.'),
  paymentTypeId: z.string().trim().min(1).max(32),
  reference: optText(100),
  paidAt: z.coerce.date().optional(),
  poId: z.uuid().nullable().optional(),
  grnId: z.uuid().nullable().optional(),
  note: optText(500),
});

const reasonBody = z.object({ reason: text(300).min(5, 'Say why, in a few words.') });

const listQuery = z.object({
  q: text(60).min(1).optional(),
  includeInactive: queryBool,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const docQuery = z.object({
  supplierId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  status: z.enum(['ordered', 'part_received', 'received', 'closed', 'cancelled', 'open']).optional(),
  q: text(60).min(1).optional(),
  from: day.optional(),
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const paymentQuery = z.object({
  supplierId: z.uuid().optional(),
  paymentTypeId: z.string().trim().min(1).max(32).optional(),
  from: day.optional(),
  to: day.optional(),
  includeVoided: queryBool,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const n = (v: unknown): number => Number(v ?? 0);
const round2 = (v: unknown): number => Math.round(n(v) * 100) / 100;

function requireGroupWide(request: FastifyRequest): void {
  if (scopedBranchIds(request) !== null) {
    throw new OutsideBranchScope('supplier finance');
  }
}

export async function registerSupplierRoutes(app: FastifyInstance): Promise<void> {
  // Proof of payment arrives as the raw bytes of the file, not JSON or multipart.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_PROOF_BYTES + 1024 },
    (_request, body, done) => done(null, body),
  );

  async function audit(actorId: string, action: string, entityId: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null) {
    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: action,
        actor_id: actorId,
        terminal_id: null,
        branch_id: null,
        entity_type: 'supplier',
        entity_id: entityId,
        state_before: before === null ? null : JSON.stringify(before),
        state_after: JSON.stringify(after),
        occurred_at: new Date(),
      })
      .execute();
  }

  // ======================================================================================================
  // suppliers
  // ======================================================================================================

  app.get('/suppliers', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const q = parseQuery(listQuery, request.query);
    const scoped = scopedBranchIds(request) !== null;
    const like = q.q === undefined ? null : `%${q.q}%`;

    const rows = await sql<Record<string, unknown>>`
      SELECT s.id, s.code, s.name, s.contact_person AS "contactPerson", s.phone, s.email, s.terms, s.credit_days AS "creditDays",
             s.is_active AS "isActive",
             b.received_cost AS "receivedCost", b.paid, b.balance,
             (SELECT max(g.received_at) FROM goods_received g WHERE g.supplier_id = s.id) AS "lastDelivery",
             (SELECT count(*)::int FROM purchase_order po WHERE po.supplier_id = s.id AND po.cancelled_at IS NULL AND po.closed_at IS NULL
                AND EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.po_id = po.id AND l.qty_packs >
                    coalesce((SELECT sum(gl.qty_packs) FROM goods_received_line gl WHERE gl.po_line_id = l.id), 0))) AS "openOrders"
      FROM supplier s JOIN supplier_balance b ON b.supplier_id = s.id
      WHERE (${q.includeInactive} OR s.is_active)
        AND (${like}::text IS NULL OR s.name ILIKE ${like} OR s.code ILIKE ${like} OR s.contact_person ILIKE ${like})
      ORDER BY s.name LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);

    return {
      items: rows.rows.map((r) => ({
        ...r,
        receivedCost: scoped ? null : round2(r['receivedCost']),
        paid: scoped ? null : round2(r['paid']),
        balance: scoped ? null : round2(r['balance']),
      })),
      financeHidden: scoped,
    };
  });

  app.post('/suppliers', { onRequest: [app.requirePermission('supplier.write')] }, async (request, reply) => {
    const b = parseBody(supplierBody, request.body);
    const actor = request.user!;
    const dup = await app.db.selectFrom('supplier').select('id').where(sql<boolean>`lower(name) = lower(${b.name})`).executeTakeFirst();
    if (dup !== undefined) {
      return reply.status(409).send({ error: { code: 'SUPPLIER_EXISTS', message: `There is already a supplier called ${b.name}.` } });
    }
    const row = await app.db
      .insertInto('supplier')
      .values({
        name: b.name,
        contact_person: b.contactPerson ?? null,
        phone: b.phone ?? null,
        email: b.email ?? null,
        address: b.address ?? null,
        tin: b.tin ?? null,
        terms: b.terms,
        credit_days: b.terms === 'credit' ? (b.creditDays ?? 0) : null,
        notes: b.notes ?? null,
        created_by: actor.personId,
      })
      .returning(['id', 'code', 'name'])
      .executeTakeFirstOrThrow();
    await audit(actor.personId, 'SUPPLIER_ADDED', row.id, { code: row.code, name: row.name, terms: b.terms });
    return reply.status(201).send(row);
  });

  app.patch('/suppliers/:id', { onRequest: [app.requirePermission('supplier.write')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const b = parseBody(supplierPatch, request.body);
    const actor = request.user!;
    const before = await app.db.selectFrom('supplier').selectAll().where('id', '=', id).executeTakeFirst();
    if (before === undefined) throw new PurchasingDocumentNotFound('supplier', id);

    if (b.name !== undefined && b.name.toLowerCase() !== before.name.toLowerCase()) {
      const dup = await app.db.selectFrom('supplier').select('id').where(sql<boolean>`lower(name) = lower(${b.name})`).where('id', '!=', id).executeTakeFirst();
      if (dup !== undefined) return reply.status(409).send({ error: { code: 'SUPPLIER_EXISTS', message: `There is already a supplier called ${b.name}.` } });
    }
    const nextTerms = b.terms ?? before.terms;
    const nextDays = nextTerms === 'credit' ? (b.creditDays !== undefined ? b.creditDays : before.credit_days) : null;

    const changes = {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.contactPerson !== undefined ? { contact_person: b.contactPerson } : {}),
      ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.address !== undefined ? { address: b.address } : {}),
      ...(b.tin !== undefined ? { tin: b.tin } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
      terms: nextTerms,
      credit_days: nextDays,
      updated_at: new Date(),
    };
    await app.db.updateTable('supplier').set(changes).where('id', '=', id).execute();
    await audit(actor.personId, b.isActive === false ? 'SUPPLIER_DEACTIVATED' : 'SUPPLIER_CHANGED', id, { ...changes, updated_at: undefined },
      { name: before.name, terms: before.terms, credit_days: before.credit_days, is_active: before.is_active });
    return { ok: true };
  });

  app.get('/suppliers/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const s = await app.db.selectFrom('supplier').selectAll().where('id', '=', id).executeTakeFirst();
    if (s === undefined) throw new PurchasingDocumentNotFound('supplier', id);
    const scoped = scopedBranchIds(request) !== null;

    return {
      supplier: {
        id: s.id, code: s.code, name: s.name, contactPerson: s.contact_person, phone: s.phone, email: s.email, address: s.address,
        tin: s.tin, terms: s.terms, creditDays: s.credit_days, notes: s.notes, isActive: s.is_active,
      },
      financeHidden: scoped,
      account: scoped ? null : await supplierAccount(app.db, id),
    };
  });

  /** Everything owed across all suppliers, and how overdue: the aged creditors report. */
  app.get('/payables', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    requireGroupWide(request);
    const suppliers = await app.db
      .selectFrom('supplier')
      .innerJoin('supplier_balance', 'supplier_balance.supplier_id', 'supplier.id')
      .select(['supplier.id', 'supplier.code', 'supplier.name', 'supplier.terms', 'supplier_balance.balance'])
      .where((eb) => eb.or([eb('supplier_balance.balance', '!=', 0), eb('supplier_balance.received_cost', '>', 0)]))
      .orderBy('supplier.name')
      .execute();

    const rows = [];
    const totals = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0, credit: 0 };
    for (const s of suppliers) {
      if (n(s.balance) === 0) continue;
      const a = await supplierAccount(app.db, s.id);
      const b = a.ageing.buckets as Record<string, number>;
      for (const k of ['notDue', 'd1_30', 'd31_60', 'd61_90', 'over90'] as const) totals[k] += b[k] ?? 0;
      totals.total += a.ageing.total;
      totals.credit += a.ageing.credit;
      rows.push({
        supplierId: s.id, code: s.code, name: s.name, terms: s.terms,
        balance: a.balance, owed: a.ageing.total, credit: a.ageing.credit, buckets: b,
        overdue: round2((b['d1_30'] ?? 0) + (b['d31_60'] ?? 0) + (b['d61_90'] ?? 0) + (b['over90'] ?? 0)),
        oldestOverdueDays: a.ageing.items.reduce((m, i) => Math.max(m, i.daysOverdue), 0),
      });
    }
    const r = (x: number) => Math.round(x * 100) / 100;
    return {
      asOf: dayIn(await businessTimezone(app.db), new Date()),
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, r(v)])),
      suppliers: rows.sort((a, b) => b.owed - a.owed),
    };
  });

  // ======================================================================================================
  // purchase orders
  // ======================================================================================================

  const poSelect = sql`
    SELECT po.id, po.po_no AS "poNo", po.ordered_at AS "orderedAt", po.expected_date::text AS "expectedDate", po.terms, po.credit_days AS "creditDays",
           po.cancelled_at AS "cancelledAt", po.closed_at AS "closedAt",
           s.id AS "supplierId", s.name AS "supplierName", s.code AS "supplierCode",
           b.id AS "branchId", b.name AS "branchName", b.code AS "branchCode", pe.full_name AS "orderedByName",
           coalesce((SELECT sum(l.line_total) FROM purchase_order_line l WHERE l.po_id = po.id), 0) AS ordered,
           coalesce((SELECT sum(g.total_cost) FROM goods_received g WHERE g.po_id = po.id), 0) AS received,
           coalesce((SELECT sum(p.amount) FROM supplier_payment p WHERE p.voided_at IS NULL AND
                (p.po_id = po.id)), 0) AS paid,
           (SELECT count(*)::int FROM purchase_order_line l WHERE l.po_id = po.id) AS "lineCount",
           (SELECT count(*)::int FROM purchase_order_line l WHERE l.po_id = po.id AND
               coalesce((SELECT sum(gl.qty_packs) FROM goods_received_line gl WHERE gl.po_line_id = l.id), 0) >= l.qty_packs) AS "linesComplete",
           (SELECT count(*)::int FROM goods_received_line gl JOIN purchase_order_line l ON l.id = gl.po_line_id WHERE l.po_id = po.id) AS "linesTouched"
    FROM purchase_order po
    JOIN supplier s ON s.id = po.supplier_id
    JOIN branch b ON b.id = po.branch_id
    JOIN person pe ON pe.id = po.ordered_by`;

  const paymentStatus = (paid: number, ordered: number, received: number): PoPayment =>
    paid <= 0 ? 'unpaid' : paid + 0.005 >= (received > 0 ? received : ordered) ? 'paid' : 'part_paid';

  function shapeOrder(r: Record<string, unknown>, hideMoney: boolean) {
    const status = poStatus(
      { cancelled_at: r['cancelledAt'] ?? null, closed_at: r['closedAt'] ?? null },
      // Only the counts matter for a list row: complete lines versus all lines.
      n(r['linesTouched']) === 0
        ? [{ ordered: 1, received: 0 }]
        : n(r['linesComplete']) >= n(r['lineCount'])
          ? [{ ordered: 1, received: 1 }]
          : [{ ordered: 2, received: 1 }],
    );
    return {
      id: r['id'], poNo: r['poNo'], status, orderedAt: r['orderedAt'], expectedDate: r['expectedDate'] ?? null,
      terms: r['terms'], creditDays: r['creditDays'] ?? null,
      supplier: { id: r['supplierId'], name: r['supplierName'], code: r['supplierCode'] },
      branch: { id: r['branchId'], name: r['branchName'], code: r['branchCode'] },
      orderedByName: r['orderedByName'], lineCount: n(r['lineCount']),
      ordered: round2(r['ordered']),
      received: round2(r['received']),
      paid: hideMoney ? null : round2(r['paid']),
      paymentStatus: hideMoney ? null : paymentStatus(n(r['paid']), n(r['ordered']), n(r['received'])),
    };
  }

  app.get('/purchase-orders', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const q = parseQuery(docQuery, request.query);
    const limitTo = scopedBranchIds(request);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const tz = await businessTimezone(app.db);

    const where = [
      limitTo === null ? sql`` : sql`AND po.branch_id IN (${sql.join(limitTo)})`,
      q.branchId === undefined ? sql`` : sql`AND po.branch_id = ${q.branchId}`,
      q.supplierId === undefined ? sql`` : sql`AND po.supplier_id = ${q.supplierId}`,
      q.q === undefined ? sql`` : sql`AND po.po_no ILIKE ${'%' + q.q + '%'}`,
      q.from === undefined ? sql`` : sql`AND po.ordered_at >= ((${q.from}::date)::timestamp AT TIME ZONE ${tz})`,
      q.to === undefined ? sql`` : sql`AND po.ordered_at < (((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz})`,
    ];
    const rows = await sql<Record<string, unknown>>`${poSelect} WHERE true ${sql.join(where, sql` `)} ORDER BY po.ordered_at DESC LIMIT 1000`.execute(app.db);
    const hide = limitTo !== null;
    let items = rows.rows.map((r) => shapeOrder(r, hide));
    if (q.status !== undefined) {
      items = items.filter((o) => (q.status === 'open' ? o.status === 'ordered' || o.status === 'part_received' : o.status === q.status));
    }
    return { items: items.slice(q.offset, q.offset + q.limit), total: items.length, limit: q.limit, offset: q.offset, financeHidden: hide };
  });

  app.post('/purchase-orders', { onRequest: [app.requirePermission('po.write')] }, async (request, reply) => {
    const b = parseBody(orderBody, request.body);
    assertInScope(request, b.branchId);
    const { createPurchaseOrder } = await import('../services/purchasing.js');
    const r = await createPurchaseOrder(app.db, {
      supplierId: b.supplierId,
      branchId: b.branchId,
      orderedBy: request.user!.personId,
      expectedDate: b.expectedDate ?? null,
      terms: b.terms,
      creditDays: b.creditDays,
      notes: b.notes ?? null,
      lines: b.lines,
    });
    return reply.status(201).send(r);
  });

  app.get('/purchase-orders/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const head = await sql<Record<string, unknown>>`${poSelect} WHERE po.id = ${id}::uuid`.execute(app.db);
    const h = head.rows[0];
    if (h === undefined) throw new PurchasingDocumentNotFound('purchase order', id);
    assertInScope(request, String(h['branchId']));
    const hide = scopedBranchIds(request) !== null;
    const tz = await businessTimezone(app.db);

    const full = await app.db.selectFrom('purchase_order').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const lines = await sql<Record<string, unknown>>`
      SELECT l.id, l.line_no AS "lineNo", l.product_id AS "productId", p.sku, p.name, l.pack_id AS "packId", pk.label AS "packLabel",
             l.qty_packs AS "qtyPacks", l.qty_base AS "qtyBase", l.unit_cost AS "unitCost", l.line_total AS "lineTotal",
             coalesce((SELECT sum(gl.qty_packs) FROM goods_received_line gl WHERE gl.po_line_id = l.id), 0) AS "receivedPacks"
      FROM purchase_order_line l JOIN product p ON p.id = l.product_id JOIN product_pack pk ON pk.id = l.pack_id
      WHERE l.po_id = ${id}::uuid ORDER BY l.line_no`.execute(app.db);
    const shapedLines = lines.rows.map((l) => ({
      ...l, qtyPacks: n(l['qtyPacks']), qtyBase: n(l['qtyBase']), unitCost: n(l['unitCost']), lineTotal: round2(l['lineTotal']),
      receivedPacks: n(l['receivedPacks']), outstandingPacks: Math.max(0, n(l['qtyPacks']) - n(l['receivedPacks'])),
    }));

    const status = poStatus(
      { cancelled_at: full.cancelled_at, closed_at: full.closed_at },
      shapedLines.map((l) => ({ ordered: l.qtyPacks, received: l.receivedPacks })),
    );

    const receipts = await sql<Record<string, unknown>>`
      SELECT g.id, g.grn_no AS "grnNo", g.received_at AS "receivedAt", g.total_cost AS "totalCost", g.supplier_invoice_no AS "invoiceNo", pe.full_name AS "receivedByName"
      FROM goods_received g JOIN person pe ON pe.id = g.received_by WHERE g.po_id = ${id}::uuid ORDER BY g.received_at`.execute(app.db);

    let payments: Record<string, unknown>[] = [];
    if (!hide) {
      const firstDelivery = receipts.rows[0]?.['receivedAt'] as Date | undefined;
      const pr = await sql<Record<string, unknown>>`
        SELECT p.id, p.payment_no AS "paymentNo", p.amount, p.paid_at AS "paidAt", p.reference, t.name AS method, p.voided_at AS "voidedAt",
               (SELECT count(*)::int FROM supplier_payment_proof x WHERE x.payment_id = p.id) AS proofs
        FROM supplier_payment p JOIN payment_type t ON t.id = p.payment_type_id
        WHERE p.po_id = ${id}::uuid ORDER BY p.paid_at`.execute(app.db);
      payments = pr.rows.map((p) => ({
        ...p, amount: round2(p['amount']),
        timing: paymentTiming(dayIn(tz, p['paidAt'] as Date), true, firstDelivery === undefined ? null : dayIn(tz, firstDelivery)),
      }));
    }

    const shaped = shapeOrder(h, hide);
    return {
      ...shaped,
      status,
      notes: full.notes,
      cancelled: full.cancelled_at === null ? null : { at: full.cancelled_at, reason: full.cancel_reason },
      closed: full.closed_at === null ? null : { at: full.closed_at, note: full.close_note },
      lines: shapedLines,
      receipts: receipts.rows.map((g) => ({ ...g, totalCost: round2(g['totalCost']) })),
      payments,
      financeHidden: hide,
    };
  });

  app.post('/purchase-orders/:id/cancel', { onRequest: [app.requirePermission('po.write')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const { reason } = parseBody(reasonBody, request.body);
    const po = await app.db.selectFrom('purchase_order').select('branch_id').where('id', '=', id).executeTakeFirst();
    if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', id);
    assertInScope(request, po.branch_id);
    await cancelPurchaseOrder(app.db, id, request.user!.personId, reason);
    return { ok: true };
  });

  app.post('/purchase-orders/:id/close', { onRequest: [app.requirePermission('po.write')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const { reason } = parseBody(reasonBody, request.body);
    const po = await app.db.selectFrom('purchase_order').select('branch_id').where('id', '=', id).executeTakeFirst();
    if (po === undefined) throw new PurchasingDocumentNotFound('purchase order', id);
    assertInScope(request, po.branch_id);
    await closePurchaseOrder(app.db, id, request.user!.personId, reason);
    return { ok: true };
  });

  // ======================================================================================================
  // goods received
  // ======================================================================================================

  app.post('/goods-received', { onRequest: [app.requirePermission('grn.post')] }, async (request, reply) => {
    const b = parseBody(grnBody, request.body);
    assertInScope(request, b.branchId);
    const r = await receiveGoods(app.db, {
      id: b.id,
      branchId: b.branchId,
      supplierId: b.supplierId,
      poId: b.poId ?? null,
      receivedBy: request.user!.personId,
      supplierInvoiceNo: b.supplierInvoiceNo ?? null,
      invoiceDate: b.invoiceDate ?? null,
      invoiceTotal: b.invoiceTotal ?? null,
      notes: b.notes ?? null,
      lines: b.lines,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/goods-received', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const q = parseQuery(docQuery, request.query);
    const limitTo = scopedBranchIds(request);
    if (q.branchId !== undefined) assertInScope(request, q.branchId);
    const tz = await businessTimezone(app.db);
    const where = [
      limitTo === null ? sql`` : sql`AND g.branch_id IN (${sql.join(limitTo)})`,
      q.branchId === undefined ? sql`` : sql`AND g.branch_id = ${q.branchId}`,
      q.supplierId === undefined ? sql`` : sql`AND g.supplier_id = ${q.supplierId}`,
      q.q === undefined ? sql`` : sql`AND (g.grn_no ILIKE ${'%' + q.q + '%'} OR g.supplier_invoice_no ILIKE ${'%' + q.q + '%'})`,
      q.from === undefined ? sql`` : sql`AND g.received_at >= ((${q.from}::date)::timestamp AT TIME ZONE ${tz})`,
      q.to === undefined ? sql`` : sql`AND g.received_at < (((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz})`,
    ];
    const rows = await sql<Record<string, unknown>>`
      SELECT g.id, g.grn_no AS "grnNo", g.received_at AS "receivedAt", g.total_cost AS "totalCost", g.supplier_invoice_no AS "invoiceNo",
             g.invoice_date::text AS "invoiceDate", g.invoice_total AS "invoiceTotal",
             s.id AS "supplierId", s.name AS "supplierName", b.id AS "branchId", b.name AS "branchName", po.po_no AS "poNo", pe.full_name AS "receivedByName",
             (SELECT count(*)::int FROM goods_received_line l WHERE l.grn_id = g.id) AS "lineCount",
             coalesce((SELECT sum(p.amount) FROM supplier_payment p WHERE p.grn_id = g.id AND p.voided_at IS NULL), 0) AS "paid"
      FROM goods_received g JOIN supplier s ON s.id = g.supplier_id JOIN branch b ON b.id = g.branch_id
      LEFT JOIN purchase_order po ON po.id = g.po_id JOIN person pe ON pe.id = g.received_by
      WHERE true ${sql.join(where, sql` `)}
      ORDER BY g.received_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    const hide = limitTo !== null;
    return {
      items: rows.rows.map((g) => ({
        ...g, totalCost: round2(g['totalCost']), invoiceTotal: g['invoiceTotal'] === null ? null : round2(g['invoiceTotal']),
        lineCount: n(g['lineCount']), paid: hide ? null : round2(g['paid']),
      })),
      limit: q.limit, offset: q.offset, financeHidden: hide,
    };
  });

  app.get('/goods-received/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const g = await sql<Record<string, unknown>>`
      SELECT g.id, g.grn_no AS "grnNo", g.received_at AS "receivedAt", g.total_cost AS "totalCost", g.supplier_invoice_no AS "invoiceNo",
             g.invoice_date::text AS "invoiceDate", g.invoice_total AS "invoiceTotal", g.notes,
             s.id AS "supplierId", s.name AS "supplierName", s.code AS "supplierCode", b.id AS "branchId", b.name AS "branchName", b.code AS "branchCode",
             po.id AS "poId", po.po_no AS "poNo", pe.full_name AS "receivedByName"
      FROM goods_received g JOIN supplier s ON s.id = g.supplier_id JOIN branch b ON b.id = g.branch_id
      LEFT JOIN purchase_order po ON po.id = g.po_id JOIN person pe ON pe.id = g.received_by
      WHERE g.id = ${id}::uuid`.execute(app.db);
    const head = g.rows[0];
    if (head === undefined) throw new PurchasingDocumentNotFound('goods received note', id);
    assertInScope(request, String(head['branchId']));
    const lines = await sql<Record<string, unknown>>`
      SELECT l.line_no AS "lineNo", l.product_id AS "productId", p.sku, p.name, pk.label AS "packLabel", l.qty_packs AS "qtyPacks", l.qty_base AS "qtyBase",
             l.unit_cost AS "unitCost", l.line_total AS "lineTotal", ol.unit_cost AS "orderedUnitCost", ol.qty_packs AS "orderedPacks"
      FROM goods_received_line l JOIN product p ON p.id = l.product_id JOIN product_pack pk ON pk.id = l.pack_id
      LEFT JOIN purchase_order_line ol ON ol.id = l.po_line_id
      WHERE l.grn_id = ${id}::uuid ORDER BY l.line_no`.execute(app.db);
    return {
      ...head,
      totalCost: round2(head['totalCost']),
      invoiceTotal: head['invoiceTotal'] === null ? null : round2(head['invoiceTotal']),
      lines: lines.rows.map((l) => ({
        ...l, qtyPacks: n(l['qtyPacks']), qtyBase: n(l['qtyBase']), unitCost: n(l['unitCost']), lineTotal: round2(l['lineTotal']),
        orderedUnitCost: l['orderedUnitCost'] === null ? null : n(l['orderedUnitCost']),
        orderedPacks: l['orderedPacks'] === null ? null : n(l['orderedPacks']),
      })),
    };
  });

  // ======================================================================================================
  // payments to suppliers
  // ======================================================================================================

  app.post('/supplier-payments', { onRequest: [app.requirePermission('supplier.pay')] }, async (request, reply) => {
    const b = parseBody(paymentBody, request.body);
    const r = await recordPayment(app.db, {
      id: b.id,
      supplierId: b.supplierId,
      amount: b.amount,
      paymentTypeId: b.paymentTypeId,
      reference: b.reference ?? null,
      paidAt: b.paidAt,
      poId: b.poId ?? null,
      grnId: b.grnId ?? null,
      note: b.note ?? null,
      recordedBy: request.user!.personId,
    });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/supplier-payments', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    requireGroupWide(request);
    const q = parseQuery(paymentQuery, request.query);
    const tz = await businessTimezone(app.db);
    const where = [
      q.supplierId === undefined ? sql`` : sql`AND p.supplier_id = ${q.supplierId}`,
      q.paymentTypeId === undefined ? sql`` : sql`AND p.payment_type_id = ${q.paymentTypeId}`,
      q.includeVoided ? sql`` : sql`AND p.voided_at IS NULL`,
      q.from === undefined ? sql`` : sql`AND p.paid_at >= ((${q.from}::date)::timestamp AT TIME ZONE ${tz})`,
      q.to === undefined ? sql`` : sql`AND p.paid_at < (((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz})`,
    ];
    const rows = await sql<Record<string, unknown>>`
      SELECT p.id, p.payment_no AS "paymentNo", p.amount, p.paid_at AS "paidAt", p.reference, t.id AS "methodId", t.name AS method, p.note,
             s.id AS "supplierId", s.name AS "supplierName", po.po_no AS "poNo", g.grn_no AS "grnNo", pe.full_name AS "recordedByName",
             p.voided_at AS "voidedAt", p.void_reason AS "voidReason",
             (SELECT count(*)::int FROM supplier_payment_proof x WHERE x.payment_id = p.id) AS proofs,
             (SELECT min(gr.received_at) FROM goods_received gr WHERE gr.id = p.grn_id OR (p.grn_id IS NULL AND gr.po_id = p.po_id AND p.po_id IS NOT NULL)) AS "firstDelivery",
             (p.po_id IS NOT NULL OR p.grn_id IS NOT NULL) AS linked
      FROM supplier_payment p JOIN supplier s ON s.id = p.supplier_id JOIN payment_type t ON t.id = p.payment_type_id
      JOIN person pe ON pe.id = p.recorded_by LEFT JOIN purchase_order po ON po.id = p.po_id LEFT JOIN goods_received g ON g.id = p.grn_id
      WHERE true ${sql.join(where, sql` `)}
      ORDER BY p.paid_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`.execute(app.db);
    const total = await sql<{ total: number; n: number }>`
      SELECT coalesce(sum(p.amount), 0) AS total, count(*)::int AS n FROM supplier_payment p WHERE true ${sql.join(where, sql` `)}`.execute(app.db);
    return {
      items: rows.rows.map((p) => ({
        ...p,
        amount: round2(p['amount']),
        proofs: n(p['proofs']),
        timing: paymentTiming(dayIn(tz, p['paidAt'] as Date), Boolean(p['linked']), p['firstDelivery'] === null ? null : dayIn(tz, p['firstDelivery'] as Date)),
        linked: undefined,
        firstDelivery: undefined,
      })),
      total: round2(total.rows[0]?.total), count: n(total.rows[0]?.n), limit: q.limit, offset: q.offset,
    };
  });

  app.get('/supplier-payments/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request) => {
    requireGroupWide(request);
    const { id } = parseParams(idParams, request.params);
    const p = await sql<Record<string, unknown>>`
      SELECT p.id, p.payment_no AS "paymentNo", p.amount, p.paid_at AS "paidAt", p.reference, t.name AS method, p.note,
             s.id AS "supplierId", s.name AS "supplierName", p.po_id AS "poId", po.po_no AS "poNo", p.grn_id AS "grnId", g.grn_no AS "grnNo",
             pe.full_name AS "recordedByName", p.recorded_at AS "recordedAt", p.voided_at AS "voidedAt", p.void_reason AS "voidReason", vp.full_name AS "voidedByName"
      FROM supplier_payment p JOIN supplier s ON s.id = p.supplier_id JOIN payment_type t ON t.id = p.payment_type_id JOIN person pe ON pe.id = p.recorded_by
      LEFT JOIN purchase_order po ON po.id = p.po_id LEFT JOIN goods_received g ON g.id = p.grn_id LEFT JOIN person vp ON vp.id = p.voided_by
      WHERE p.id = ${id}::uuid`.execute(app.db);
    const row = p.rows[0];
    if (row === undefined) throw new PurchasingDocumentNotFound('payment', id);
    const proofs = await app.db
      .selectFrom('supplier_payment_proof')
      .innerJoin('person', 'person.id', 'supplier_payment_proof.uploaded_by')
      .select(['supplier_payment_proof.id', 'file_name as fileName', 'content_type as contentType', 'size_bytes as sizeBytes', 'sha256', 'uploaded_at as uploadedAt', 'person.full_name as uploadedByName'])
      .where('payment_id', '=', id)
      .orderBy('uploaded_at')
      .execute();
    return { ...row, amount: round2(row['amount']), proofs };
  });

  app.post('/supplier-payments/:id/void', { onRequest: [app.requirePermission('supplier.pay')] }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const { reason } = parseBody(reasonBody, request.body);
    await voidPayment(app.db, id, request.user!.personId, reason);
    return { ok: true };
  });

  /** Attach a file: the raw bytes as the body, the name in the x-file-name header. */
  app.post('/supplier-payments/:id/proofs', { onRequest: [app.requirePermission('supplier.pay')], bodyLimit: MAX_PROOF_BYTES + 1024 }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.status(415).send({ error: { code: 'PROOF_REJECTED', message: 'Send the file itself as the request body (a PNG, JPEG, WebP or PDF).' } });
    }
    const raw = request.headers['x-file-name'];
    const name = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')) || 'proof';
    const r = await addProof(app.db, id, request.user!.personId, name, body);
    return reply.status(201).send(r);
  });

  /** Download a file. Served as data with sniffing off and scripts disabled, whatever it claims to be. */
  app.get('/supplier-payments/proofs/:id', { onRequest: [app.requirePermission('supplier.read')] }, async (request, reply) => {
    requireGroupWide(request);
    const { id } = parseParams(idParams, request.params);
    const f = await app.db.selectFrom('supplier_payment_proof').select(['file_name', 'content_type', 'data']).where('id', '=', id).executeTakeFirst();
    if (f === undefined) throw new PurchasingDocumentNotFound('proof of payment', id);
    return reply
      .header('Content-Type', f.content_type)
      .header('Content-Disposition', `inline; filename="${f.file_name.replace(/"/g, '')}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .send(f.data);
  });
}
