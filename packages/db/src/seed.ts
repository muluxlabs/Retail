/**
 * Development seed.
 *
 * Not client data - they have none to migrate, and none of this is real
 * trading history. It is a believable standing start built from the branches,
 * products and failure modes catalogued in HANDOFF, so that every screen has
 * something meaningful on it and the exception queue is not an empty table.
 *
 * Deliberately modelled here:
 *   - Charhons biscuits as ONE product with a single and a case of 10, the
 *     conversion whose absence drove the USD 214,516 variance
 *   - Three Leaves 125g as ONE product, not the four records they have
 *   - a spread of open exceptions, so the queue has real work in it
 *
 * Idempotent: it refuses to run twice rather than duplicating a product master.
 */

import { ean13CheckDigit } from '@retail-ops/domain';
import type { Kysely } from 'kysely';

import { generateTemporaryPassword, hashPassword } from './password.js';
import type { Database, MovementReason } from './schema.js';

/** Build a genuinely valid EAN-13 from a 12-digit stem. */
function ean(stem12: string): string {
  return stem12 + String(ean13CheckDigit(stem12));
}

const BRANCHES: { code: string; name: string; kind: 'store' | 'warehouse' }[] = [
  { code: 'WH', name: 'Central Warehouse', kind: 'warehouse' },
  { code: 'KANA', name: 'Kana Mission', kind: 'store' },
  { code: 'LUPANE', name: 'Lupane', kind: 'store' },
  { code: 'GWELU', name: 'Gwelutshena', kind: 'store' },
  { code: 'KERN', name: 'Kernmaur', kind: 'store' },
  { code: 'STLUKES', name: 'St Lukes', kind: 'store' },
  { code: 'NESIGWE', name: 'Nesigwe', kind: 'store' },
  { code: 'MISSION', name: 'Mission', kind: 'store' },
  { code: 'TM', name: 'TM', kind: 'store' },
  { code: 'DOWN', name: 'Downstores', kind: 'store' },
  { code: 'NEWSUP', name: 'New Supermarket', kind: 'store' },
  { code: 'OLDSUP', name: 'Old Supermarket', kind: 'store' },
];

/**
 * Eight roles, split by capability rather than by POS/BACKOFFICE.
 * Their current system cannot let a manager approve a price change but not a
 * stock adjustment (HANDOFF section 2.6); these can.
 */
const ROLES: { id: string; name: string }[] = [
  { id: 'cashier', name: 'Cashier' },
  { id: 'supervisor', name: 'Shift Supervisor' },
  { id: 'receiver', name: 'Goods Receiver' },
  { id: 'stock_controller', name: 'Stock Controller' },
  { id: 'branch_manager', name: 'Branch Manager' },
  { id: 'auditor', name: 'Auditor' },
  { id: 'finance', name: 'Finance' },
  { id: 'administrator', name: 'Administrator' },
];

interface SeedPerson {
  full_name: string;
  phone: string | null;
  email: string | null;
  roles: string[];
  /** Sign-in address. Omit for a person who exists but cannot log in. */
  login?: string;
}

const PEOPLE: SeedPerson[] = [
  { full_name: 'System Administrator', phone: null, email: 'admin@retailops.local',
    login: 'admin@retailops.local', roles: ['administrator'] },
  { full_name: 'Group Auditor', phone: '0771000001', email: 'auditor@retailops.local',
    login: 'auditor@retailops.local', roles: ['auditor'] },
  { full_name: 'Eunice Madimbe', phone: '0776058588', email: 'eunice@retailops.local',
    login: 'eunice@retailops.local', roles: ['branch_manager'] },
  { full_name: 'Tendai Moyo', phone: '0778112233', email: 'tendai@retailops.local',
    login: 'tendai@retailops.local', roles: ['receiver', 'stock_controller'] },
  // Deliberately without a login: HANDOFF section 2.6 records cashiers with no
  // email and no phone. They exist as people and can be named on a movement,
  // but they cannot sign in to the back office.
  { full_name: 'Dzidzai Chikuku', phone: '0773368414', email: null, roles: ['cashier'] },
  { full_name: 'Hazel Gatsi', phone: '0772440190', email: null, roles: ['cashier'] },
];

interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  baseUom: string;
  isWeighed?: boolean;
  packs: { label: string; qtyBase: number; sell?: boolean; buy?: boolean; barcode?: string }[];
  cost: number;
}

const PRODUCTS: SeedProduct[] = [
  {
    sku: 'CHAR-500', name: 'Charhons biscuits 500g', category: 'Biscuits & Snacks',
    baseUom: 'each', cost: 1.35,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000001') },
      { label: 'case of 10', qtyBase: 10, buy: true, barcode: ean('600100000002') },
    ],
  },
  {
    sku: 'TL-125', name: 'Three Leaves tea 125g', category: 'Tea & Coffee',
    baseUom: 'each', cost: 0.8,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000003') },
      { label: 'case of 24', qtyBase: 24, buy: true, barcode: ean('600100000004') },
    ],
  },
  {
    sku: 'TL-250', name: 'Three Leaves tea 250g', category: 'Tea & Coffee',
    baseUom: 'each', cost: 1.45,
    packs: [{ label: 'single', qtyBase: 1, sell: true, buy: true, barcode: ean('600100000005') }],
  },
  {
    sku: 'KO-SOFT-1L', name: 'Knockout fabric softener 1L', category: 'Household',
    baseUom: 'each', cost: 2.1,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000006') },
      { label: 'case of 6', qtyBase: 6, buy: true, barcode: ean('600100000007') },
    ],
  },
  {
    sku: 'KO-FOAM-750', name: 'Knockout foam bath 750ml', category: 'Household',
    baseUom: 'each', cost: 1.75,
    packs: [{ label: 'single', qtyBase: 1, sell: true, buy: true, barcode: ean('600100000008') }],
  },
  {
    sku: 'MAZ-RAS-2L', name: 'Mazoe Raspberry 2L', category: 'Beverages',
    baseUom: 'each', cost: 3.2,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000009') },
      { label: 'case of 6', qtyBase: 6, buy: true, barcode: ean('600100000010') },
    ],
  },
  {
    sku: 'BON-500', name: 'Bonaqua still water 500ml', category: 'Beverages',
    baseUom: 'each', cost: 0.35,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000011') },
      { label: 'case of 12', qtyBase: 12, buy: true, barcode: ean('600100000012') },
    ],
  },
  {
    sku: 'BB-500', name: 'Blue Band margarine 500g', category: 'Dairy & Spreads',
    baseUom: 'each', cost: 2.4,
    packs: [{ label: 'single', qtyBase: 1, sell: true, buy: true, barcode: ean('600100000013') }],
  },
  {
    sku: 'SUGAR-2KG', name: 'White sugar 2kg', category: 'Dry Groceries',
    baseUom: 'each', cost: 2.15,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000014') },
      { label: 'bale of 10', qtyBase: 10, buy: true, barcode: ean('600100000015') },
    ],
  },
  {
    sku: 'MEAL-10KG', name: 'Maize meal 10kg', category: 'Dry Groceries',
    baseUom: 'each', cost: 6.5,
    packs: [{ label: 'single', qtyBase: 1, sell: true, buy: true, barcode: ean('600100000016') }],
  },
  {
    sku: 'SALT-1KG', name: 'Table salt 1kg', category: 'Dry Groceries',
    baseUom: 'each', cost: 0.45,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000017') },
      { label: 'case of 20', qtyBase: 20, buy: true, barcode: ean('600100000018') },
    ],
  },
  {
    sku: 'BEEF-KG', name: 'Beef stewing (per kg)', category: 'Butchery',
    baseUom: 'kg', isWeighed: true, cost: 5.8,
    packs: [{ label: 'kilogram', qtyBase: 1, sell: true, buy: true }],
  },
  {
    sku: 'COOKOIL-2L', name: 'Cooking oil 2L', category: 'Dry Groceries',
    baseUom: 'each', cost: 3.65,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000019') },
      { label: 'case of 6', qtyBase: 6, buy: true, barcode: ean('600100000020') },
    ],
  },
  {
    sku: 'SOAP-BAR', name: 'Laundry soap bar', category: 'Household',
    baseUom: 'each', cost: 0.9,
    packs: [
      { label: 'single', qtyBase: 1, sell: true, barcode: ean('600100000021') },
      { label: 'case of 24', qtyBase: 24, buy: true, barcode: ean('600100000022') },
    ],
  },
];

const CATEGORIES = [
  'Biscuits & Snacks', 'Tea & Coffee', 'Household', 'Beverages',
  'Dairy & Spreads', 'Dry Groceries', 'Butchery',
];

const DAY = 86_400_000;
const uid = (): string => crypto.randomUUID();

/** Deterministic pseudo-random, so repeated seeds of a fresh DB look alike. */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

export interface SeedResult {
  /** Credentials created, and the admin password if one was generated. */
  accounts: { email: string; password: string | null }[];
  branches: number;
  people: number;
  products: number;
  packs: number;
  barcodes: number;
  movements: number;
  exceptions: number;
  cashPoints: number;
  cashMovements: number;
}

export async function isSeeded(db: Kysely<Database>): Promise<boolean> {
  const [products, branches] = await Promise.all([
    db.selectFrom('product').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirst(),
    db.selectFrom('branch').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirst(),
  ]);
  return (products?.n ?? 0) > 0 || (branches?.n ?? 0) > 0;
}

export async function seed(
  db: Kysely<Database>,
  options: { force?: boolean; log?: (m: string) => void } = {},
): Promise<SeedResult> {
  const log = options.log ?? (() => {});

  if (await isSeeded(db)) {
    if (options.force !== true) {
      throw new Error(
        'Database already contains products. Refusing to seed on top of existing data. ' +
          'Pass --force to seed anyway, or reset with: npm run db:reset',
      );
    }
    log('  ! existing data present, seeding anyway (--force)');
  }

  return db.transaction().execute(async (tx) => {
    const rng = makeRng(20260914);
    const now = Date.now();

    // -- organisation --------------------------------------------------------
    const branchIds = new Map<string, string>();
    for (const b of BRANCHES) {
      const row = await tx
        .insertInto('branch')
        .values({ code: b.code, name: b.name, kind: b.kind })
        .returning('id')
        .executeTakeFirstOrThrow();
      branchIds.set(b.code, row.id);
    }
    log(`  + ${BRANCHES.length} branches`);

    const terminalIds: { branchCode: string; branchId: string; terminalId: string }[] = [];
    for (const b of BRANCHES) {
      const branchId = branchIds.get(b.code);
      if (branchId === undefined || b.kind === 'warehouse') continue;
      const tills = b.code === 'KANA' ? 3 : 2;
      for (let i = 1; i <= tills; i += 1) {
        const row = await tx
          .insertInto('terminal')
          .values({ branch_id: branchId, code: `${b.code}-TILL-${i}` })
          .returning('id')
          .executeTakeFirstOrThrow();
        terminalIds.push({ branchCode: b.code, branchId, terminalId: row.id });
      }
    }

    // Roles now come from migration 003. Kept here only to reconcile a
    // database migrated before that change.
    await tx.insertInto('role').values(ROLES).onConflict((oc) => oc.doNothing()).execute();

    const personIds: string[] = [];
    const personByName = new Map<string, string>();
    const accounts: { email: string; password: string | null }[] = [];

    for (const p of PEOPLE) {
      const row = await tx
        .insertInto('person')
        .values({ full_name: p.full_name, phone: p.phone, email: p.email })
        .returning('id')
        .executeTakeFirstOrThrow();
      personIds.push(row.id);
      personByName.set(p.full_name, row.id);

      for (const roleId of p.roles) {
        await tx
          .insertInto('person_role')
          .values({ person_id: row.id, role_id: roleId, branch_id: null })
          .execute();
      }

      if (p.login === undefined) continue;

      // The administrator password may be supplied by the environment so a
      // deployment can seed a known credential; everyone else gets a generated
      // one. Either way must_change_password is true, so a shared credential
      // cannot stay shared.
      const isAdmin = p.roles.includes('administrator');
      const supplied = isAdmin ? process.env['ADMIN_PASSWORD'] : undefined;
      const password =
        supplied !== undefined && supplied !== '' ? supplied : generateTemporaryPassword();

      await tx
        .insertInto('user_credential')
        .values({
          person_id: row.id,
          email: p.login,
          password_hash: await hashPassword(password),
          must_change_password: true,
        })
        .execute();

      accounts.push({ email: p.login, password });
    }
    log(`  + ${PEOPLE.length} people, ${ROLES.length} roles, ${accounts.length} sign-ins`);

    // Looked up by name rather than by index: the order of PEOPLE is
    // presentational and must not silently reassign who did what.
    const auditor = personByName.get('Group Auditor') ?? '';
    const manager = personByName.get('Eunice Madimbe') ?? '';
    const cashier = personByName.get('Dzidzai Chikuku') ?? '';
    const receiver = personByName.get('Tendai Moyo') ?? '';

    // -- product master ------------------------------------------------------
    const categoryIds = new Map<string, string>();
    for (const name of CATEGORIES) {
      const row = await tx
        .insertInto('product_category')
        .values({ name, parent_id: null })
        .returning('id')
        .executeTakeFirstOrThrow();
      categoryIds.set(name, row.id);
    }

    interface Loaded { id: string; sku: string; cost: number; sellPackQty: number; buyPackQty: number }
    const loaded: Loaded[] = [];
    let packCount = 0;
    let barcodeCount = 0;

    for (const p of PRODUCTS) {
      const product = await tx
        .insertInto('product')
        .values({
          sku: p.sku,
          name: p.name,
          base_uom: p.baseUom,
          is_weighed: p.isWeighed ?? false,
          category_id: categoryIds.get(p.category) ?? null,
          merged_into_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      let sellPackQty = 1;
      let buyPackQty = 1;
      for (const pack of p.packs) {
        const packRow = await tx
          .insertInto('product_pack')
          .values({
            product_id: product.id,
            label: pack.label,
            qty_base: pack.qtyBase,
            is_default_sell: pack.sell ?? false,
            is_default_buy: pack.buy ?? false,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        packCount += 1;
        if (pack.sell === true) sellPackQty = pack.qtyBase;
        if (pack.buy === true) buyPackQty = pack.qtyBase;
        if (pack.barcode !== undefined) {
          await tx
            .insertInto('barcode')
            .values({ code: pack.barcode, pack_id: packRow.id, symbology: 'ean13' })
            .execute();
          barcodeCount += 1;
        }
      }
      loaded.push({ id: product.id, sku: p.sku, cost: p.cost, sellPackQty, buyPackQty });
    }
    log(`  + ${PRODUCTS.length} products, ${packCount} packs, ${barcodeCount} barcodes`);

    // -- trading history -----------------------------------------------------
    // Opening balances, then receipts into the warehouse, then branch sales.
    // Everything in base units, every row carrying both timestamps.
    const movements: {
      event_id: string; product_id: string; branch_id: string; qty_base: number;
      unit_cost: number | null; reason: MovementReason; doc_type: string | null;
      doc_id: string | null; actor_id: string; occurred_at: Date;
    }[] = [];

    const tradingBranches = BRANCHES.filter((b) => b.kind === 'store').slice(0, 6);
    const warehouseId = branchIds.get('WH') ?? '';

    for (const product of loaded) {
      // Warehouse opening balance.
      movements.push({
        event_id: uid(), product_id: product.id, branch_id: warehouseId,
        qty_base: Math.round(400 + rng() * 600), unit_cost: product.cost,
        reason: 'opening_balance', doc_type: null, doc_id: null,
        actor_id: auditor, occurred_at: new Date(now - 60 * DAY),
      });

      for (const b of tradingBranches) {
        const branchId = branchIds.get(b.code);
        if (branchId === undefined) continue;

        // Opening balance at the branch.
        const opening = Math.round(40 + rng() * 160);
        movements.push({
          event_id: uid(), product_id: product.id, branch_id: branchId,
          qty_base: opening, unit_cost: product.cost, reason: 'opening_balance',
          doc_type: null, doc_id: null, actor_id: auditor,
          occurred_at: new Date(now - 60 * DAY),
        });

        // A couple of goods receipts, in whole buying packs, at drifting cost.
        let received = 0;
        const grns = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < grns; i += 1) {
          const packs = 1 + Math.floor(rng() * 4);
          const qty = packs * product.buyPackQty;
          received += qty;
          movements.push({
            event_id: uid(), product_id: product.id, branch_id: branchId,
            qty_base: qty,
            unit_cost: Number((product.cost * (0.95 + rng() * 0.12)).toFixed(4)),
            reason: 'grn', doc_type: 'GRN', doc_id: uid(), actor_id: receiver,
            occurred_at: new Date(now - Math.floor(rng() * 45 + 5) * DAY),
          });
        }

        // Sales, kept strictly below stock so nothing seeds negative.
        const available = opening + received;
        let sold = 0;
        const saleCount = 3 + Math.floor(rng() * 5);
        for (let i = 0; i < saleCount; i += 1) {
          const qty = Math.max(1, Math.round(rng() * (available * 0.06)));
          if (sold + qty >= available * 0.7) break;
          sold += qty;
          movements.push({
            event_id: uid(), product_id: product.id, branch_id: branchId,
            qty_base: -qty, unit_cost: null, reason: 'sale', doc_type: 'SALE',
            doc_id: uid(), actor_id: cashier,
            occurred_at: new Date(now - Math.floor(rng() * 30) * DAY),
          });
        }
      }
    }

    for (let i = 0; i < movements.length; i += 200) {
      await tx.insertInto('stock_movement').values(movements.slice(i, i + 200)).execute();
    }
    log(`  + ${movements.length} stock movements`);

    // -- cash custody ----------------------------------------------------------
    // One till per terminal, one safe and one petty box per trading branch
    // (not the warehouse - it does not run a till). Each opens with a
    // believable starting float so the position screen has real numbers on
    // it from the first login, the same reasoning as the stock seed.
    let cashPointCount = 0;
    let cashMovementCount = 0;

    async function openPoint(
      branchId: string,
      kind: 'till' | 'safe' | 'petty' | 'bank',
      name: string,
      terminalId: string | null,
      openingAmount: number,
    ): Promise<void> {
      const point = await tx
        .insertInto('cash_point')
        .values({ branch_id: branchId, kind, terminal_id: terminalId, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('cash_movement')
        .values({
          event_id: uid(),
          cash_point_id: point.id,
          amount: openingAmount,
          reason: 'opening_balance',
          actor_id: auditor,
          occurred_at: new Date(now - 45 * DAY),
        })
        .execute();
      cashPointCount += 1;
      cashMovementCount += 1;
    }

    for (const t of terminalIds) {
      await openPoint(t.branchId, 'till', `${t.branchCode} till`, t.terminalId, 50 + rng() * 30);
    }
    for (const b of tradingBranches) {
      const branchId = branchIds.get(b.code);
      if (branchId === undefined) continue;
      await openPoint(branchId, 'safe', `${b.code} safe`, null, 400 + rng() * 300);
      await openPoint(branchId, 'petty', `${b.code} petty cash`, null, 40 + rng() * 40);
    }
    log(`  + ${cashPointCount} cash points, ${cashMovementCount} opening balances`);

    // -- the exception queue -------------------------------------------------
    // Real work items, not log lines. Each needs a named human to clear it.
    const kana = branchIds.get('KANA') ?? '';
    const kern = branchIds.get('KERN') ?? '';
    const lupane = branchIds.get('LUPANE') ?? '';
    const charhons = loaded.find((p) => p.sku === 'CHAR-500');
    const threeLeaves = loaded.find((p) => p.sku === 'TL-125');
    const sugar = loaded.find((p) => p.sku === 'SUGAR-2KG');

    const exceptions = [
      {
        event_id: uid(), kind: 'unlisted_barcode_scan' as const, branch_id: kana,
        terminal_id: null, actor_id: cashier, product_id: null,
        detail: JSON.stringify({ rawBarcode: '9771234567003', attempts: 3 }),
        value_impact: null, currency: null, occurred_at: new Date(now - 2 * DAY),
      },
      {
        event_id: uid(), kind: 'negative_stock_override' as const, branch_id: kana,
        terminal_id: null, actor_id: cashier, product_id: threeLeaves?.id ?? null,
        detail: JSON.stringify({ available: 4, requested: 30, authorisedBy: 'Eunice Madimbe' }),
        value_impact: -20.8, currency: 'USD', occurred_at: new Date(now - 1 * DAY),
      },
      {
        event_id: uid(), kind: 'backdated_entry' as const, branch_id: kern,
        terminal_id: null, actor_id: receiver, product_id: sugar?.id ?? null,
        detail: JSON.stringify({ gapHours: 3648, docType: 'GRN', note: 'Goods dated Dec, entered May' }),
        value_impact: 430.0, currency: 'USD', occurred_at: new Date(now - 5 * DAY),
      },
      {
        event_id: uid(), kind: 'count_variance' as const, branch_id: kana,
        terminal_id: null, actor_id: manager, product_id: charhons?.id ?? null,
        detail: JSON.stringify({ expected: 380, counted: 500, variance: 120, docId: 'IC-10027' }),
        value_impact: 162.0, currency: 'USD', occurred_at: new Date(now - 3 * DAY),
      },
      {
        event_id: uid(), kind: 'price_override' as const, branch_id: lupane,
        terminal_id: null, actor_id: cashier, product_id: sugar?.id ?? null,
        detail: JSON.stringify({ listPrice: 2.99, chargedPrice: 2.2, reason: 'damaged packaging' }),
        value_impact: -0.79, currency: 'USD', occurred_at: new Date(now - 6 * 3_600_000),
      },
      {
        event_id: uid(), kind: 'cash_variance' as const, branch_id: kern,
        terminal_id: null, actor_id: cashier, product_id: null,
        detail: JSON.stringify({ declared: 412.5, counted: 398.15, shift: 'PM' }),
        value_impact: -14.35, currency: 'USD', occurred_at: new Date(now - 4 * DAY),
      },
      {
        event_id: uid(), kind: 'void_after_tender' as const, branch_id: kana,
        terminal_id: null, actor_id: cashier, product_id: null,
        detail: JSON.stringify({ receipt: 'R-88213', lines: 2, afterTender: true }),
        value_impact: -18.4, currency: 'USD', occurred_at: new Date(now - 8 * 3_600_000),
      },
      {
        event_id: uid(), kind: 'transit_loss' as const, branch_id: lupane,
        terminal_id: null, actor_id: receiver, product_id: threeLeaves?.id ?? null,
        detail: JSON.stringify({ dispatched: 240, received: 216, shortfall: 24 }),
        value_impact: -19.2, currency: 'USD', occurred_at: new Date(now - 7 * DAY),
      },
    ];

    await tx.insertInto('exception_event').values(exceptions).execute();
    log(`  + ${exceptions.length} open exceptions`);

    return {
      accounts,
      branches: BRANCHES.length,
      people: PEOPLE.length,
      products: PRODUCTS.length,
      packs: packCount,
      barcodes: barcodeCount,
      movements: movements.length,
      exceptions: exceptions.length,
      cashPoints: cashPointCount,
      cashMovements: cashMovementCount,
    };
  });
}
