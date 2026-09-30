/**
 * Insights: what the records say needs attention, each with the figure behind
 * it, a few named examples, and the screen where it is dealt with.
 *
 * Every insight is a plain rule over the ledgers - no guessing, no model. A
 * rule that finds nothing says nothing. Branch-scoped people see their own
 * branches; prices and costs are group-wide, as on the Prices screen.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { assertInScope, scopedBranchIds } from '../scope.js';
import { parseQuery } from '../validation.js';

const query = z.object({ branchId: z.uuid().optional() });

type Severity = 'high' | 'medium' | 'low';
export interface Insight {
  id: string;
  area: 'Prices and margins' | 'Stock' | 'Cash' | 'Controls' | 'Item data';
  severity: Severity;
  title: string;
  why: string;
  figure: string;
  examples: string[];
  action: { label: string; to: string };
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export async function registerInsightRoutes(app: FastifyInstance): Promise<void> {
  /** The branches in view: one asked for, or all the caller may see. */
  async function branchesInView(request: FastifyRequest, branchId: string | undefined): Promise<string[]> {
    if (branchId !== undefined) {
      assertInScope(request, branchId);
      return [branchId];
    }
    const scope = scopedBranchIds(request);
    const rows = await app.db.selectFrom('branch').select('id').where('is_active', '=', true).$if(scope !== null, (qb) => qb.where('id', 'in', scope as string[])).execute();
    return rows.map((r) => r.id);
  }

  app.get('/insights', { onRequest: [app.requirePermission('dashboard.read')] }, async (request) => {
    const q = parseQuery(query, request.query);
    const branches = await branchesInView(request, q.branchId);
    const insights: Insight[] = [];
    if (branches.length === 0) return { insights };
    // Each card shows only what the person could already see on the screen it is about.
    const may = (p: string) => request.user!.permissions.has(p);
    const seesCosts = may('price.write') || may('sale.read');
    const pricesAt = may('price.write') ? { label: 'Fix prices', to: '/prices' } : { label: 'See sales and profit', to: '/profit' };
    const reviewAt = may('price.write') ? { label: 'Review prices', to: '/prices' } : { label: 'See sales and profit', to: '/profit' };
    const b = sql`${branches}::uuid[]`;

    // Average cost per base unit across the branches in view (what stock is valued at).
    const costCte = sql`cost AS (
      SELECT product_id, sum(qty_base * unit_cost) / nullif(sum(qty_base), 0) AS wac
      FROM stock_movement
      WHERE reason IN ('grn', 'opening_balance', 'transfer_in') AND unit_cost IS NOT NULL AND branch_id = ANY(${b})
      GROUP BY product_id)`;

    // -- 1. selling below cost ---------------------------------------------------------------------------------------
    const below = await sql<{ name: string; label: string; sell: number; cost: number }>`
      WITH ${costCte}
      SELECT p.name, pk.label, pk.sell_price AS sell, round(cost.wac * pk.qty_base, 2) AS cost
      FROM product_pack pk JOIN product p ON p.id = pk.product_id AND p.is_active AND p.merged_into_id IS NULL
      JOIN cost ON cost.product_id = p.id
      WHERE pk.sell_price IS NOT NULL AND pk.sell_price < cost.wac * pk.qty_base
      ORDER BY (cost.wac * pk.qty_base - pk.sell_price) DESC`.execute(app.db);
    if (seesCosts && below.rows.length > 0) {
      insights.push({
        id: 'below-cost', area: 'Prices and margins', severity: 'high',
        title: `${plural(below.rows.length, 'price')} below cost`,
        why: 'Every one of these sold loses money. Usually a cost went up and the selling price was not changed, or a price was typed wrong.',
        figure: plural(below.rows.length, 'pack'),
        examples: below.rows.slice(0, 5).map((r) => `${r.name} (${r.label}): sells ${money(Number(r.sell))}, costs ${money(Number(r.cost))}`),
        action: pricesAt,
      });
    }

    // -- 2. thin margins -------------------------------------------------------------------------------------------------
    const thin = await sql<{ name: string; label: string; margin: number }>`
      WITH ${costCte}
      SELECT p.name, pk.label, round((pk.sell_price - cost.wac * pk.qty_base) / pk.sell_price * 100, 1) AS margin
      FROM product_pack pk JOIN product p ON p.id = pk.product_id AND p.is_active AND p.merged_into_id IS NULL
      JOIN cost ON cost.product_id = p.id
      WHERE pk.sell_price > 0 AND pk.sell_price >= cost.wac * pk.qty_base
        AND (pk.sell_price - cost.wac * pk.qty_base) / pk.sell_price < 0.05
      ORDER BY margin`.execute(app.db);
    if (seesCosts && thin.rows.length > 0) {
      insights.push({
        id: 'thin-margin', area: 'Prices and margins', severity: 'medium',
        title: `${plural(thin.rows.length, 'price')} with a margin under 5%`,
        why: 'Barely above cost: a small cost increase, breakage or theft turns them into losses. Check they are priced on purpose.',
        figure: plural(thin.rows.length, 'pack'),
        examples: thin.rows.slice(0, 5).map((r) => `${r.name} (${r.label}): ${Number(r.margin)}% margin`),
        action: reviewAt,
      });
    }

    // -- 3. costs rising faster than prices ---------------------------------------------------------------------------------
    const rising = await sql<{ name: string; last: number; avg: number; sell: number }>`
      WITH ${costCte}, last AS (
        SELECT DISTINCT ON (l.product_id) l.product_id, l.unit_cost * l.qty_packs / nullif(l.qty_base, 0) AS cost_base
        FROM goods_received_line l JOIN goods_received g ON g.id = l.grn_id
        WHERE g.branch_id = ANY(${b})
        ORDER BY l.product_id, g.received_at DESC)
      SELECT p.name, round(last.cost_base, 2) AS last, round(cost.wac, 2) AS avg, pk.sell_price / pk.qty_base AS sell
      FROM last JOIN cost ON cost.product_id = last.product_id
      JOIN product p ON p.id = last.product_id AND p.is_active AND p.merged_into_id IS NULL
      JOIN product_pack pk ON pk.product_id = p.id AND pk.is_default_sell AND pk.sell_price IS NOT NULL
      WHERE last.cost_base > cost.wac * 1.05
        AND (pk.sell_price / pk.qty_base - last.cost_base) / (pk.sell_price / pk.qty_base) < 0.10
      ORDER BY last.cost_base / cost.wac DESC`.execute(app.db);
    if (seesCosts && rising.rows.length > 0) {
      insights.push({
        id: 'cost-rising', area: 'Prices and margins', severity: 'medium',
        title: `${plural(rising.rows.length, 'item')} now cost more than they are priced for`,
        why: 'The latest delivery cost is well above the average, and at that cost the margin is under 10%. Once the older, cheaper stock is sold, these lose money.',
        figure: plural(rising.rows.length, 'item'),
        examples: rising.rows.slice(0, 5).map((r) => `${r.name}: last cost ${money(Number(r.last))} a unit (average ${money(Number(r.avg))}), sells ${money(Number(r.sell))}`),
        action: reviewAt,
      });
    }

    // -- 4. best sellers out of stock ---------------------------------------------------------------------------------------
    const out = await sql<{ name: string; branch: string; sold: number }>`
      SELECT p.name, br.name AS branch, round(-sum(m.qty_base), 2) AS sold
      FROM stock_movement m
      JOIN product p ON p.id = m.product_id AND p.is_active AND p.merged_into_id IS NULL
      JOIN branch br ON br.id = m.branch_id
      LEFT JOIN stock_on_hand s ON s.product_id = m.product_id AND s.branch_id = m.branch_id
      WHERE m.branch_id = ANY(${b}) AND m.reason IN ('sale', 'sale_refund') AND m.occurred_at >= now() - interval '30 days'
        AND coalesce(s.qty_base, 0) <= 0
      GROUP BY p.name, br.name
      HAVING -sum(m.qty_base) > 0
      ORDER BY sold DESC`.execute(app.db);
    if (may('stock.read') && out.rows.length > 0) {
      insights.push({
        id: 'out-of-stock', area: 'Stock', severity: 'high',
        title: `${plural(out.rows.length, 'item')} selling but out of stock`,
        why: 'These sold in the last 30 days and have none left: every day out is sales lost to another shop.',
        figure: plural(out.rows.length, 'item'),
        examples: out.rows.slice(0, 5).map((r) => `${r.name} at ${r.branch}: ${Number(r.sold)} sold in 30 days, none left`),
        action: may('po.write') ? { label: 'Reorder', to: '/reorder' } : { label: 'See stock on hand', to: '/stock' },
      });
    }

    // -- 5. money in stock that is not selling ---------------------------------------------------------------------------------
    const dead = await sql<{ n: number; value: number }>`
      SELECT count(*)::int AS n, coalesce(round(sum(s.qty_base * w.wac), 2), 0) AS value
      FROM stock_on_hand s
      JOIN product p ON p.id = s.product_id AND p.merged_into_id IS NULL
      LEFT JOIN product_wac w ON w.product_id = s.product_id AND w.branch_id = s.branch_id
      WHERE s.branch_id = ANY(${b}) AND s.qty_base > 0
        AND NOT EXISTS (SELECT 1 FROM stock_movement m WHERE m.product_id = s.product_id AND m.branch_id = s.branch_id
                        AND m.reason = 'sale' AND m.occurred_at >= now() - interval '90 days')`.execute(app.db);
    const d = dead.rows[0];
    if (may('stock.read') && d !== undefined && Number(d.n) > 0) {
      insights.push({
        id: 'dead-stock', area: 'Stock', severity: Number(d.value) > 1000 ? 'high' : 'medium',
        title: `${money(Number(d.value))} in stock that has not sold for 90 days`,
        why: 'Cash sitting on the shelf. Move it to a branch where it sells, mark it down, or stop buying it.',
        figure: plural(Number(d.n), 'item line'),
        examples: [],
        action: { label: 'See what is not moving', to: '/not-moving' },
      });
    }

    // -- 6. stock-take losses ---------------------------------------------------------------------------------------------------------
    const counts = await sql<{ branch: string; lost: number; lines: number }>`
      SELECT br.name AS branch, round(-sum(m.qty_base * coalesce(m.unit_cost, 0)), 2) AS lost, count(*)::int AS lines
      FROM stock_movement m JOIN branch br ON br.id = m.branch_id
      WHERE m.branch_id = ANY(${b}) AND m.reason = 'count_adjustment' AND m.qty_base < 0
        AND m.occurred_at >= now() - interval '90 days'
      GROUP BY br.name
      ORDER BY lost DESC`.execute(app.db);
    const lostTotal = counts.rows.reduce((s, r) => s + Number(r.lost), 0);
    if (may('stock.read') && lostTotal > 0) {
      insights.push({
        id: 'count-losses', area: 'Stock', severity: lostTotal > 500 ? 'high' : 'medium',
        title: `${money(lostTotal)} lost at stock takes in 90 days`,
        why: 'Stock the books said was there and the count did not find. Look for patterns: the same items, the same branch, the same shift.',
        figure: money(lostTotal),
        examples: counts.rows.slice(0, 5).map((r) => `${r.branch}: ${money(Number(r.lost))} over ${plural(Number(r.lines), 'line')}`),
        action: may('exception.read') ? { label: 'See count variances', to: '/exceptions' } : { label: 'See the stock ledger', to: '/ledger' },
      });
    }

    // -- 7. cash short, by who was on the till -------------------------------------------------------------------------------------------
    const short = await sql<{ who: string; short: number; times: number }>`
      SELECT coalesce(pe.full_name, 'Unknown') AS who, round(-sum(e.value_impact), 2) AS short, count(*)::int AS times
      FROM exception_event e LEFT JOIN person pe ON pe.id = e.actor_id
      WHERE e.branch_id = ANY(${b}) AND e.kind IN ('cash_variance', 'shift_variance') AND e.value_impact < 0
        AND e.occurred_at >= now() - interval '90 days'
      GROUP BY pe.full_name
      ORDER BY short DESC`.execute(app.db);
    const shortTotal = short.rows.reduce((s, r) => s + Number(r.short), 0);
    if (may('cash.read') && may('exception.read') && shortTotal > 0) {
      const repeat = short.rows.filter((r) => Number(r.times) >= 3);
      insights.push({
        id: 'cash-short', area: 'Cash', severity: repeat.length > 0 ? 'high' : 'medium',
        title: `${money(shortTotal)} short at the tills in 90 days`,
        why: repeat.length > 0 ? `${plural(repeat.length, 'person', 'people')} came up short three times or more - a pattern worth a conversation.` : 'Occasional shortages happen; watch for the same name coming up again.',
        figure: money(shortTotal),
        examples: short.rows.slice(0, 5).map((r) => `${r.who}: ${money(Number(r.short))} over ${plural(Number(r.times), 'count')}`),
        action: { label: 'See cash variances', to: '/exceptions' },
      });
    }

    // -- 8. exceptions nobody has looked at -----------------------------------------------------------------------------------------------
    const stale = await sql<{ n: number; oldest: number }>`
      SELECT count(*)::int AS n, coalesce(max(extract(day from now() - occurred_at)), 0)::int AS oldest
      FROM exception_event WHERE branch_id = ANY(${b}) AND state = 'open' AND occurred_at < now() - interval '7 days'`.execute(app.db);
    const s0 = stale.rows[0];
    if (may('exception.read') && s0 !== undefined && Number(s0.n) > 0) {
      insights.push({
        id: 'stale-exceptions', area: 'Controls', severity: Number(s0.n) > 20 ? 'high' : 'medium',
        title: `${plural(Number(s0.n), 'exception')} open for over a week`,
        why: `A control only works if someone looks. The oldest has waited ${plural(Number(s0.oldest), 'day')}.`,
        figure: plural(Number(s0.n), 'item'),
        examples: [],
        action: { label: 'Open the queue', to: '/exceptions' },
      });
    }

    // -- 9. items that cannot be sold or scanned properly ---------------------------------------------------------------------------------
    const data = await sql<{ no_price: number; no_barcode: number; pending: number }>`
      SELECT
        (SELECT count(*) FROM product p WHERE p.is_active AND p.merged_into_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM product_pack k WHERE k.product_id = p.id AND k.sell_price IS NOT NULL))::int AS no_price,
        (SELECT count(*) FROM product p WHERE p.is_active AND p.merged_into_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM product_pack k JOIN barcode bc ON bc.pack_id = k.id WHERE k.product_id = p.id))::int AS no_barcode,
        (SELECT count(*) FROM product p WHERE p.is_active AND p.review_state = 'pending')::int AS pending`.execute(app.db);
    const dq = data.rows[0];
    if (may('product.read') && dq !== undefined && Number(dq.no_price) + Number(dq.pending) > 0) {
      const ex = [];
      if (Number(dq.no_price) > 0) ex.push(`${plural(Number(dq.no_price), 'item')} with no selling price - cannot be sold`);
      if (Number(dq.pending) > 0) ex.push(`${plural(Number(dq.pending), 'item')} added at the till, waiting for review`);
      if (Number(dq.no_barcode) > 0) ex.push(`${plural(Number(dq.no_barcode), 'item')} with no barcode - found by name only`);
      insights.push({
        id: 'item-data', area: 'Item data', severity: Number(dq.no_price) > 0 ? 'medium' : 'low',
        title: 'Items that need finishing',
        why: 'Gaps in the item master slow the till down and let mistakes in.',
        figure: plural(Number(dq.no_price) + Number(dq.pending), 'item'),
        examples: ex,
        action: { label: 'Open the item master', to: '/products' },
      });
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    insights.sort((x, y) => order[x.severity] - order[y.severity]);
    return { insights, generatedAt: new Date().toISOString() };
  });
}
