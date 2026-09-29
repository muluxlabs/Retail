/**
 * Reorder suggestions: what a branch will run out of, and how much to order.
 *
 * For each item the branch has been selling (a warehouse: selling and sending
 * to branches) over the last `lookbackDays`:
 *
 *   pace        units per day  = units gone / lookbackDays
 *   available   on hand + still to arrive on open orders + in transit to it
 *   reorder     when available will not last the supplier's lead time
 *               (available <= pace x leadDays)
 *   order up to enough for the lead time plus `coverDays` more:
 *               pace x (leadDays + coverDays) - available,
 *               rounded UP to whole buying packs (cases, not singles)
 *
 * Stock already on order or on its way is counted, so nothing is ordered twice.
 * The supplier and price come from the supplier's latest price list for the
 * buying pack, or else the last delivery. This only proposes: a manager turns a
 * supplier's group into a purchase order, checks it and places it.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope } from '../scope.js';
import { parseQuery } from '../validation.js';

const query = z.object({
  branchId: z.uuid(),
  lookbackDays: z.coerce.number().int().min(7).max(180).default(30),
  leadDays: z.coerce.number().int().min(0).max(90).default(7),
  coverDays: z.coerce.number().int().min(1).max(180).default(14),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function registerReorderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reorder', { onRequest: [app.requirePermission('po.write')] }, async (request, reply) => {
    const q = parseQuery(query, request.query);
    assertInScope(request, q.branchId);
    const branch = await app.db.selectFrom('branch').select(['id', 'code', 'name', 'kind']).where('id', '=', q.branchId).executeTakeFirst();
    if (branch === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such branch.' } });
    // A warehouse's demand is what it sends to the branches as well as what it sells.
    const reasons = branch.kind === 'warehouse' ? ['sale', 'sale_refund', 'transfer_out'] : ['sale', 'sale_refund'];

    const rows = await sql<Record<string, unknown>>`
      WITH gone AS (
        SELECT product_id, -sum(qty_base) AS units
        FROM stock_movement
        WHERE branch_id = ${q.branchId}::uuid
          AND reason::text = ANY(${reasons}::text[])
          AND occurred_at >= now() - make_interval(days => ${q.lookbackDays})
        GROUP BY product_id
        HAVING -sum(qty_base) > 0
      ), on_order AS (
        SELECT l.product_id,
               sum(greatest(l.qty_base - coalesce((SELECT sum(g.qty_base) FROM goods_received_line g WHERE g.po_line_id = l.id), 0), 0)) AS units
        FROM purchase_order_line l
        JOIN purchase_order o ON o.id = l.po_id
        WHERE o.branch_id = ${q.branchId}::uuid AND o.cancelled_at IS NULL AND o.closed_at IS NULL
        GROUP BY l.product_id
      ), in_transit AS (
        SELECT tl.product_id, sum(tl.qty_dispatched) AS units
        FROM transfer_line tl JOIN transfer t ON t.id = tl.transfer_id
        WHERE t.destination_branch_id = ${q.branchId}::uuid AND t.state = 'dispatched'
        GROUP BY tl.product_id
      )
      SELECT p.id, p.sku, p.name, p.base_uom,
             gone.units AS gone,
             coalesce(soh.qty_base, 0) AS on_hand,
             coalesce(on_order.units, 0) AS on_order,
             coalesce(in_transit.units, 0) AS in_transit,
             bp.id AS pack_id, bp.label AS pack_label, bp.qty_base AS pack_qty,
             coalesce(sl.supplier_id, lg.supplier_id) AS supplier_id,
             coalesce(sl.supplier_name, lg.supplier_name) AS supplier_name,
             coalesce(sl.cost, lg.cost) AS pack_cost,
             CASE WHEN sl.supplier_id IS NOT NULL THEN 'price list' WHEN lg.supplier_id IS NOT NULL THEN 'last delivery' END AS cost_from,
             (SELECT json_agg(json_build_object('id', k.id, 'label', k.label, 'qtyBase', k.qty_base) ORDER BY k.qty_base) FROM product_pack k WHERE k.product_id = p.id) AS packs
      FROM gone
      JOIN product p ON p.id = gone.product_id AND p.is_active AND p.merged_into_id IS NULL
      LEFT JOIN stock_on_hand soh ON soh.product_id = p.id AND soh.branch_id = ${q.branchId}::uuid
      LEFT JOIN on_order ON on_order.product_id = p.id
      LEFT JOIN in_transit ON in_transit.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT pk.id, pk.label, pk.qty_base FROM product_pack pk
        WHERE pk.product_id = p.id ORDER BY pk.is_default_buy DESC, pk.qty_base DESC LIMIT 1
      ) bp ON true
      LEFT JOIN LATERAL (
        SELECT si.supplier_id, s.name AS supplier_name, si.cost
        FROM supplier_item si JOIN supplier s ON s.id = si.supplier_id AND s.is_active
        WHERE si.pack_id = bp.id ORDER BY si.updated_at DESC LIMIT 1
      ) sl ON true
      LEFT JOIN LATERAL (
        SELECT g.supplier_id, s.name AS supplier_name,
               l.unit_cost * l.qty_packs / nullif(l.qty_base, 0) * bp.qty_base AS cost
        FROM goods_received_line l JOIN goods_received g ON g.id = l.grn_id JOIN supplier s ON s.id = g.supplier_id AND s.is_active
        WHERE l.product_id = p.id ORDER BY g.received_at DESC LIMIT 1
      ) lg ON true
      ORDER BY p.name`.execute(app.db);

    const items = [];
    for (const r of rows.rows) {
      const gone = Number(r['gone']);
      const perDay = gone / q.lookbackDays;
      const onHand = Number(r['on_hand']);
      const onOrder = Number(r['on_order']);
      const inTransit = Number(r['in_transit']);
      const available = onHand + onOrder + inTransit;
      if (perDay <= 0 || available > perDay * q.leadDays) continue;
      const packQty = r['pack_qty'] === null ? 1 : Number(r['pack_qty']);
      const needUnits = perDay * (q.leadDays + q.coverDays) - available;
      const packs = Math.ceil(needUnits / packQty - 1e-9);
      if (packs <= 0) continue;
      const cost = r['pack_cost'] === null ? null : Math.round(Number(r['pack_cost']) * 10_000) / 10_000;
      items.push({
        productId: String(r['id']),
        sku: String(r['sku']),
        name: String(r['name']),
        baseUom: String(r['base_uom']),
        soldInPeriod: gone,
        perDay: r2(perDay),
        onHand,
        onOrder,
        inTransit,
        daysLeft: onHand <= 0 ? 0 : r2(onHand / perDay),
        urgency: onHand <= 0 ? ('out' as const) : onHand / perDay <= q.leadDays / 2 ? ('soon' as const) : ('low' as const),
        pack: r['pack_id'] === null ? null : { id: String(r['pack_id']), label: String(r['pack_label']), qtyBase: packQty },
        packs: (r['packs'] as { id: string; label: string; qtyBase: number }[] | null) ?? [],
        suggestPacks: packs,
        suggestUnits: packs * packQty,
        supplier: r['supplier_id'] === null ? null : { id: String(r['supplier_id']), name: String(r['supplier_name']) },
        costPerPack: cost,
        costFrom: (r['cost_from'] as string | null) ?? null,
        lineCost: cost === null ? null : r2(cost * packs),
      });
    }
    return {
      branch: { id: branch.id, code: branch.code, name: branch.name, kind: branch.kind },
      lookbackDays: q.lookbackDays,
      leadDays: q.leadDays,
      coverDays: q.coverDays,
      items,
    };
  });
}
