/**
 * Supplier price lists: match a pasted list to our items, preview the new
 * costs and prices, and apply them as one numbered document.
 *
 * A line is matched by, in order: the supplier's own code (remembered from
 * earlier lists), a barcode (which names an exact pack), then our SKU (the
 * item's buying pack). The old cost is what this supplier last charged for
 * the pack; failing that, our average cost of it.
 */

import {
  InvalidPriceList,
  marginPercent,
  nameIndex,
  parseCostMicro,
  parsePriceList,
  PriceBelowCost,
  suggestedPrice,
  type PriceRule,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

const micro = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.round(Number(n) * 10_000));
const fromMicro = (m: number): number => m / 10_000;

interface PackInfo {
  packId: string;
  productId: string;
  name: string;
  sku: string;
  packLabel: string;
  qtyBase: number;
  sellPrice: number | null;
  supplierCost: number | null;
  avgCost: number | null;
}

/** Everything about the packs that matters to pricing: current price, this supplier's last cost, our average cost. */
async function packInfo(db: Db | Tx, supplierId: string, packIds: string[]): Promise<Map<string, PackInfo>> {
  if (packIds.length === 0) return new Map();
  const r = await sql<PackInfo>`
    SELECT pk.id AS "packId", p.id AS "productId", p.name, p.sku, pk.label AS "packLabel", pk.qty_base AS "qtyBase",
           pk.sell_price AS "sellPrice", si.cost AS "supplierCost",
           (SELECT sum(m.qty_base * m.unit_cost) / nullif(sum(m.qty_base), 0) FROM stock_movement m
             WHERE m.product_id = p.id AND m.reason IN ('grn', 'opening_balance', 'transfer_in') AND m.unit_cost IS NOT NULL) * pk.qty_base AS "avgCost"
    FROM product_pack pk JOIN product p ON p.id = pk.product_id
    LEFT JOIN supplier_item si ON si.pack_id = pk.id AND si.supplier_id = ${supplierId}::uuid
    WHERE pk.id = ANY(${packIds}::uuid[])`.execute(db);
  return new Map(
    r.rows.map((x) => [
      x.packId,
      {
        ...x,
        qtyBase: Number(x.qtyBase),
        sellPrice: x.sellPrice === null ? null : Number(x.sellPrice),
        supplierCost: x.supplierCost === null ? null : Number(x.supplierCost),
        avgCost: x.avgCost === null ? null : Number(x.avgCost),
      },
    ]),
  );
}

/** code (lower-cased) -> pack and how it was matched. */
type MatchedBy = 'supplier code' | 'barcode' | 'SKU' | 'your choice';

async function matchCodes(db: Db, supplierId: string, codes: string[]): Promise<Map<string, { packId: string; by: MatchedBy }>> {
  const lower = [...new Set(codes.map((c) => c.toLowerCase()))];
  const out = new Map<string, { packId: string; by: MatchedBy }>();
  if (lower.length === 0) return out;
  const [own, bars, skus] = await Promise.all([
    sql<{ code: string; packId: string }>`
      SELECT lower(supplier_code) AS code, pack_id AS "packId" FROM supplier_item
      WHERE supplier_id = ${supplierId}::uuid AND lower(supplier_code) = ANY(${lower}::text[])`.execute(db),
    sql<{ code: string; packId: string }>`
      SELECT lower(b.code) AS code, b.pack_id AS "packId" FROM barcode b
      JOIN product_pack pk ON pk.id = b.pack_id JOIN product p ON p.id = pk.product_id
      WHERE lower(b.code) = ANY(${lower}::text[]) AND p.merged_into_id IS NULL`.execute(db),
    // By SKU: the pack the item is bought in; else the one it is sold in; else the largest.
    sql<{ code: string; packId: string }>`
      SELECT DISTINCT ON (lower(p.sku)) lower(p.sku) AS code, pk.id AS "packId"
      FROM product p JOIN product_pack pk ON pk.product_id = p.id
      WHERE lower(p.sku) = ANY(${lower}::text[]) AND p.merged_into_id IS NULL AND p.is_active
      ORDER BY lower(p.sku), pk.is_default_buy DESC, pk.is_default_sell DESC, pk.qty_base DESC`.execute(db),
  ]);
  for (const r of skus.rows) out.set(r.code, { packId: r.packId, by: 'SKU' });
  for (const r of bars.rows) out.set(r.code, { packId: r.packId, by: 'barcode' });
  for (const r of own.rows) out.set(r.code, { packId: r.packId, by: 'supplier code' });
  return out;
}

export interface PreviewLine {
  row: number;
  code: string;
  description: string;
  cost: number | null;
  problem: string | null;
  /** For a line that matched nothing: items whose name is like the line's description. */
  suggestions: { packId: string; name: string; sku: string; packLabel: string; score: number }[];
  match: null | {
    packId: string;
    productId: string;
    name: string;
    sku: string;
    packLabel: string;
    by: string;
    oldCost: number | null;
    oldCostSource: 'supplier' | 'average' | null;
    currentSell: number | null;
    suggestedSell: number | null;
    oldMargin: number | null;
    newMargin: number | null;
    costChangePercent: number | null;
  };
}

export async function previewPriceList(db: Db, input: { supplierId: string; text: string; rule: PriceRule; links?: Record<string, string> }) {
  const s = await db.selectFrom('supplier').select(['id', 'name']).where('id', '=', input.supplierId).executeTakeFirst();
  if (s === undefined) throw new InvalidPriceList('No such supplier.');
  const parsed = parsePriceList(input.text);
  if (parsed.length === 0) throw new InvalidPriceList('Nothing to read: paste the list, one item a line, with a code and a price.');
  if (parsed.length > 5_000) throw new InvalidPriceList('That list is over 5,000 lines: split it into parts.');

  const matches = await matchCodes(db, input.supplierId, parsed.filter((l) => l.problem === null).map((l) => l.code));
  // Lines the importer linked to an item themselves ("did you mean…?"): their choice wins.
  for (const [code, packId] of Object.entries(input.links ?? {})) matches.set(code.toLowerCase(), { packId, by: 'your choice' });
  // Suggestions for what still matches nothing, from the description on the line.
  const unmatched = parsed.filter((l) => l.problem === null && !matches.has(l.code.toLowerCase()));
  const suggestIx =
    unmatched.length === 0
      ? null
      : nameIndex(
          (
            await sql<{ id: string; name: string; sku: string; label: string }>`
              SELECT DISTINCT ON (p.id) pk.id, p.name, p.sku, pk.label
              FROM product p JOIN product_pack pk ON pk.product_id = p.id
              WHERE p.merged_into_id IS NULL AND p.is_active
              ORDER BY p.id, pk.is_default_buy DESC, pk.qty_base DESC`.execute(db)
          ).rows.map((r) => ({ id: r.id, name: r.name, sku: `${r.sku}|${r.label}` })),
        );
  const suggest = (l: { code: string; description: string }) => {
    if (suggestIx === null) return [];
    const text = l.description.trim() !== '' ? l.description : l.code;
    const hits = [...suggestIx.same(text).map((item) => ({ item, score: 1 })), ...suggestIx.alike(text, 3, 0.55)].slice(0, 3);
    return hits.map((h) => {
      const [sku = '', packLabel = ''] = (h.item.sku ?? '').split('|');
      return { packId: h.item.id, name: h.item.name, sku, packLabel, score: h.score };
    });
  };
  const info = await packInfo(db, input.supplierId, [...new Set([...matches.values()].map((m) => m.packId))]);
  const seen = new Map<string, number>();

  const lines: PreviewLine[] = parsed.map((l) => {
    const base = { row: l.row, code: l.code, description: l.description, cost: l.costMicro === null ? null : fromMicro(l.costMicro), suggestions: [] as PreviewLine['suggestions'] };
    if (l.problem !== null) return { ...base, problem: l.problem, match: null };
    const m = matches.get(l.code.toLowerCase());
    const p = m === undefined ? undefined : info.get(m.packId);
    if (m === undefined || p === undefined) return { ...base, problem: 'No item of ours has this code, barcode or SKU', suggestions: suggest(l), match: null };
    const dup = seen.get(m.packId);
    if (dup !== undefined) return { ...base, problem: `The same item as line ${dup}`, match: null };
    seen.set(m.packId, l.row);

    const oldCost = p.supplierCost ?? p.avgCost;
    const oldMicro = micro(oldCost);
    const sellCents = p.sellPrice === null ? null : Math.round(p.sellPrice * 100);
    const suggested = suggestedPrice({ newCostMicro: l.costMicro!, oldCostMicro: oldMicro, currentSellCents: sellCents }, input.rule);
    return {
      ...base,
      problem: null,
      match: {
        packId: p.packId,
        productId: p.productId,
        name: p.name,
        sku: p.sku,
        packLabel: p.packLabel,
        by: m.by,
        oldCost: oldMicro === null ? null : fromMicro(oldMicro),
        oldCostSource: p.supplierCost !== null ? 'supplier' : p.avgCost !== null ? 'average' : null,
        currentSell: p.sellPrice,
        suggestedSell: suggested === null ? null : suggested / 100,
        oldMargin: marginPercent(sellCents, oldMicro),
        newMargin: marginPercent(suggested ?? sellCents, l.costMicro),
        costChangePercent: oldMicro === null || oldMicro === 0 ? null : Math.round(((l.costMicro! - oldMicro) / oldMicro) * 1000) / 10,
      },
    };
  });
  return {
    supplier: s,
    lines,
    matched: lines.filter((l) => l.match !== null).length,
    unmatched: lines.filter((l) => l.match === null).length,
  };
}

// -- applying ---------------------------------------------------------------------------------------------------------

export interface ApplyLine {
  packId: string;
  supplierCode: string | null;
  cost: number;
  /** null: leave the selling price as it is. */
  newSell: number | null;
}

export async function applyPriceList(
  db: Db,
  input: { id: string; supplierId: string; rule: PriceRule; note: string | null; lines: ApplyLine[]; actorId: string },
): Promise<{ id: string; listNo: string; pricesChanged: number; replayed: boolean }> {
  const done = await db.selectFrom('supplier_price_list').select(['id', 'list_no', 'prices_changed']).where('id', '=', input.id).executeTakeFirst();
  if (done !== undefined) return { id: done.id, listNo: done.list_no, pricesChanged: done.prices_changed, replayed: true };
  if (input.lines.length === 0) throw new InvalidPriceList('Tick at least one line to apply.');
  const packs = new Set<string>();
  for (const l of input.lines) {
    if (packs.has(l.packId)) throw new InvalidPriceList('The same item is on the list twice.');
    packs.add(l.packId);
    if (micro(l.cost) === null || parseCostMicro(String(l.cost)) === null || l.cost <= 0) throw new InvalidPriceList('A cost must be above zero, with at most four decimals.');
  }

  try {
    return await db.transaction().execute(async (tx) => {
      // One import at a time per supplier, so two people importing cannot interleave codes.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'supplier-prices:' + input.supplierId}, 0))`.execute(tx);
      const s = await tx.selectFrom('supplier').select(['id', 'name']).where('id', '=', input.supplierId).executeTakeFirst();
      if (s === undefined) throw new InvalidPriceList('No such supplier.');
      // The prices being changed are locked, so a price edited at the same moment is not silently overwritten unaudited.
      await sql`SELECT id FROM product_pack WHERE id = ANY(${[...packs]}::uuid[]) ORDER BY id FOR UPDATE`.execute(tx);
      const info = await packInfo(tx, input.supplierId, [...packs]);
      if (info.size !== packs.size) throw new InvalidPriceList('An item on the list no longer exists.');

      const below = input.lines
        .filter((l) => l.newSell !== null && Math.round(l.newSell * 100) * 100 < Math.round(l.cost * 10_000))
        .map((l) => ({ name: info.get(l.packId)!.name, cost: l.cost, sellPrice: l.newSell! }));
      if (below.length > 0) throw new PriceBelowCost(below);

      const counter = await sql<{ lastNo: number }>`
        INSERT INTO group_counter (doc_kind, last_no) VALUES ('SPL', 1)
        ON CONFLICT (doc_kind) DO UPDATE SET last_no = group_counter.last_no + 1
        RETURNING last_no AS "lastNo"`.execute(tx);
      const listNo = `SPL-${String(Number(counter.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;
      const at = new Date();
      const changes = input.lines.filter((l) => l.newSell !== null && l.newSell !== info.get(l.packId)!.sellPrice);

      await tx
        .insertInto('supplier_price_list')
        .values({
          id: input.id, list_no: listNo, supplier_id: s.id, rule: JSON.stringify(input.rule), note: input.note,
          lines: input.lines.length, prices_changed: changes.length, created_by: input.actorId, created_at: at,
        })
        .execute();
      await tx
        .insertInto('supplier_price_list_line')
        .values(
          input.lines.map((l, i) => {
            const p = info.get(l.packId)!;
            return {
              list_id: input.id, line_no: i + 1, pack_id: l.packId, supplier_code: l.supplierCode, cost: l.cost,
              old_cost: p.supplierCost ?? (p.avgCost === null ? null : Math.round(p.avgCost * 10_000) / 10_000),
              old_sell: p.sellPrice, new_sell: l.newSell,
            };
          }),
        )
        .execute();

      for (const l of input.lines) {
        // A code the supplier now uses for this pack is taken off any other pack it was on.
        if (l.supplierCode !== null) {
          await sql`UPDATE supplier_item SET supplier_code = NULL
                    WHERE supplier_id = ${s.id}::uuid AND lower(supplier_code) = lower(${l.supplierCode}) AND pack_id <> ${l.packId}::uuid`.execute(tx);
        }
        await sql`
          INSERT INTO supplier_item (supplier_id, pack_id, supplier_code, cost, list_id, updated_at)
          VALUES (${s.id}::uuid, ${l.packId}::uuid, ${l.supplierCode}, ${l.cost}, ${input.id}::uuid, ${at})
          ON CONFLICT (supplier_id, pack_id) DO UPDATE
            SET supplier_code = coalesce(EXCLUDED.supplier_code, supplier_item.supplier_code),
                cost = EXCLUDED.cost, list_id = EXCLUDED.list_id, updated_at = EXCLUDED.updated_at`.execute(tx);
      }

      for (const l of changes) {
        const old = info.get(l.packId)!.sellPrice;
        await tx.updateTable('product_pack').set({ sell_price: l.newSell }).where('id', '=', l.packId).execute();
        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(), action_code: 'PRICE_CHANGED', actor_id: input.actorId, terminal_id: null, branch_id: null,
            entity_type: 'product_pack', entity_id: l.packId,
            state_before: JSON.stringify({ sellPrice: old }),
            state_after: JSON.stringify({ sellPrice: l.newSell, basis: `${listNo} from ${s.name}: cost ${l.cost}` }),
            occurred_at: at,
          })
          .execute();
      }
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(), action_code: 'SUPPLIER_PRICE_LIST', actor_id: input.actorId, terminal_id: null, branch_id: null,
          entity_type: 'supplier_price_list', entity_id: input.id, state_before: null,
          state_after: JSON.stringify({ listNo, supplier: s.name, lines: input.lines.length, pricesChanged: changes.length, rule: input.rule }),
          occurred_at: at,
        })
        .execute();
      return { id: input.id, listNo, pricesChanged: changes.length, replayed: false };
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'supplier_price_list_pkey') {
      const won = await db.selectFrom('supplier_price_list').select(['id', 'list_no', 'prices_changed']).where('id', '=', input.id).executeTakeFirstOrThrow();
      return { id: won.id, listNo: won.list_no, pricesChanged: won.prices_changed, replayed: true };
    }
    throw error;
  }
}
