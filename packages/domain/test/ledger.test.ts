/**
 * Executable proof of the core domain model.
 *
 * Direct port of `ledger_proof.reference.py`. Every test below is a real
 * failure taken from the client's own data. If this file passes, the model
 * makes those failures unrepresentable. If one of these fails, we have
 * reintroduced a known defect.
 *
 * These tests share one ledger and run in order, exactly as the reference
 * does. That is deliberate: an append-only ledger accumulates, and several
 * proofs depend on the state the previous ones left behind. Vitest runs tests
 * within a file sequentially.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  InvalidMasterData,
  Ledger,
  LedgerImmutable,
  MasterData,
  NegativeStockBlocked,
  UnlistedBarcode,
  type Uuid,
} from '../src/index.js';

const uid = (): Uuid => crypto.randomUUID();

const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  master: MasterData;
  ledger: Ledger;
  kana: Uuid;
  warehouse: Uuid;
  cashier: Uuid;
  manager: Uuid;
  charhons: Uuid;
  charhonsSingle: Uuid;
  charhonsCase: Uuid;
  threeLeaves: Uuid;
  tlSingle: Uuid;
}

/** The client's actual data. */
function seed(): Fixture {
  const master = new MasterData();
  const ledger = new Ledger(master);

  const kana = uid();
  const warehouse = uid();

  // Persons are modelled in the schema, not in this package; ids stand in.
  const cashier = uid(); // Dzidzai Chikuku
  const manager = uid(); // Eunice Madimbe

  // Charhons biscuits - the case/single problem. ONE product, TWO packs.
  const charhons = uid();
  master.addProduct({
    id: charhons,
    sku: 'CHAR-500',
    name: 'Charhons biscuits 500g',
    baseUom: 'each',
  });
  const charhonsSingle = uid();
  const charhonsCase = uid();
  master.addPack({ id: charhonsSingle, productId: charhons, label: 'single', qtyBase: 1 });
  master.addPack({ id: charhonsCase, productId: charhons, label: 'case of 10', qtyBase: 10 });
  master.addBarcode({ code: '6001234567890', packId: charhonsSingle });
  master.addBarcode({ code: '6001234567906', packId: charhonsCase });

  // Three Leaves 125g - the product that had four records.
  const threeLeaves = uid();
  master.addProduct({
    id: threeLeaves,
    sku: 'TL-125',
    name: 'Three Leaves tea 125g',
    baseUom: 'each',
  });
  const tlSingle = uid();
  master.addPack({ id: tlSingle, productId: threeLeaves, label: 'single', qtyBase: 1 });
  master.addBarcode({ code: '6009876543210', packId: tlSingle });

  return {
    master,
    ledger,
    kana,
    warehouse,
    cashier,
    manager,
    charhons,
    charhonsSingle,
    charhonsCase,
    threeLeaves,
    tlSingle,
  };
}

describe('Core domain model - invariant proofs', () => {
  let f: Fixture;

  beforeAll(() => {
    f = seed();
  });

  it('case-to-single conversion reconciles', () => {
    // IC-10027's likely root cause: receive cases, sell singles.
    // Old system: 50 cases received, 120 singles sold -> nonsense.
    // New system: 500 units received, 120 sold -> 380 on hand.
    const { qtyBase: caseMultiplier } = f.ledger.resolveBarcode('6001234567906');
    f.ledger.post({
      productId: f.charhons,
      branchId: f.kana,
      qtyBase: 50 * caseMultiplier,
      unitCost: 1.35,
      reason: 'grn',
      actorId: f.manager,
      docType: 'GRN',
    });
    f.ledger.sell({
      barcode: '6001234567890',
      qtyPacks: 120,
      branchId: f.kana,
      actorId: f.cashier,
    });

    expect(f.ledger.onHand(f.charhons, f.kana)).toBe(380);
  });

  it('duplicate barcode rejected', () => {
    // The Three Leaves x4 defect. A barcode may point at exactly one pack.
    const dupe = uid();
    f.master.addProduct({
      id: dupe,
      sku: 'TL-125-DUP',
      name: '125g three leaves tea bags',
      baseUom: 'each',
    });
    const dupePack = uid();
    f.master.addPack({ id: dupePack, productId: dupe, label: 'single', qtyBase: 1 });

    expect(() =>
      f.master.addBarcode({ code: '6009876543210', packId: dupePack }),
    ).toThrow(InvalidMasterData);
  });

  it('malformed barcodes rejected', () => {
    // 241 codes under six digits, 42 over thirteen, one negative.
    // All now unrepresentable.
    for (const bad of ['-1124125534', '3', '6744072585426083']) {
      expect(
        () => f.master.addBarcode({ code: bad, packId: f.tlSingle }),
        `expected ${bad} to be rejected`,
      ).toThrow(InvalidMasterData);
    }
  });

  it('ledger rejects UPDATE and DELETE', () => {
    // R2. Not a convention - the ledger refuses, as the database trigger does.
    const seq = f.ledger.post({
      productId: f.threeLeaves,
      branchId: f.kana,
      qtyBase: 500,
      unitCost: 0.8,
      reason: 'opening_balance',
      actorId: f.manager,
    });

    expect(() => f.ledger.update(seq, { qtyBase: 9999 })).toThrow(LedgerImmutable);
    expect(() => f.ledger.delete(seq)).toThrow(LedgerImmutable);

    // History is handed out frozen, so there is no back door either.
    const posted = f.ledger.movements().find((m) => m.seq === seq);
    expect(posted).toBeDefined();
    expect(() => {
      (posted as { qtyBase: number }).qtyBase = 9999;
    }).toThrow(TypeError);
    expect(f.ledger.onHand(f.threeLeaves, f.kana)).toBe(500);
  });

  it('negative stock blocked by default', () => {
    // "selling negative / zeros - override to their own benefit".
    expect(() =>
      f.ledger.sell({
        barcode: '6009876543210',
        qtyPacks: 100000,
        branchId: f.kana,
        actorId: f.cashier,
      }),
    ).toThrow(NegativeStockBlocked);
  });

  it('override creates an open exception', () => {
    // Blocked by default; when overridden, an incident is created.
    const before = f.ledger.openExceptions('negative_stock_override').length;

    f.ledger.sell({
      barcode: '6009876543210',
      qtyPacks: 100000,
      branchId: f.kana,
      actorId: f.cashier,
      overrideNegative: true,
      overrideBy: f.manager,
    });

    const open = f.ledger.openExceptions('negative_stock_override');
    expect(open.length).toBe(before + 1);
    expect(open[open.length - 1]?.detail['authorisedBy']).toBe(f.manager);
  });

  it('unlisted barcode raises and logs', () => {
    // Under-the-counter sales: the scan itself becomes evidence.
    expect(() => f.ledger.resolveBarcode('9999999999999')).toThrow(UnlistedBarcode);

    f.ledger.scanUnlisted({
      code: '9999999999999',
      branchId: f.kana,
      actorId: f.cashier,
    });

    expect(f.ledger.openExceptions('unlisted_barcode_scan').length).toBe(1);
  });

  it('backdated receipt flagged', () => {
    // TGRN-10001: goods dated 13 Dec 2025, entered 14 May 2026.
    const before = f.ledger.openExceptions('backdated_entry').length;

    f.ledger.post({
      productId: f.threeLeaves,
      branchId: f.warehouse,
      qtyBase: 200,
      unitCost: 0.8,
      reason: 'grn',
      actorId: f.manager,
      occurredAt: new Date(Date.now() - 152 * DAY_MS),
    });

    expect(f.ledger.openExceptions('backdated_entry').length).toBe(before + 1);
    expect(f.ledger.backdatedMovements().length).toBe(1);
  });

  it('replayed offline events apply once', () => {
    // R4. A terminal that syncs the same batch twice must not double-count.
    const eventId = uid();
    const before = f.ledger.onHand(f.threeLeaves, f.warehouse);

    const seqs = [1, 2, 3].map(() =>
      f.ledger.post({
        eventId,
        productId: f.threeLeaves,
        branchId: f.warehouse,
        qtyBase: 25,
        unitCost: 0.8,
        reason: 'grn',
        actorId: f.manager,
      }),
    );

    expect(f.ledger.onHand(f.threeLeaves, f.warehouse) - before).toBe(25);
    // The replays returned the original sequence rather than appending.
    expect(new Set(seqs).size).toBe(1);
  });

  it('count variance posts an adjustment', () => {
    // A count that finds 400 against a book of 380 must post the adjustment.
    const { expected, variance } = f.ledger.postCount({
      productId: f.charhons,
      branchId: f.kana,
      countedBase: 400,
      actorId: f.manager,
      docId: uid(),
    });

    expect(expected).toBe(380);
    expect(variance).toBe(20);
    expect(f.ledger.onHand(f.charhons, f.kana)).toBe(400);
  });

  it('count variance is costed', () => {
    // Valuing the variance at weighted-average cost is the step that, when
    // skipped, produced the 0.11% gross margin.
    const open = f.ledger.openExceptions('count_variance');
    expect(open.length).toBeGreaterThan(0);
    expect(open.some((e) => e.valueImpact !== null && e.valueImpact > 0)).toBe(true);
    // 20 units of variance at a WAC of 1.35.
    expect(open[open.length - 1]?.valueImpact).toBe(27);
  });

  it('weighted-average cost derived from ledger', () => {
    // Cost comes from the movement history, so it cannot silently drift to
    // equal the selling price.
    const p = uid();
    f.master.addProduct({ id: p, sku: 'WAC-T', name: 'WAC test item', baseUom: 'each' });

    f.ledger.post({
      productId: p,
      branchId: f.kana,
      qtyBase: 100,
      unitCost: 1.0,
      reason: 'grn',
      actorId: f.manager,
    });
    f.ledger.post({
      productId: p,
      branchId: f.kana,
      qtyBase: 100,
      unitCost: 2.0,
      reason: 'grn',
      actorId: f.manager,
    });

    expect(f.ledger.wac(p, f.kana)).toBeCloseTo(1.5, 9);
  });
});
