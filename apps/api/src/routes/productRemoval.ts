/**
 * Removing items: one, many, or all of them.
 *
 * An item that was never used - no sale, delivery, order, count, transfer,
 * opening stock, return, price list or exception - is a typo or a test, and
 * is DELETED for good (a full snapshot stays in the audit log).
 *
 * An item with history is woven into sales, stock and the audit trail, which
 * this system promises never to lose. It is ARCHIVED instead: hidden from the
 * till, the item master and searches, refused at checkout, and restorable -
 * while every past receipt, stock figure and report stays exactly as it was.
 *
 * The preview says which is which before anything happens, and the removal
 * must be confirmed with the number of items. Ten or more at once is raised
 * as an exception for a second person to review.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';

import type { Database } from '@retail-ops/db';

import { parseBody, parseParams } from '../validation.js';

type Db = Kysely<Database> | Transaction<Database>;

const ids = z.array(z.uuid()).min(1, 'Choose at least one item.').max(5000, 'At most 5,000 items at a time.');
const previewBody = z.object({ ids });
const removeBody = z.object({
  ids,
  /** The number of items, typed by the person: a deliberate second step. */
  confirmCount: z.number().int(),
  note: z.string().trim().max(500).optional(),
});
const idParams = z.object({ id: z.uuid() });

/** Ten or more items removed at once is reviewed by someone else. */
export const REVIEW_AT = 10;

interface Usage {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
  sales: number;
  deliveries: number;
  movements: number;
  other: number;
  onHand: number;
}

const used = (u: Usage) => u.sales + u.deliveries + u.movements + u.other > 0;

function reasonOf(u: Usage): string {
  const parts: string[] = [];
  if (u.sales > 0) parts.push(`sold on ${u.sales} receipt line${u.sales === 1 ? '' : 's'}`);
  if (u.deliveries > 0) parts.push(`in ${u.deliveries} deliver${u.deliveries === 1 ? 'y' : 'ies'}`);
  if (u.movements > 0 && u.sales === 0 && u.deliveries === 0) parts.push(`${u.movements} stock movement${u.movements === 1 ? '' : 's'}`);
  if (u.other > 0 && parts.length === 0) parts.push('on orders, transfers, price lists or exceptions');
  return parts.join(', ');
}

async function usage(db: Db, productIds: string[], lock = false): Promise<Usage[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT p.id, p.sku, p.name, p.is_active,
      (SELECT count(*) FROM sale_line x WHERE x.product_id = p.id)::int AS sales,
      (SELECT count(*) FROM goods_received_line x WHERE x.product_id = p.id)::int AS deliveries,
      (SELECT count(*) FROM stock_movement x WHERE x.product_id = p.id)::int AS movements,
      ((SELECT count(*) FROM purchase_order_line x WHERE x.product_id = p.id)
       + (SELECT count(*) FROM purchase_return_line x WHERE x.product_id = p.id)
       + (SELECT count(*) FROM transfer_line x WHERE x.product_id = p.id)
       + (SELECT count(*) FROM opening_stock_line x WHERE x.product_id = p.id)
       + (SELECT count(*) FROM exception_event x WHERE x.product_id = p.id)
       + (SELECT count(*) FROM product x WHERE x.merged_into_id = p.id)
       + (SELECT count(*) FROM supplier_price_list_line x JOIN product_pack pk ON pk.id = x.pack_id WHERE pk.product_id = p.id))::int AS other,
      coalesce((SELECT sum(s.qty_base) FROM stock_on_hand s WHERE s.product_id = p.id), 0) AS on_hand
    FROM product p
    WHERE p.id = ANY(${productIds}::uuid[])
    ORDER BY p.name
    ${lock ? sql`FOR UPDATE OF p` : sql``}`.execute(db);
  return rows.rows.map((r) => ({
    id: String(r['id']),
    sku: String(r['sku']),
    name: String(r['name']),
    isActive: r['is_active'] === true,
    sales: Number(r['sales']),
    deliveries: Number(r['deliveries']),
    movements: Number(r['movements']),
    other: Number(r['other']),
    onHand: Number(r['on_hand']),
  }));
}

export async function registerProductRemovalRoutes(app: FastifyInstance): Promise<void> {
  /** What would happen to each item: deleted (never used) or archived (has history). Changes nothing. */
  app.post('/products/removal/preview', { onRequest: [app.requirePermission('product.write')] }, async (request) => {
    const body = parseBody(previewBody, request.body);
    const list = await usage(app.db, [...new Set(body.ids)]);
    const items = list.map((u) => ({
      id: u.id,
      sku: u.sku,
      name: u.name,
      action: used(u) ? (u.isActive ? ('archive' as const) : ('already-archived' as const)) : ('delete' as const),
      reason: used(u) ? reasonOf(u) : 'never used',
      onHand: u.onHand,
    }));
    return {
      items,
      toDelete: items.filter((i) => i.action === 'delete').length,
      toArchive: items.filter((i) => i.action === 'archive').length,
      alreadyArchived: items.filter((i) => i.action === 'already-archived').length,
      withStock: items.filter((i) => i.action === 'archive' && i.onHand !== 0).length,
      reviewAt: REVIEW_AT,
    };
  });

  /** Delete the never-used items and archive the rest, in one step. */
  app.post('/products/removal', { onRequest: [app.requirePermission('product.write')] }, async (request, reply) => {
    const body = parseBody(removeBody, request.body);
    const wanted = [...new Set(body.ids)];
    if (body.confirmCount !== wanted.length) {
      return reply.status(422).send({ error: { code: 'CONFIRM_COUNT', message: `Type ${wanted.length} to confirm: the number of items chosen.` } });
    }
    const actor = request.user!.personId;

    return app.db.transaction().execute(async (tx) => {
      // Locked and re-checked inside the transaction: an item sold a moment ago is archived, never deleted.
      const list = await usage(tx, wanted, true);
      const toDelete = list.filter((u) => !used(u));
      const toArchive = list.filter((u) => used(u) && u.isActive);
      const now = new Date();

      for (const u of toDelete) {
        const snapshot = await sql<Record<string, unknown>>`
          SELECT p.sku, p.name, p.base_uom, p.category_id, p.is_weighed, p.review_state,
                 (SELECT json_agg(json_build_object('label', pk.label, 'qtyBase', pk.qty_base, 'sellPrice', pk.sell_price,
                         'barcodes', (SELECT json_agg(b.code) FROM barcode b WHERE b.pack_id = pk.id)))
                    FROM product_pack pk WHERE pk.product_id = p.id) AS packs
          FROM product p WHERE p.id = ${u.id}::uuid`.execute(tx);
        await sql`DELETE FROM barcode WHERE pack_id IN (SELECT id FROM product_pack WHERE product_id = ${u.id}::uuid)`.execute(tx);
        await sql`DELETE FROM supplier_item WHERE pack_id IN (SELECT id FROM product_pack WHERE product_id = ${u.id}::uuid)`.execute(tx);
        await sql`DELETE FROM product_pack WHERE product_id = ${u.id}::uuid`.execute(tx);
        await sql`DELETE FROM product WHERE id = ${u.id}::uuid`.execute(tx);
        await tx
          .insertInto('audit_log')
          .values({
            event_id: crypto.randomUUID(), action_code: 'PRODUCT_DELETED', actor_id: actor, terminal_id: null, branch_id: null,
            entity_type: 'product', entity_id: u.id,
            state_before: JSON.stringify(snapshot.rows[0] ?? { sku: u.sku, name: u.name }),
            state_after: JSON.stringify({ deleted: true, why: 'never used', note: body.note ?? null }),
            occurred_at: now,
          })
          .execute();
      }

      if (toArchive.length > 0) {
        await tx.updateTable('product').set({ is_active: false }).where('id', 'in', toArchive.map((u) => u.id)).execute();
        await tx
          .insertInto('audit_log')
          .values(
            toArchive.map((u) => ({
              event_id: crypto.randomUUID(), action_code: 'PRODUCT_ARCHIVED', actor_id: actor, terminal_id: null, branch_id: null,
              entity_type: 'product', entity_id: u.id,
              state_before: JSON.stringify({ isActive: true, sku: u.sku, name: u.name }),
              state_after: JSON.stringify({ isActive: false, why: reasonOf(u), onHand: u.onHand, note: body.note ?? null }),
              occurred_at: now,
            })),
          )
          .execute();
      }

      const removed = toDelete.length + toArchive.length;
      if (removed >= REVIEW_AT) {
        // Group-wide master data: raised at the head-office branch (a warehouse if there is one).
        const branch = await tx.selectFrom('branch').select('id').where('is_active', '=', true).orderBy('kind', 'desc').orderBy('code').executeTakeFirstOrThrow();
        await tx
          .insertInto('exception_event')
          .values({
            event_id: crypto.randomUUID(),
            kind: 'items_removed',
            branch_id: branch.id,
            actor_id: actor,
            product_id: null,
            value_impact: null,
            detail: JSON.stringify({
              deleted: toDelete.length,
              archived: toArchive.length,
              withStock: toArchive.filter((u) => u.onHand !== 0).length,
              examples: [...toDelete, ...toArchive].slice(0, 10).map((u) => `${u.name} (${u.sku})`),
              note: body.note ?? null,
            }),
            occurred_at: now,
          })
          .execute();
      }
      return {
        deleted: toDelete.map((u) => ({ id: u.id, sku: u.sku, name: u.name })),
        archived: toArchive.map((u) => ({ id: u.id, sku: u.sku, name: u.name, onHand: u.onHand })),
        reviewRaised: removed >= REVIEW_AT,
      };
    });
  });

  /** Bring an archived item back: it can be sold and found again. */
  app.post('/products/:id/restore', { onRequest: [app.requirePermission('product.write')] }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const row = await app.db.updateTable('product').set({ is_active: true }).where('id', '=', id).where('is_active', '=', false).returning(['id', 'sku', 'name']).executeTakeFirst();
    if (row === undefined) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No archived item with that id.' } });
    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(), action_code: 'PRODUCT_RESTORED', actor_id: request.user!.personId, terminal_id: null, branch_id: null,
        entity_type: 'product', entity_id: id,
        state_before: JSON.stringify({ isActive: false }),
        state_after: JSON.stringify({ isActive: true, sku: row.sku, name: row.name }),
        occurred_at: new Date(),
      })
      .execute();
    return { ok: true };
  });
}
