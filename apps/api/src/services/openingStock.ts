/**
 * Opening stock: bring stock onto the books at a branch, as one numbered document.
 *
 * Every line is one 'opening_balance' movement on the stock ledger; the
 * document, its lines, the movements, an audit entry and a work item in the
 * exception queue commit together or not at all. It is idempotent on the id
 * the client made, so a retried save is the same document, not a second one.
 *
 * Only an item with nothing on hand at the branch may be opened. That is
 * checked under the same per-position lock the ledger takes to post, so two
 * people cannot both open the same item at once.
 */

import {
  checkOpeningLines,
  costLineCents,
  costPerBaseUnit,
  fromCents,
  InvalidOpeningStock,
  OpeningStockNotEmpty,
} from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { branchNumber } from './purchasing.js';
import { postMovementInTx } from './stock.js';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface OpeningStockInput {
  id: string;
  branchId: string;
  enteredBy: string;
  note?: string | null;
  lines: { productId: string; packId: string; qtyPacks: number; unitCost: number | null }[];
}

export interface OpeningStockResult {
  id: string;
  docNo: string;
  totalCost: number;
  lines: number;
  linesWithoutCost: number;
  replayed: boolean;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

async function existing(db: Db | Tx, id: string): Promise<OpeningStockResult | undefined> {
  const r = await sql<{ docNo: string; total: number; lines: number; noCost: number }>`
    SELECT o.doc_no AS "docNo", o.total_cost AS total,
           (SELECT count(*)::int FROM opening_stock_line l WHERE l.doc_id = o.id) AS lines,
           (SELECT count(*)::int FROM opening_stock_line l WHERE l.doc_id = o.id AND l.unit_cost IS NULL) AS "noCost"
    FROM opening_stock o WHERE o.id = ${id}::uuid`.execute(db);
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return { id, docNo: row.docNo, totalCost: Number(row.total), lines: Number(row.lines), linesWithoutCost: Number(row.noCost), replayed: true };
}

export async function postOpeningStock(db: Db, input: OpeningStockInput): Promise<OpeningStockResult> {
  const before = await existing(db, input.id);
  if (before !== undefined) return before;
  try {
    return await db.transaction().execute((tx) => run(tx, input));
  } catch (error) {
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'opening_stock_pkey') {
      return (await existing(db, input.id))!;
    }
    throw error;
  }
}

async function run(tx: Tx, input: OpeningStockInput): Promise<OpeningStockResult> {
  checkOpeningLines(input.lines);

  const branch = await tx.selectFrom('branch').select(['id', 'code', 'name', 'is_active']).where('id', '=', input.branchId).executeTakeFirst();
  if (branch === undefined || !branch.is_active) throw new InvalidOpeningStock('That branch is not available.');

  const packs = await tx
    .selectFrom('product_pack')
    .innerJoin('product', 'product.id', 'product_pack.product_id')
    .select(['product_pack.id as packId', 'product_pack.product_id as productId', 'product_pack.qty_base as qtyBase', 'product.name as name', 'product.merged_into_id as merged'])
    .where('product_pack.id', 'in', [...new Set(input.lines.map((l) => l.packId))])
    .execute();
  const packById = new Map(packs.map((p) => [p.packId, p]));
  for (const l of input.lines) {
    const p = packById.get(l.packId);
    if (p === undefined || p.productId !== l.productId) throw new InvalidOpeningStock('An item is not a known product and pack.');
    if (p.merged !== null) throw new InvalidOpeningStock(`${p.name} was merged into another product; open the product it was merged into.`);
  }

  // Lock every position first, in a fixed order, then check they are all empty.
  const ordered = input.lines.map((l, index) => ({ l, index, pack: packById.get(l.packId)! })).sort((a, b) => a.l.productId.localeCompare(b.l.productId));
  for (const w of ordered) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${w.l.productId + input.branchId}, 0))`.execute(tx);
  }
  const held = await sql<{ productId: string; onHand: number }>`
    SELECT product_id AS "productId", qty_base AS "onHand" FROM stock_on_hand
    WHERE branch_id = ${input.branchId}::uuid AND qty_base <> 0
      AND product_id IN (${sql.join(input.lines.map((l) => l.productId))})`.execute(tx);
  if (held.rows.length > 0) {
    const name = new Map(ordered.map((w) => [w.l.productId, w.pack.name]));
    throw new OpeningStockNotEmpty(held.rows.map((h) => ({ productId: h.productId, name: name.get(h.productId) ?? h.productId, onHand: Number(h.onHand) })));
  }

  const at = new Date();
  const seqByIndex = new Map<number, number>();
  const priced = new Map<number, { qtyBase: number; cents: number | null }>();
  for (const w of ordered) {
    const qtyBase = round4(w.l.qtyPacks * Number(w.pack.qtyBase));
    const cents = w.l.unitCost === null ? null : costLineCents(w.l.qtyPacks, w.l.unitCost);
    priced.set(w.index, { qtyBase, cents });
    const posted = await postMovementInTx(tx, {
      productId: w.l.productId,
      branchId: input.branchId,
      qtyBase,
      reason: 'opening_balance',
      actorId: input.enteredBy,
      unitCost: w.l.unitCost === null ? null : costPerBaseUnit(w.l.unitCost, Number(w.pack.qtyBase)),
      docType: 'OPENING',
      docId: input.id,
      occurredAt: at,
    });
    seqByIndex.set(w.index, posted.seq);
  }

  const totalCents = [...priced.values()].reduce((s, p) => s + (p.cents ?? 0), 0);
  const noCost = input.lines.filter((l) => l.unitCost === null).length;
  const docNo = await branchNumber(tx, input.branchId, 'OPN', branch.code);

  await tx
    .insertInto('opening_stock')
    .values({ id: input.id, doc_no: docNo, branch_id: input.branchId, entered_by: input.enteredBy, entered_at: at, note: input.note ?? null, total_cost: fromCents(totalCents) })
    .execute();
  await tx
    .insertInto('opening_stock_line')
    .values(
      input.lines.map((l, i) => {
        const p = priced.get(i)!;
        return {
          doc_id: input.id,
          line_no: i + 1,
          product_id: l.productId,
          pack_id: l.packId,
          qty_packs: l.qtyPacks,
          qty_base: p.qtyBase,
          unit_cost: l.unitCost,
          line_total: p.cents === null ? null : fromCents(p.cents),
          movement_seq: seqByIndex.get(i) ?? 0,
        };
      }),
    )
    .execute();

  const units = round4([...priced.values()].reduce((s, p) => s + p.qtyBase, 0));
  await tx
    .insertInto('exception_event')
    .values({
      event_id: crypto.randomUUID(),
      kind: 'opening_stock',
      branch_id: input.branchId,
      terminal_id: null,
      actor_id: input.enteredBy,
      product_id: null,
      detail: JSON.stringify({ docId: input.id, docNo, lines: input.lines.length, units, linesWithoutCost: noCost, note: input.note ?? null, branch: `${branch.code} ${branch.name}` }),
      value_impact: fromCents(totalCents),
      currency: 'USD',
      occurred_at: at,
    })
    .execute();
  await tx
    .insertInto('audit_log')
    .values({
      event_id: crypto.randomUUID(),
      action_code: 'OPENING_STOCK_POSTED',
      actor_id: input.enteredBy,
      terminal_id: null,
      branch_id: input.branchId,
      entity_type: 'opening_stock',
      entity_id: input.id,
      state_before: null,
      state_after: JSON.stringify({ docNo, lines: input.lines.length, units, total: fromCents(totalCents), linesWithoutCost: noCost }),
      occurred_at: at,
    })
    .execute();

  return { id: input.id, docNo, totalCost: fromCents(totalCents), lines: input.lines.length, linesWithoutCost: noCost, replayed: false };
}
