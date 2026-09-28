/**
 * Start a branch fresh: set every product's stock there to zero.
 *
 * Nothing is deleted. Stock is a ledger, so "zero" is one offsetting movement
 * per position, dated now, reason 'stock_reset'; every earlier movement stays
 * exactly as it was. What cannot be done is undoing it - the old quantities
 * only come back by being entered again - which is why this is the most
 * guarded write in the system.
 *
 * How it stays correct while tills are still selling:
 *   1. It takes the same per-product advisory lock a sale takes, on every
 *      position at the branch, BEFORE reading anything. A sale in flight
 *      finishes first; one that arrives after waits.
 *   2. It reads the positions only after those locks are held, so what it
 *      zeroes is what is there at that instant, not what was there a moment
 *      ago.
 *   3. It compares that against what the manager was shown and refuses on any
 *      difference (StockResetStale) - "I approved that" has to mean the
 *      numbers on the screen.
 *   4. It writes every offsetting movement in a single statement, then proves
 *      the branch really is at zero before committing. If it is not, the
 *      whole thing rolls back.
 */

import { StockResetStale } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface ResetPreview {
  /** Positions that will be set to zero: non-zero, and not on a merged product. */
  resettable: number;
  /** Units sitting on the shelf across positive positions. */
  unitsOnHand: number;
  /** Units the ledger says are impossible (negative positions), as a positive count. */
  unitsBelowZero: number;
  /** Net stock value at weighted-average cost. */
  valueAtCost: number;
  /** Positive positions with no costed receipt behind them, so valued at nothing. */
  withoutCost: number;
  /** Non-zero positions on merged products. They accept no movements, so they are left out. */
  skippedMerged: number;
}

/** What a reset is about to act on, read against `db` (or a transaction). */
export async function previewBranchReset(db: Db | Tx, branchId: string): Promise<ResetPreview> {
  const { rows } = await sql<ResetPreview>`
    SELECT
      count(*) FILTER (WHERE p.merged_into_id IS NULL)                                   AS "resettable",
      coalesce(sum(soh.qty_base)  FILTER (WHERE p.merged_into_id IS NULL AND soh.qty_base > 0), 0) AS "unitsOnHand",
      coalesce(sum(-soh.qty_base) FILTER (WHERE p.merged_into_id IS NULL AND soh.qty_base < 0), 0) AS "unitsBelowZero",
      round(coalesce(sum(soh.qty_base * coalesce(w.wac, 0)) FILTER (WHERE p.merged_into_id IS NULL), 0), 2) AS "valueAtCost",
      count(*) FILTER (WHERE p.merged_into_id IS NULL AND soh.qty_base > 0 AND w.wac IS NULL) AS "withoutCost",
      count(*) FILTER (WHERE p.merged_into_id IS NOT NULL)                               AS "skippedMerged"
    FROM stock_on_hand soh
    JOIN product p ON p.id = soh.product_id
    LEFT JOIN product_wac w ON w.product_id = soh.product_id AND w.branch_id = soh.branch_id
    WHERE soh.branch_id = ${branchId}::uuid
      AND soh.qty_base <> 0
  `.execute(db);

  const r = rows[0];
  return {
    resettable: Number(r?.resettable ?? 0),
    unitsOnHand: Number(r?.unitsOnHand ?? 0),
    unitsBelowZero: Number(r?.unitsBelowZero ?? 0),
    valueAtCost: Number(r?.valueAtCost ?? 0),
    withoutCost: Number(r?.withoutCost ?? 0),
    skippedMerged: Number(r?.skippedMerged ?? 0),
  };
}

export interface ResetResult extends ResetPreview {
  /** Null when there was nothing to zero: no movements, no exception, no audit entry. */
  docId: string | null;
  exceptionId: string | null;
}

export async function resetBranchStock(
  db: Db,
  input: {
    branchId: string;
    branchCode: string;
    branchName: string;
    actorId: string;
    reason: string;
    /** `resettable` from the preview the manager confirmed. */
    expectedPositions: number;
  },
): Promise<ResetResult> {
  return db.transaction().execute(async (tx) => {
    // 1. Wait out anything mid-sale on this branch, in a fixed order so two
    //    resets (or a reset and a stock take) cannot deadlock each other.
    //    Same key format as postMovementInTx.
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(s.product_id::text || s.branch_id::text, 0))
      FROM (
        SELECT product_id, branch_id FROM stock_on_hand
        WHERE branch_id = ${input.branchId}::uuid
        ORDER BY product_id
      ) s
    `.execute(tx);

    // 2. Read only now that nothing can move underneath us.
    const before = await previewBranchReset(tx, input.branchId);

    // 3. What was approved must be what is here.
    if (before.resettable !== input.expectedPositions) {
      throw new StockResetStale(input.expectedPositions, before.resettable);
    }

    // Already at zero (a double click, a second manager): a no-op, not an event.
    if (before.resettable === 0) return { ...before, docId: null, exceptionId: null };

    const docId = crypto.randomUUID();

    // 4. One statement, one offsetting movement per position.
    await sql`
      INSERT INTO stock_movement
        (event_id, product_id, branch_id, qty_base, unit_cost, reason, doc_type, doc_id, actor_id, occurred_at)
      SELECT gen_random_uuid(), soh.product_id, soh.branch_id, -soh.qty_base, NULL,
             'stock_reset', 'RESET', ${docId}::uuid, ${input.actorId}::uuid, now()
      FROM stock_on_hand soh
      JOIN product p ON p.id = soh.product_id
      WHERE soh.branch_id = ${input.branchId}::uuid
        AND soh.qty_base <> 0
        AND p.merged_into_id IS NULL
    `.execute(tx);

    // ...and prove it worked, rather than assume it. A branch that is not at
    // zero after this must not commit.
    const after = await previewBranchReset(tx, input.branchId);
    if (after.resettable !== 0) {
      throw new Error(
        `Stock reset left ${after.resettable} positions non-zero at branch ${input.branchId}; rolled back.`,
      );
    }

    // The auditor's view: one work item for the whole reset, with the money it
    // moved. Value impact is negative because inventory value went down (or
    // up, when negative positions were brought to zero, which is rarer).
    const exception = await tx
      .insertInto('exception_event')
      .values({
        event_id: crypto.randomUUID(),
        kind: 'stock_reset',
        branch_id: input.branchId,
        terminal_id: null,
        actor_id: input.actorId,
        product_id: null,
        detail: JSON.stringify({
          docId,
          reason: input.reason,
          positions: before.resettable,
          unitsRemoved: before.unitsOnHand,
          unitsRaisedFromNegative: before.unitsBelowZero,
          positionsWithoutCost: before.withoutCost,
          leftOutMerged: before.skippedMerged,
          branch: `${input.branchCode} ${input.branchName}`,
        }),
        value_impact: -before.valueAtCost,
        currency: 'USD',
        occurred_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: 'BRANCH_STOCK_RESET',
        actor_id: input.actorId,
        terminal_id: null,
        branch_id: input.branchId,
        entity_type: 'branch',
        entity_id: input.branchId,
        state_before: JSON.stringify({
          positions: before.resettable,
          unitsOnHand: before.unitsOnHand,
          unitsBelowZero: before.unitsBelowZero,
          valueAtCost: before.valueAtCost,
        }),
        state_after: JSON.stringify({ positions: 0, docId, reason: input.reason }),
        occurred_at: new Date(),
      })
      .execute();

    return { ...before, docId, exceptionId: exception.id };
  });
}
