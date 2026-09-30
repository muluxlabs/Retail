/**
 * Not moving: stock sitting at a branch that is not selling there.
 *
 *   not selling  stock on hand, nothing sold at this branch in the last `days`
 *   slow         sold, but at that pace the stock lasts more than `slowDays`
 *
 * Each with the money tied up (at average cost), when it last sold and last
 * came in - and, where another branch IS selling it, that branch and a
 * suggested transfer: what that branch would sell over the same `days`, less
 * what it already holds, never more than is here. Moving stock to where it
 * sells beats ordering more there and writing it off here.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { parseQuery } from '../validation.js';

const query = z.object({
  branchId: z.uuid(),
  days: z.coerce.number().int().min(14).max(365).default(60),
  slowDays: z.coerce.number().int().min(30).max(1000).default(180),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function registerNotMovingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stock/not-moving', { onRequest: [app.requirePermission('stock.read')] }, async (request, reply) => {
    const q = parseQuery(query, request.query);
    assertInScope(request, q.branchId);
    const branch = await app.db.selectFrom('branch').select(['id', 'code', 'name', 'kind']).where('id', '=', q.branchId).executeTakeFirst();
    if (branch === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such branch.' } });
    // Where else it sells, among the branches this person may see: a branch-scoped manager never sees another branch's figures.
    const scope = scopedBranchIds(request);
    const others = scope === null ? sql`true` : sql`branch_id = ANY(${scope}::uuid[])`;

    const rows = await sql<Record<string, unknown>>`
      WITH here AS (
        SELECT product_id, qty_base FROM stock_on_hand WHERE branch_id = ${q.branchId}::uuid AND qty_base > 0
      ), sold_here AS (
        SELECT product_id, -sum(qty_base) AS units
        FROM stock_movement
        WHERE branch_id = ${q.branchId}::uuid AND reason IN ('sale', 'sale_refund')
          AND occurred_at >= now() - make_interval(days => ${q.days})
        GROUP BY product_id
      ), elsewhere AS (
        SELECT DISTINCT ON (product_id) product_id, branch_id, units
        FROM (
          SELECT product_id, branch_id, -sum(qty_base) AS units
          FROM stock_movement
          WHERE branch_id <> ${q.branchId}::uuid AND ${others} AND reason IN ('sale', 'sale_refund')
            AND occurred_at >= now() - make_interval(days => ${q.days})
          GROUP BY product_id, branch_id
          HAVING -sum(qty_base) > 0
        ) s
        ORDER BY product_id, units DESC
      )
      SELECT p.id, p.sku, p.name, p.base_uom,
             here.qty_base AS on_hand,
             coalesce(sold_here.units, 0) AS sold,
             w.wac,
             (SELECT max(m.occurred_at) FROM stock_movement m WHERE m.product_id = p.id AND m.branch_id = ${q.branchId}::uuid AND m.reason = 'sale') AS last_sold,
             (SELECT max(m.occurred_at) FROM stock_movement m WHERE m.product_id = p.id AND m.branch_id = ${q.branchId}::uuid AND m.qty_base > 0) AS last_in,
             e.branch_id AS to_branch_id, b.code AS to_code, b.name AS to_name, e.units AS to_sold,
             coalesce((SELECT s2.qty_base FROM stock_on_hand s2 WHERE s2.product_id = p.id AND s2.branch_id = e.branch_id), 0) AS to_on_hand,
             (SELECT json_agg(json_build_object('id', k.id, 'label', k.label, 'qtyBase', k.qty_base) ORDER BY k.qty_base) FROM product_pack k WHERE k.product_id = p.id) AS packs
      FROM here
      JOIN product p ON p.id = here.product_id AND p.merged_into_id IS NULL
      LEFT JOIN sold_here ON sold_here.product_id = p.id
      LEFT JOIN product_wac w ON w.product_id = p.id AND w.branch_id = ${q.branchId}::uuid
      LEFT JOIN elsewhere e ON e.product_id = p.id
      LEFT JOIN branch b ON b.id = e.branch_id AND b.is_active`.execute(app.db);

    const items = [];
    for (const r of rows.rows) {
      const onHand = Number(r['on_hand']);
      const sold = Number(r['sold']);
      const perDay = sold > 0 ? sold / q.days : 0;
      const cover = perDay > 0 ? onHand / perDay : null;
      if (sold > 0 && (cover === null || cover <= q.slowDays)) continue;
      const wac = r['wac'] === null ? null : Number(r['wac']);
      let move = null;
      if (r['to_branch_id'] !== null && r['to_code'] !== null) {
        const theirSold = Number(r['to_sold']);
        const theirStock = Number(r['to_on_hand']);
        const qty = Math.min(onHand, Math.max(0, Math.ceil(theirSold - theirStock)));
        move = {
          branchId: String(r['to_branch_id']),
          code: String(r['to_code']),
          name: String(r['to_name']),
          soldThere: theirSold,
          perDayThere: r2(theirSold / q.days),
          stockThere: theirStock,
          suggestQty: qty,
        };
      }
      items.push({
        productId: String(r['id']),
        sku: String(r['sku']),
        name: String(r['name']),
        baseUom: String(r['base_uom']),
        status: sold > 0 ? ('slow' as const) : ('not-selling' as const),
        onHand,
        soldInPeriod: sold,
        daysOfCover: cover === null ? null : Math.round(cover),
        value: wac === null ? null : r2(onHand * wac),
        lastSold: r['last_sold'] === null ? null : new Date(r['last_sold'] as string).toISOString(),
        lastIn: r['last_in'] === null ? null : new Date(r['last_in'] as string).toISOString(),
        sellsAt: move,
        packs: (r['packs'] as { id: string; label: string; qtyBase: number }[] | null) ?? [],
      });
    }
    items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.name.localeCompare(b.name));
    return {
      branch: { id: branch.id, code: branch.code, name: branch.name },
      days: q.days,
      slowDays: q.slowDays,
      totalValue: r2(items.reduce((s, i) => s + (i.value ?? 0), 0)),
      items,
    };
  });
}
