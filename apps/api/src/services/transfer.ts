/**
 * Branch-to-branch transfers.
 *
 * Same discipline as stock.ts: this file holds no rules of its own beyond
 * the workflow sequencing (dispatch, then receive, then optionally cancel).
 * Stock availability, cost derivation and variance valuation all delegate to
 * the same domain policy functions every other write path uses (AD-6).
 *
 * The model, in one line: two real ledger movements against two real
 * branches, separated by a workflow state, never a pseudo-branch standing in
 * for "on a truck". See migration 004 for the full reasoning.
 */

import { computeCountVariance, DomainError } from '@retail-ops/domain';
import type { Database, TransferState } from '@retail-ops/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { onHand, postMovementInTx, wac } from './stock.js';

type Db = Kysely<Database>;

async function nextReference(db: Db): Promise<string> {
  // nextval() returns bigint (Postgres OID 20). pool.ts installs a global
  // type parser converting that OID to a JS number for every query, this one
  // included - so despite looking like a string column, `n` arrives as a
  // number at runtime, not the string this query's shape might suggest.
  const row = await sql<{ n: number }>`SELECT nextval('transfer_reference_seq') as n`.execute(db);
  const n = row.rows[0]?.n ?? 0;
  return `TR-${String(n).padStart(6, '0')}`;
}

export interface DispatchLineInput {
  productId: string;
  qtyDispatched: number;
}

export interface DispatchTransferInput {
  originBranchId: string;
  destinationBranchId: string;
  actorId: string;
  notes?: string | null | undefined;
  occurredAt?: Date | undefined;
  lines: DispatchLineInput[];
}

export interface TransferLineView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  qtyDispatched: number;
  qtyReceived: number | null;
  unitCost: number | null;
  variance: number | null;
  valueImpact: number | null;
}

export interface TransferView {
  id: string;
  reference: string;
  state: TransferState;
  originBranchId: string;
  originBranchCode: string;
  destinationBranchId: string;
  destinationBranchCode: string;
  dispatchedBy: string;
  dispatchedByName: string | null;
  dispatchedAt: Date;
  receivedBy: string | null;
  receivedByName: string | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  notes: string | null;
  lines: TransferLineView[];
}

/**
 * Dispatch stock to another branch.
 *
 * Each line posts a transfer_out movement at the origin, in base units,
 * through postMovementInTx - so the same negative-stock guard that blocks an
 * overselling till also blocks dispatching more than is actually on the
 * shelf. Cost is not asked for: it is read from the origin's own current
 * WAC, because moving stock to another branch does not change what it is
 * worth.
 */
export async function dispatchTransfer(
  db: Db,
  input: DispatchTransferInput,
): Promise<{ id: string; reference: string }> {
  if (input.lines.length === 0) {
    throw new DomainError('INVALID_MOVEMENT', 'A transfer needs at least one line.', {});
  }

  return db.transaction().execute(async (tx) => {
    const reference = await nextReference(tx);
    const occurredAt = input.occurredAt ?? new Date();

    const transfer = await tx
      .insertInto('transfer')
      .values({
        reference,
        origin_branch_id: input.originBranchId,
        destination_branch_id: input.destinationBranchId,
        state: 'dispatched',
        dispatched_by: input.actorId,
        dispatched_at: occurredAt,
        notes: input.notes ?? null,
      })
      .returning(['id', 'reference'])
      .executeTakeFirstOrThrow();

    for (const line of input.lines) {
      const unitCost = await wac(tx, line.productId, input.originBranchId);

      // Delegates to the shared movement path, so the negative-stock policy
      // and idempotency are the same code every other write goes through -
      // not a second copy of the rule.
      const posted = await postMovementInTx(tx, {
        productId: line.productId,
        branchId: input.originBranchId,
        qtyBase: -Math.abs(line.qtyDispatched),
        reason: 'transfer_out',
        actorId: input.actorId,
        unitCost,
        docType: 'TRANSFER',
        docId: transfer.id,
        occurredAt,
      });

      await tx
        .insertInto('transfer_line')
        .values({
          transfer_id: transfer.id,
          product_id: line.productId,
          qty_dispatched: line.qtyDispatched,
          unit_cost: unitCost,
          dispatch_movement_seq: posted.seq,
        })
        .execute();
    }

    return transfer;
  });
}

export interface ReceiveLineInput {
  productId: string;
  /** What was actually counted arriving. May be less, or more, than dispatched. */
  qtyReceived: number;
}

/**
 * Confirm receipt of a transfer.
 *
 * The destination is credited for exactly what arrived - never for what was
 * dispatched. A shortfall or an overage both raise a `transit_loss`
 * exception, costed with computeCountVariance (the identical rule a stock
 * count uses to value its own variance): this is the same kind of fact,
 * arrived at a different way.
 */
export async function receiveTransfer(
  db: Db,
  transferId: string,
  input: { actorId: string; lines: ReceiveLineInput[]; occurredAt?: Date | undefined },
): Promise<TransferView> {
  return db.transaction().execute(async (tx) => {
    const transfer = await tx
      .selectFrom('transfer')
      .selectAll()
      .where('id', '=', transferId)
      .executeTakeFirst();

    if (transfer === undefined) {
      throw new DomainError('TRANSFER_NOT_FOUND', `No transfer ${transferId}`, { transferId });
    }
    if (transfer.state !== 'dispatched') {
      throw new DomainError(
        'TRANSFER_NOT_OPEN',
        `Transfer ${transfer.reference} is already ${transfer.state}, not open to receive.`,
        { transferId, state: transfer.state },
      );
    }

    const lines = await tx
      .selectFrom('transfer_line')
      .selectAll()
      .where('transfer_id', '=', transferId)
      .execute();

    const byProduct = new Map(lines.map((l) => [l.product_id, l]));
    const occurredAt = input.occurredAt ?? new Date();

    for (const received of input.lines) {
      const line = byProduct.get(received.productId);
      if (line === undefined) {
        throw new DomainError(
          'INVALID_MASTER_DATA',
          `Product ${received.productId} is not on transfer ${transfer.reference}.`,
          { transferId, productId: received.productId },
        );
      }
      if (line.qty_received !== null) continue; // already receipted; replay-safe

      const posted = await postMovementInTx(tx, {
        productId: received.productId,
        branchId: transfer.destination_branch_id,
        qtyBase: Math.abs(received.qtyReceived),
        reason: 'transfer_in',
        actorId: input.actorId,
        unitCost: line.unit_cost,
        docType: 'TRANSFER',
        docId: transfer.id,
        occurredAt,
      });

      await tx
        .updateTable('transfer_line')
        .set({ qty_received: received.qtyReceived, receipt_movement_seq: posted.seq })
        .where('id', '=', line.id)
        .execute();

      // The variance rule a count uses, applied to the same kind of fact
      // arrived at differently: what should be here vs what is.
      const assessment = computeCountVariance(
        Number(line.qty_dispatched),
        received.qtyReceived,
        line.unit_cost,
      );

      if (assessment.variance !== 0) {
        await tx
          .insertInto('exception_event')
          .values({
            event_id: crypto.randomUUID(),
            kind: 'transit_loss',
            branch_id: transfer.destination_branch_id,
            terminal_id: null,
            actor_id: input.actorId,
            product_id: received.productId,
            detail: JSON.stringify({
              transferId: transfer.id,
              transferReference: transfer.reference,
              originBranchId: transfer.origin_branch_id,
              dispatched: Number(line.qty_dispatched),
              received: received.qtyReceived,
              variance: assessment.variance,
            }),
            value_impact: assessment.valueImpact,
            currency: assessment.valueImpact === null ? null : 'USD',
            occurred_at: occurredAt,
          })
          .execute();
      }
    }

    const remaining = await tx
      .selectFrom('transfer_line')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('transfer_id', '=', transferId)
      .where('qty_received', 'is', null)
      .executeTakeFirst();

    if ((remaining?.n ?? 0) === 0) {
      await tx
        .updateTable('transfer')
        .set({ state: 'received', received_by: input.actorId, received_at: occurredAt })
        .where('id', '=', transferId)
        .execute();
    }

    const view = await getTransfer(tx, transferId);
    if (view === undefined) {
      // Cannot happen: this row was read or written moments ago in the same
      // transaction. Fails loudly rather than returning something wrong.
      throw new DomainError('TRANSFER_NOT_FOUND', `No transfer ${transferId}`, { transferId });
    }
    return view;
  });
}

/**
 * Cancel a transfer that has not been received yet.
 *
 * Reverses each dispatch movement with a new, compensating one rather than
 * touching the original row - the ledger is append-only, corrections are
 * always additive, never a rewrite (R2).
 */
export async function cancelTransfer(
  db: Db,
  transferId: string,
  input: { actorId: string; reason?: string | undefined },
): Promise<TransferView> {
  return db.transaction().execute(async (tx) => {
    const transfer = await tx
      .selectFrom('transfer')
      .selectAll()
      .where('id', '=', transferId)
      .executeTakeFirst();

    if (transfer === undefined) {
      throw new DomainError('TRANSFER_NOT_FOUND', `No transfer ${transferId}`, { transferId });
    }
    if (transfer.state !== 'dispatched') {
      throw new DomainError(
        'TRANSFER_NOT_OPEN',
        `Transfer ${transfer.reference} is ${transfer.state} and cannot be cancelled.`,
        { transferId, state: transfer.state },
      );
    }

    const lines = await tx
      .selectFrom('transfer_line')
      .selectAll()
      .where('transfer_id', '=', transferId)
      .execute();

    for (const line of lines) {
      if (line.dispatch_movement_seq === null) continue;
      await postMovementInTx(tx, {
        productId: line.product_id,
        branchId: transfer.origin_branch_id,
        qtyBase: Math.abs(Number(line.qty_dispatched)),
        reason: 'transfer_out',
        actorId: input.actorId,
        unitCost: line.unit_cost,
        docType: 'TRANSFER_CANCEL',
        docId: transfer.id,
      });
    }

    await tx
      .updateTable('transfer')
      .set({
        state: 'cancelled',
        cancelled_by: input.actorId,
        cancelled_at: new Date(),
        notes: input.reason ?? transfer.notes,
      })
      .where('id', '=', transferId)
      .execute();

    const view = await getTransfer(tx, transferId);
    if (view === undefined) {
      // Cannot happen: this row was read or written moments ago in the same
      // transaction. Fails loudly rather than returning something wrong.
      throw new DomainError('TRANSFER_NOT_FOUND', `No transfer ${transferId}`, { transferId });
    }
    return view;
  });
}

export async function getTransfer(db: Db, transferId: string): Promise<TransferView | undefined> {
  const transfer = await db
    .selectFrom('transfer')
    .innerJoin('branch as origin', 'origin.id', 'transfer.origin_branch_id')
    .innerJoin('branch as destination', 'destination.id', 'transfer.destination_branch_id')
    .leftJoin('person as dispatcher', 'dispatcher.id', 'transfer.dispatched_by')
    .leftJoin('person as receiver', 'receiver.id', 'transfer.received_by')
    .select([
      'transfer.id',
      'transfer.reference',
      'transfer.state',
      'transfer.origin_branch_id as originBranchId',
      'origin.code as originBranchCode',
      'transfer.destination_branch_id as destinationBranchId',
      'destination.code as destinationBranchCode',
      'transfer.dispatched_by as dispatchedBy',
      'dispatcher.full_name as dispatchedByName',
      'transfer.dispatched_at as dispatchedAt',
      'transfer.received_by as receivedBy',
      'receiver.full_name as receivedByName',
      'transfer.received_at as receivedAt',
      'transfer.cancelled_at as cancelledAt',
      'transfer.notes',
    ])
    .where('transfer.id', '=', transferId)
    .executeTakeFirst();

  if (transfer === undefined) return undefined;

  const lineRows = await db
    .selectFrom('transfer_line')
    .innerJoin('product', 'product.id', 'transfer_line.product_id')
    .select([
      'transfer_line.id',
      'transfer_line.product_id as productId',
      'product.name as productName',
      'product.sku',
      'transfer_line.qty_dispatched as qtyDispatched',
      'transfer_line.qty_received as qtyReceived',
      'transfer_line.unit_cost as unitCost',
    ])
    .where('transfer_line.transfer_id', '=', transferId)
    .execute();

  const lines: TransferLineView[] = lineRows.map((l) => {
    const variance = l.qtyReceived === null ? null : l.qtyReceived - Number(l.qtyDispatched);
    const valueImpact = variance === null || l.unitCost === null ? null : Number((variance * l.unitCost).toFixed(2));
    return { ...l, variance, valueImpact };
  });

  return { ...transfer, lines };
}

export async function listTransfers(
  db: Db,
  filter: { branchId?: string | undefined; state?: TransferState | undefined } = {},
): Promise<
  {
    id: string;
    reference: string;
    state: TransferState;
    originBranchCode: string;
    destinationBranchCode: string;
    dispatchedAt: Date;
    lineCount: number;
  }[]
> {
  let query = db
    .selectFrom('transfer')
    .innerJoin('branch as origin', 'origin.id', 'transfer.origin_branch_id')
    .innerJoin('branch as destination', 'destination.id', 'transfer.destination_branch_id')
    .select([
      'transfer.id',
      'transfer.reference',
      'transfer.state',
      'origin.code as originBranchCode',
      'destination.code as destinationBranchCode',
      'transfer.dispatched_at as dispatchedAt',
      (eb) =>
        eb
          .selectFrom('transfer_line')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .whereRef('transfer_line.transfer_id', '=', 'transfer.id')
          .as('lineCount'),
    ]);

  if (filter.branchId !== undefined) {
    query = query.where((eb) =>
      eb.or([
        eb('transfer.origin_branch_id', '=', filter.branchId as string),
        eb('transfer.destination_branch_id', '=', filter.branchId as string),
      ]),
    );
  }
  if (filter.state !== undefined) query = query.where('transfer.state', '=', filter.state);

  const rows = await query.orderBy('transfer.dispatched_at', 'desc').limit(200).execute();
  // A correlated subquery selected as a column is nullable at the type
  // level even though COUNT(*) itself never returns null; coerce it here
  // rather than widen the return type for something that cannot happen.
  return rows.map((r) => ({ ...r, lineCount: r.lineCount ?? 0 }));
}

/** Stock on hand at the origin, for the dispatch screen to show before submit. */
export { onHand };
