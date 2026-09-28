/**
 * Importing items: check a parsed spreadsheet against the item master, then
 * create the new items — their packs, barcodes, prices and, if the file gives
 * them, their stock on hand — in one transaction.
 *
 * Duplicates are the danger in a bulk import, so every item is sorted into:
 *
 *   new      nothing like it exists: created.
 *   exists   certainly already there (same SKU, a barcode already in use, or
 *            the same name when the file gives no SKU): never created.
 *   similar  probably already there under a slightly different name, or the
 *            same name under another SKU, or twice in the file: created only
 *            if the importer ticked "create anyway" for it.
 *
 * The same checks run for the preview and for the import itself — the server
 * never trusts that nothing changed in between.
 */

import { InvalidItemImport, nameIndex, parseItemRows, type ImportItem, type ImportProblem } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { postOpeningStockInTx } from './openingStock.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface LookAlike {
  name: string;
  sku: string | null;
  score: number;
  /** The row in this file it resembles; null when it is an item already in the master. */
  row: number | null;
}

export type CheckedItem = ImportItem & { status: 'new' | 'exists' | 'similar'; reason: string | null; similarTo: LookAlike[] };

export interface ImportCheck {
  items: CheckedItem[];
  problems: ImportProblem[];
  columns: { heading: string; field: string | null }[];
  newCategories: string[];
  summary: { rows: number; newItems: number; newPacks: number; existing: number; similar: number; problemRows: number; withStock: number };
}

export async function checkImport(db: Db | Tx, rows: Record<string, string>[], headings: string[]): Promise<ImportCheck> {
  const parsed = parseItemRows(rows, headings);
  const codes = parsed.items.flatMap((i) => i.packs.map((p) => p.barcode)).filter((c): c is string => c !== null);
  const cats = [...new Set(parsed.items.map((i) => i.category).filter((c): c is string => c !== null))];

  const [master, haveCode, haveCat] = await Promise.all([
    sql<{ id: string; sku: string; name: string }>`SELECT id, sku, name FROM product WHERE merged_into_id IS NULL`.execute(db),
    codes.length === 0 ? { rows: [] } : sql<{ code: string; name: string }>`SELECT b.code, p.name FROM barcode b JOIN product_pack pk ON pk.id = b.pack_id JOIN product p ON p.id = pk.product_id WHERE b.code = ANY(${codes}::text[])`.execute(db),
    cats.length === 0 ? { rows: [] } : sql<{ k: string }>`SELECT DISTINCT lower(name) AS k FROM product_category WHERE lower(name) = ANY(${cats.map((c) => c.toLowerCase())}::text[])`.execute(db),
  ]);
  const bySku = new Map(master.rows.map((r) => [r.sku.toLowerCase(), r]));
  const masterIx = nameIndex(master.rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku })));
  const codeMap = new Map(haveCode.rows.map((r) => [r.code, r.name]));
  const catSet = new Set(haveCat.rows.map((r) => r.k));
  // Items earlier in this same file, to catch the same item twice under two spellings.
  const fileIx = nameIndex<{ id: string; name: string; sku: string | null; row: number }>([]);

  const items: CheckedItem[] = parsed.items.map((it) => {
    const done = (status: CheckedItem['status'], reason: string | null, similarTo: LookAlike[] = []): CheckedItem => {
      if (status !== 'exists') fileIx.add({ id: it.key, name: it.name, sku: it.sku, row: it.rows[0]! });
      return { ...it, status, reason, similarTo };
    };
    const sameSku = it.sku === null ? undefined : bySku.get(it.sku.toLowerCase());
    if (sameSku !== undefined) return done('exists', `SKU ${it.sku} is already ${sameSku.name}`);
    const clash = it.packs.find((p) => p.barcode !== null && codeMap.has(p.barcode));
    if (clash !== undefined) return done('exists', `barcode ${clash.barcode} is already on ${codeMap.get(clash.barcode!)}`);
    const sameName = masterIx.same(it.name);
    if (sameName.length > 0) {
      const m = sameName[0]!;
      if (it.sku === null) return done('exists', `already in the item master as ${m.name} (SKU ${m.sku})`);
      return done('similar', `the same name as ${m.name} (SKU ${m.sku}), under another SKU`, [{ name: m.name, sku: m.sku, score: 1, row: null }]);
    }
    const inMaster = masterIx.alike(it.name).map((h) => ({ name: h.item.name, sku: h.item.sku, score: h.score, row: null }));
    const inFile = [
      ...fileIx.same(it.name).map((h) => ({ name: h.name, sku: h.sku, score: 1, row: h.row })),
      ...fileIx.alike(it.name).map((h) => ({ name: h.item.name, sku: h.item.sku, score: h.score, row: h.item.row })),
    ];
    const similarTo = [...inMaster, ...inFile].sort((a, b) => b.score - a.score).slice(0, 3);
    if (similarTo.length > 0) {
      const top = similarTo[0]!;
      return done('similar', top.row === null ? `looks like ${top.name}${top.sku === null ? '' : ` (SKU ${top.sku})`}` : `looks like ${top.name} on row ${top.row} of this file`, similarTo);
    }
    return done('new', null);
  });

  const creatable = items.filter((i) => i.status !== 'exists');
  const newCategories = [...new Map(creatable.map((i) => i.category).filter((c): c is string => c !== null && !catSet.has(c.toLowerCase())).map((c) => [c.toLowerCase(), c])).values()];
  const fresh = items.filter((i) => i.status === 'new');
  return {
    items,
    problems: parsed.problems,
    columns: parsed.columns,
    newCategories,
    summary: {
      rows: rows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== '')).length,
      newItems: fresh.length,
      newPacks: fresh.reduce((n, i) => n + i.packs.length, 0),
      existing: items.filter((i) => i.status === 'exists').length,
      similar: items.filter((i) => i.status === 'similar').length,
      problemRows: new Set(parsed.problems.filter((p) => p.row > 1).map((p) => p.row)).size,
      withStock: creatable.filter((i) => i.packs.some((p) => p.stock !== null)).length,
    },
  };
}

const CHUNK = 400;
function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

export interface ImportInput {
  id: string;
  fileName: string | null;
  rows: Record<string, string>[];
  headings: string[];
  actorId: string;
  mayPrice: boolean;
  /** Look-alike items (by key) the importer ticked "create anyway" for. */
  confirmSimilar: string[];
  /** Where the stock in the file is; null when the file's stock is to be left out. */
  stockBranchId: string | null;
}

export interface ImportReport {
  created: { name: string; sku: string; row: number; stock: number | null }[];
  existing: { name: string; row: number; reason: string }[];
  similarSkipped: { name: string; row: number; reason: string }[];
  problemRows: number;
}

export interface ImportResult {
  id: string;
  importNo: string;
  itemsCreated: number;
  packsCreated: number;
  categoriesCreated: number;
  rowsSkipped: number;
  similarSkipped: number;
  pricesSet: boolean;
  openingDocNo: string | null;
  replayed: boolean;
  /** Item by item, on the run that did the work (not on a replay). */
  report: ImportReport | null;
}

export async function runImport(db: Db, input: ImportInput): Promise<ImportResult> {
  const replay = async (dbx: Db): Promise<ImportResult | undefined> => {
    const r = await sql<Record<string, unknown>>`
      SELECT i.*, o.doc_no AS "openingDocNo" FROM item_import i LEFT JOIN opening_stock o ON o.id = i.opening_stock_id WHERE i.id = ${input.id}::uuid`.execute(dbx);
    const x = r.rows[0];
    if (x === undefined) return undefined;
    return {
      id: String(x['id']), importNo: String(x['import_no']), itemsCreated: Number(x['items_created']), packsCreated: Number(x['packs_created']),
      categoriesCreated: Number(x['categories_created']), rowsSkipped: Number(x['rows_skipped']), similarSkipped: Number(x['similar_skipped']),
      pricesSet: Boolean(x['prices_set']), openingDocNo: (x['openingDocNo'] as string | null) ?? null, replayed: true, report: null,
    };
  };
  const done = await replay(db);
  if (done !== undefined) return done;

  try {
    return await db.transaction().execute(async (tx) => {
      // One import at a time, so two people importing the same file cannot both create the same SKU.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('item-import', 0))`.execute(tx);
      const check = await checkImport(tx, input.rows, input.headings);
      const confirmed = new Set(input.confirmSimilar);
      const fresh = check.items.filter((i) => i.status === 'new' || (i.status === 'similar' && confirmed.has(i.key)));
      const similarSkipped = check.items.filter((i) => i.status === 'similar' && !confirmed.has(i.key));
      const stocked = fresh.filter((i) => i.packs.some((p) => p.stock !== null));
      if (stocked.length > 0 && input.stockBranchId === null) {
        throw new InvalidItemImport('The file gives stock on hand: choose the branch the stock is at, or import without the stock.');
      }
      const at = new Date();

      // Categories: existing ones by name (ignoring case), the rest created.
      const catIds = new Map<string, string>();
      let categoriesCreated = 0;
      const wanted = [...new Set(fresh.map((i) => i.category?.toLowerCase()).filter((c): c is string => c !== undefined))];
      if (wanted.length > 0) {
        const have = await sql<{ k: string; id: string }>`
          SELECT DISTINCT ON (lower(name)) lower(name) AS k, id FROM product_category WHERE lower(name) = ANY(${wanted}::text[]) ORDER BY lower(name), id`.execute(tx);
        for (const r of have.rows) catIds.set(r.k, r.id);
        for (const k of wanted) {
          if (catIds.has(k)) continue;
          categoriesCreated += 1;
          const name = fresh.find((i) => i.category?.toLowerCase() === k)!.category!;
          const c = await tx.insertInto('product_category').values({ name, parent_id: null }).returning('id').executeTakeFirstOrThrow();
          catIds.set(k, c.id);
        }
      }

      const counter = await sql<{ lastNo: number }>`
        INSERT INTO group_counter (doc_kind, last_no) VALUES ('ITM-IMP', 1)
        ON CONFLICT (doc_kind) DO UPDATE SET last_no = group_counter.last_no + 1
        RETURNING last_no AS "lastNo"`.execute(tx);
      const importNo = `ITM-IMP-${String(Number(counter.rows[0]?.lastNo ?? 1)).padStart(6, '0')}`;
      const pricesSet = input.mayPrice && fresh.some((i) => i.packs.some((p) => p.sellPrice !== null));
      const skippedRows = new Set([
        ...check.problems.filter((p) => p.row > 1).map((p) => p.row),
        ...check.items.filter((i) => i.status === 'exists').flatMap((i) => i.rows),
        ...similarSkipped.flatMap((i) => i.rows),
      ]).size;

      // The record is written once, complete: the opening stock document's id is chosen now and
      // the document posted further down; its reference is checked when the transaction commits.
      const openingId = stocked.length > 0 ? crypto.randomUUID() : null;
      await sql`
        INSERT INTO item_import (id, import_no, file_name, items_created, packs_created, categories_created, rows_skipped, prices_set,
                                 similar_skipped, opening_stock_id, created_by, created_at)
        VALUES (${input.id}::uuid, ${importNo}, ${input.fileName}, ${fresh.length}, ${fresh.reduce((n, i) => n + i.packs.length, 0)},
                ${categoriesCreated}, ${skippedRows}, ${pricesSet}, ${similarSkipped.length}, ${openingId}::uuid, ${input.actorId}::uuid, ${at})`.execute(tx);

      // SKUs for items that came without one: ITM-000001, … never clashing with an existing SKU.
      const needSku = fresh.filter((i) => i.sku === null).length;
      const skus: string[] = [];
      if (needSku > 0) {
        const r = await sql<{ lastNo: number }>`
          INSERT INTO group_counter (doc_kind, last_no) VALUES ('ITM', ${needSku})
          ON CONFLICT (doc_kind) DO UPDATE SET last_no = group_counter.last_no + ${needSku}
          RETURNING last_no AS "lastNo"`.execute(tx);
        const taken = new Set((await sql<{ sku: string }>`SELECT sku FROM product WHERE sku LIKE 'ITM-%'`.execute(tx)).rows.map((x) => x.sku));
        let n = Number(r.rows[0]!.lastNo) - needSku;
        while (skus.length < needSku) {
          n += 1;
          const candidate = `ITM-${String(n).padStart(6, '0')}`;
          if (!taken.has(candidate)) skus.push(candidate);
        }
      }
      let s = 0;
      const withSku = fresh.map((i) => ({ ...i, finalSku: i.sku ?? skus[s++]! }));
      const productIds = new Map<string, string>();
      const packIds = new Map<string, string>();

      for (const part of chunks(withSku)) {
        const products = await tx
          .insertInto('product')
          .values(
            part.map((i) => ({
              sku: i.finalSku, name: i.name, base_uom: i.baseUom, category_id: i.category === null ? null : (catIds.get(i.category.toLowerCase()) ?? null),
              is_weighed: i.isWeighed, merged_into_id: null, review_state: 'approved' as const, created_by: input.actorId, import_id: input.id,
            })),
          )
          .returning(['id', 'sku'])
          .execute();
        for (const p of products) productIds.set(p.sku, p.id);
        const packs = await tx
          .insertInto('product_pack')
          .values(
            part.flatMap((i) =>
              i.packs.map((p) => ({
                product_id: productIds.get(i.finalSku)!, label: p.label, qty_base: p.qtyBase, is_default_sell: p.isDefaultSell,
                is_default_buy: p.isDefaultBuy, sell_price: input.mayPrice ? p.sellPrice : null,
              })),
            ),
          )
          .returning(['id', 'product_id', 'label'])
          .execute();
        for (const p of packs) packIds.set(`${p.product_id}|${p.label}`, p.id);
        const barcodeRows = part.flatMap((i) =>
          i.packs.filter((p) => p.barcode !== null).map((p) => ({ code: p.barcode!, pack_id: packIds.get(`${productIds.get(i.finalSku)}|${p.label}`)!, symbology: p.symbology })),
        );
        if (barcodeRows.length > 0) await tx.insertInto('barcode').values(barcodeRows).execute();
        await tx
          .insertInto('audit_log')
          .values(
            part.map((i) => ({
              event_id: crypto.randomUUID(), action_code: 'PRODUCT_CREATED', actor_id: input.actorId, terminal_id: null, branch_id: null,
              entity_type: 'product', entity_id: productIds.get(i.finalSku)!, state_before: null,
              state_after: JSON.stringify({
                sku: i.finalSku, name: i.name, packs: i.packs.length, importNo,
                ...(i.status === 'similar' ? { createdAlthough: i.reason } : {}),
              }),
              occurred_at: at,
            })),
          )
          .execute();
      }

      // The stock in the file becomes an ordinary opening stock document at the chosen branch.
      let openingDocNo: string | null = null;
      if (openingId !== null && input.stockBranchId !== null) {
        const lines = withSku
          .filter((i) => i.packs.some((p) => p.stock !== null))
          .map((i) => {
            const p = i.packs.find((x) => x.stock !== null)!;
            const productId = productIds.get(i.finalSku)!;
            return { productId, packId: packIds.get(`${productId}|${p.label}`)!, qtyPacks: p.stock!, unitCost: p.cost };
          });
        const doc = await postOpeningStockInTx(tx, { id: openingId, branchId: input.stockBranchId, enteredBy: input.actorId, note: `Brought in with item import ${importNo}`, lines });
        openingDocNo = doc.docNo;
      }

      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(), action_code: 'ITEMS_IMPORTED', actor_id: input.actorId, terminal_id: null, branch_id: input.stockBranchId,
          entity_type: 'item_import', entity_id: input.id, state_before: null,
          state_after: JSON.stringify({
            importNo, file: input.fileName, items: fresh.length, lookAlikesCreated: fresh.filter((i) => i.status === 'similar').length,
            lookAlikesLeftOut: similarSkipped.length, skippedRows, pricesSet, openingStock: openingDocNo,
          }),
          occurred_at: at,
        })
        .execute();

      return {
        id: input.id, importNo, itemsCreated: fresh.length, packsCreated: fresh.reduce((n, i) => n + i.packs.length, 0),
        categoriesCreated, rowsSkipped: skippedRows, similarSkipped: similarSkipped.length, pricesSet, openingDocNo, replayed: false,
        report: {
          created: withSku.map((i) => ({ name: i.name, sku: i.finalSku, row: i.rows[0]!, stock: i.packs.find((p) => p.stock !== null)?.stock ?? null })),
          existing: check.items.filter((i) => i.status === 'exists').map((i) => ({ name: i.name, row: i.rows[0]!, reason: i.reason ?? '' })),
          similarSkipped: similarSkipped.map((i) => ({ name: i.name, row: i.rows[0]!, reason: i.reason ?? '' })),
          problemRows: check.summary.problemRows,
        },
      };
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'item_import_pkey') return (await replay(db))!;
    throw error;
  }
}
