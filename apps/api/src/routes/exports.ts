/**
 * Exporting records: the item master, suppliers, customers, supplier price
 * lists and staff, as rows the browser turns into an Excel or CSV file.
 *
 * Needs data.export (administrators and branch managers, or anyone granted
 * it) AND the right to see that data in the first place - export never shows
 * more than the screens do. Someone tied to a branch gets that branch's stock
 * and costs, and no supplier balances (group-wide finance). Every export is
 * written to the audit log: what, how many rows, by whom.
 *
 * Column headings match the import templates where the two overlap, so an
 * exported file can be edited and brought back in.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { NotPermitted } from '../plugins/auth.js';
import { scopedBranchIds } from '../scope.js';
import { businessTimezone } from '../services/purchasing.js';
import { parseParams, parseQuery } from '../validation.js';

export const EXPORT_KINDS = ['items', 'suppliers', 'customers', 'price-lists', 'staff'] as const;
type Kind = (typeof EXPORT_KINDS)[number];

/** What each export needs besides data.export: the permission that shows the same data on screen. */
const READ_PERMISSION: Record<Kind, string> = {
  items: 'product.read',
  suppliers: 'supplier.read',
  customers: 'customer.read',
  'price-lists': 'supplier.read',
  staff: 'user.manage',
};

type ColumnKind = 'text' | 'number' | 'money' | 'date' | 'yesno';
interface Column {
  heading: string;
  kind: ColumnKind;
}
type Cell = string | number | boolean | null;

const params = z.object({ kind: z.enum(EXPORT_KINDS) });
const query = z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') });

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const money = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const cost4 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10000) / 10000);
const TERMS: Record<string, string> = { credit: 'credit', cash_on_delivery: 'cash on delivery', prepaid: 'prepaid' };

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  const has = (request: FastifyRequest, permission: string) => request.user?.permissions.has(permission) === true;

  async function items(request: FastifyRequest, tz: string) {
    const scope = scopedBranchIds(request);
    const withCost = has(request, 'supplier.read');
    const branches = await app.db
      .selectFrom('branch')
      .select(['id', 'code'])
      .where('is_active', '=', true)
      .$if(scope !== null, (qb) => qb.where('id', 'in', scope as string[]))
      .orderBy('code')
      .execute();
    const branchIds = branches.map((b) => b.id);

    const rows = (
      await sql<Record<string, unknown>>`
      WITH cost AS (
        SELECT product_id, sum(qty_base * unit_cost) / nullif(sum(qty_base), 0) AS wac
        FROM stock_movement
        WHERE reason IN ('grn', 'opening_balance', 'transfer_in') AND unit_cost IS NOT NULL
          AND (${scope === null} OR branch_id = ANY(${branchIds}::uuid[]))
        GROUP BY product_id
      ), last_received AS (
        SELECT DISTINCT ON (l.product_id) l.product_id,
               l.unit_cost * l.qty_packs / nullif(l.qty_base, 0) AS cost_base,
               to_char(g.received_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS received_on,
               s.name AS supplier
        FROM goods_received_line l
        JOIN goods_received g ON g.id = l.grn_id
        JOIN supplier s ON s.id = g.supplier_id
        WHERE (${scope === null} OR g.branch_id = ANY(${branchIds}::uuid[]))
        ORDER BY l.product_id, g.received_at DESC, l.line_no
      )
      SELECT p.id AS product_id, p.sku, p.name, c.name AS category, p.base_uom, p.is_weighed, p.is_active,
             pk.label, pk.qty_base, pk.sell_price, pk.is_default_sell, pk.is_default_buy,
             (SELECT string_agg(b.code, ' / ' ORDER BY b.created_at) FROM barcode b WHERE b.pack_id = pk.id) AS barcodes,
             cost.wac, lr.cost_base, lr.received_on, lr.supplier,
             row_number() OVER (PARTITION BY p.id ORDER BY pk.is_default_sell DESC, pk.qty_base) AS pack_rank
      FROM product p
      JOIN product_pack pk ON pk.product_id = p.id
      LEFT JOIN product_category c ON c.id = p.category_id
      LEFT JOIN cost ON cost.product_id = p.id
      LEFT JOIN last_received lr ON lr.product_id = p.id
      WHERE p.merged_into_id IS NULL
      ORDER BY p.name, p.id, pk.qty_base`.execute(app.db)
    ).rows;

    const stock = branchIds.length === 0
      ? []
      : await app.db.selectFrom('stock_on_hand').select(['product_id', 'branch_id', 'qty_base']).where('branch_id', 'in', branchIds).execute();
    const stockOf = new Map<string, Map<string, number>>();
    for (const s of stock) {
      const m = stockOf.get(s.product_id) ?? new Map<string, number>();
      m.set(s.branch_id, Number(s.qty_base));
      stockOf.set(s.product_id, m);
    }

    const columns: Column[] = [
      { heading: 'SKU', kind: 'text' },
      { heading: 'Item name', kind: 'text' },
      { heading: 'Category', kind: 'text' },
      { heading: 'Base unit', kind: 'text' },
      { heading: 'Weighed', kind: 'yesno' },
      { heading: 'Pack', kind: 'text' },
      { heading: 'Units in pack', kind: 'number' },
      { heading: 'Barcode', kind: 'text' },
      { heading: 'Other barcodes', kind: 'text' },
      { heading: 'Selling price', kind: 'money' },
      { heading: 'Sell this pack', kind: 'yesno' },
      { heading: 'Buy this pack', kind: 'yesno' },
      ...(withCost
        ? ([
            { heading: 'Cost price', kind: 'money' },
            { heading: 'Margin %', kind: 'number' },
            { heading: 'Last received cost', kind: 'money' },
            { heading: 'Last received on', kind: 'date' },
            { heading: 'Last supplier', kind: 'text' },
          ] as Column[])
        : []),
      { heading: 'Active', kind: 'yesno' },
      ...branches.map((b) => ({ heading: `Stock at ${b.code} (base units)`, kind: 'number' as const })),
      { heading: 'Total stock (base units)', kind: 'number' },
    ];

    const out: Cell[][] = rows.map((r) => {
      const qty = Number(r['qty_base']);
      const codes = r['barcodes'] === null ? [] : String(r['barcodes']).split(' / ');
      const sell = money(r['sell_price']);
      const avgPack = r['wac'] === null ? null : cost4(Number(r['wac']) * qty);
      const lastPack = r['cost_base'] === null ? null : cost4(Number(r['cost_base']) * qty);
      // Stock is per item, in base units: shown once, on the item's selling pack row, so columns add up.
      const first = Number(r['pack_rank']) === 1;
      const held = stockOf.get(String(r['product_id']));
      const perBranch = branches.map((b) => (first ? (held?.get(b.id) ?? 0) : null));
      const total = first ? perBranch.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
      return [
        r['sku'] as string,
        r['name'] as string,
        (r['category'] as string | null) ?? '',
        r['base_uom'] as string,
        r['is_weighed'] as boolean,
        r['label'] as string,
        qty,
        codes[0] ?? '',
        codes.slice(1).join(' / '),
        sell,
        r['is_default_sell'] as boolean,
        r['is_default_buy'] as boolean,
        ...(withCost
          ? [
              avgPack,
              sell !== null && sell > 0 && avgPack !== null ? Math.round(((sell - avgPack) / sell) * 1000) / 10 : null,
              lastPack,
              (r['received_on'] as string | null) ?? '',
              (r['supplier'] as string | null) ?? '',
            ]
          : []),
        r['is_active'] as boolean,
        ...perBranch,
        total,
      ];
    });
    const note = withCost
      ? 'Cost price is the average cost of one pack (what stock is valued at). Last received cost is what one pack cost on the most recent delivery.'
      : null;
    return { title: 'Items', columns, rows: out, note };
  }

  async function suppliers(request: FastifyRequest, tz: string) {
    const groupWide = scopedBranchIds(request) === null;
    const rows = (
      await sql<Record<string, unknown>>`
      SELECT s.code, s.name, s.contact_person, s.phone, s.email, s.address, s.tin, s.terms, s.credit_days, s.notes, s.is_active,
             to_char(s.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS added_on,
             b.received_cost, b.returned_cost, b.paid, b.balance
      FROM supplier s JOIN supplier_balance b ON b.supplier_id = s.id
      ORDER BY s.name`.execute(app.db)
    ).rows;
    const columns: Column[] = [
      { heading: 'Code', kind: 'text' },
      { heading: 'Supplier name', kind: 'text' },
      { heading: 'Contact person', kind: 'text' },
      { heading: 'Phone', kind: 'text' },
      { heading: 'Email', kind: 'text' },
      { heading: 'Address', kind: 'text' },
      { heading: 'TIN / VAT number', kind: 'text' },
      { heading: 'Terms', kind: 'text' },
      { heading: 'Days to pay', kind: 'number' },
      { heading: 'Notes', kind: 'text' },
      { heading: 'Active', kind: 'yesno' },
      { heading: 'Added on', kind: 'date' },
      // What is owed is group-wide finance, as on the Suppliers screen.
      ...(groupWide
        ? ([
            { heading: 'Goods received', kind: 'money' },
            { heading: 'Returned', kind: 'money' },
            { heading: 'Paid', kind: 'money' },
            { heading: 'Balance owed', kind: 'money' },
          ] as Column[])
        : []),
    ];
    const out: Cell[][] = rows.map((r) => [
      r['code'] as string,
      r['name'] as string,
      (r['contact_person'] as string | null) ?? '',
      (r['phone'] as string | null) ?? '',
      (r['email'] as string | null) ?? '',
      (r['address'] as string | null) ?? '',
      (r['tin'] as string | null) ?? '',
      TERMS[String(r['terms'])] ?? String(r['terms']),
      n(r['credit_days']),
      (r['notes'] as string | null) ?? '',
      r['is_active'] as boolean,
      r['added_on'] as string,
      ...(groupWide ? [money(r['received_cost']), money(r['returned_cost']), money(r['paid']), money(r['balance'])] : []),
    ]);
    return { title: 'Suppliers', columns, rows: out, note: groupWide ? null : 'Balances owed are left out: they are group-wide finance.' };
  }

  async function customers(_request: FastifyRequest, tz: string) {
    const rows = (
      await sql<Record<string, unknown>>`
      SELECT c.code, c.name, c.phone, c.email, c.address, c.id_number, c.credit_limit, c.credit_days, c.notes, c.is_active,
             to_char(c.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS added_on,
             b.charged, b.paid, b.balance, coalesce(lb.points, 0) AS points,
             (SELECT to_char(max(s.occurred_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD') FROM sale s WHERE s.customer_id = c.id) AS last_sale
      FROM customer c
      JOIN customer_balance b ON b.customer_id = c.id
      LEFT JOIN loyalty_balance lb ON lb.customer_id = c.id
      ORDER BY c.name`.execute(app.db)
    ).rows;
    const columns: Column[] = [
      { heading: 'Code', kind: 'text' },
      { heading: 'Name', kind: 'text' },
      { heading: 'Phone', kind: 'text' },
      { heading: 'Email', kind: 'text' },
      { heading: 'Address', kind: 'text' },
      { heading: 'ID number', kind: 'text' },
      { heading: 'Credit limit', kind: 'money' },
      { heading: 'Days to pay', kind: 'number' },
      { heading: 'Notes', kind: 'text' },
      { heading: 'Active', kind: 'yesno' },
      { heading: 'Added on', kind: 'date' },
      { heading: 'Charged on account', kind: 'money' },
      { heading: 'Paid', kind: 'money' },
      { heading: 'Balance owed', kind: 'money' },
      { heading: 'Loyalty points', kind: 'number' },
      { heading: 'Last sale', kind: 'date' },
    ];
    const out: Cell[][] = rows.map((r) => [
      r['code'] as string,
      r['name'] as string,
      (r['phone'] as string | null) ?? '',
      (r['email'] as string | null) ?? '',
      (r['address'] as string | null) ?? '',
      (r['id_number'] as string | null) ?? '',
      money(r['credit_limit']),
      n(r['credit_days']),
      (r['notes'] as string | null) ?? '',
      r['is_active'] as boolean,
      r['added_on'] as string,
      money(r['charged']),
      money(r['paid']),
      money(r['balance']),
      n(r['points']),
      (r['last_sale'] as string | null) ?? '',
    ]);
    return { title: 'Customers', columns, rows: out, note: null };
  }

  async function priceLists(_request: FastifyRequest, tz: string) {
    const rows = (
      await sql<Record<string, unknown>>`
      SELECT s.name AS supplier, si.supplier_code, p.sku, p.name, pk.label, pk.qty_base, si.cost, pk.sell_price,
             to_char(si.updated_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS updated_on
      FROM supplier_item si
      JOIN supplier s ON s.id = si.supplier_id
      JOIN product_pack pk ON pk.id = si.pack_id
      JOIN product p ON p.id = pk.product_id
      ORDER BY s.name, p.name, pk.qty_base`.execute(app.db)
    ).rows;
    const columns: Column[] = [
      { heading: 'Supplier', kind: 'text' },
      { heading: 'Supplier code', kind: 'text' },
      { heading: 'SKU', kind: 'text' },
      { heading: 'Item name', kind: 'text' },
      { heading: 'Pack', kind: 'text' },
      { heading: 'Units in pack', kind: 'number' },
      { heading: 'Supplier cost', kind: 'money' },
      { heading: 'Your selling price', kind: 'money' },
      { heading: 'Margin %', kind: 'number' },
      { heading: 'Cost updated on', kind: 'date' },
    ];
    const out: Cell[][] = rows.map((r) => {
      const c = cost4(r['cost']);
      const sell = money(r['sell_price']);
      return [
        r['supplier'] as string,
        (r['supplier_code'] as string | null) ?? '',
        r['sku'] as string,
        r['name'] as string,
        r['label'] as string,
        n(r['qty_base']),
        c,
        sell,
        sell !== null && sell > 0 && c !== null ? Math.round(((sell - c) / sell) * 1000) / 10 : null,
        r['updated_on'] as string,
      ];
    });
    return { title: 'Supplier price lists', columns, rows: out, note: 'The latest cost each supplier has given for each pack.' };
  }

  async function staff(_request: FastifyRequest, tz: string) {
    const rows = (
      await sql<Record<string, unknown>>`
      SELECT p.full_name, uc.email AS login_email, p.phone, p.is_active,
             to_char(uc.last_login_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS last_login,
             to_char(p.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS added_on,
             (SELECT string_agg(r.name || coalesce(' (' || b.code || ')', ''), ', ' ORDER BY r.name)
                FROM person_role pr JOIN role r ON r.id = pr.role_id LEFT JOIN branch b ON b.id = pr.branch_id
               WHERE pr.person_id = p.id) AS roles,
             (SELECT string_agg(CASE WHEN pp.effect = 'grant' THEN '+ ' ELSE '- ' END || pp.permission_id, ', ' ORDER BY pp.permission_id)
                FROM person_permission pp WHERE pp.person_id = p.id) AS access
      FROM person p LEFT JOIN user_credential uc ON uc.person_id = p.id
      ORDER BY p.full_name`.execute(app.db)
    ).rows;
    const columns: Column[] = [
      { heading: 'Name', kind: 'text' },
      { heading: 'Sign-in email', kind: 'text' },
      { heading: 'Phone', kind: 'text' },
      { heading: 'Roles (branch)', kind: 'text' },
      { heading: 'Access beyond or short of role', kind: 'text' },
      { heading: 'Active', kind: 'yesno' },
      { heading: 'Last sign-in', kind: 'text' },
      { heading: 'Added on', kind: 'date' },
    ];
    const out: Cell[][] = rows.map((r) => [
      r['full_name'] as string,
      (r['login_email'] as string | null) ?? '',
      (r['phone'] as string | null) ?? '',
      (r['roles'] as string | null) ?? '',
      (r['access'] as string | null) ?? '',
      r['is_active'] as boolean,
      (r['last_login'] as string | null) ?? '',
      r['added_on'] as string,
    ]);
    return { title: 'Staff', columns, rows: out, note: 'No passwords or sign-in secrets are ever exported.' };
  }

  const BUILD = { items, suppliers, customers, 'price-lists': priceLists, staff } as const;

  app.get('/exports/:kind', { onRequest: [app.requirePermission('data.export')] }, async (request) => {
    const { kind } = parseParams(params, request.params);
    const { format } = parseQuery(query, request.query);
    if (!has(request, READ_PERMISSION[kind])) throw new NotPermitted(READ_PERMISSION[kind]);

    const tz = await businessTimezone(app.db);
    const result = await BUILD[kind](request, tz);
    const scope = scopedBranchIds(request);

    await app.db
      .insertInto('audit_log')
      .values({
        event_id: crypto.randomUUID(),
        action_code: 'RECORDS_EXPORTED',
        actor_id: request.user!.personId,
        terminal_id: null,
        branch_id: null,
        entity_type: 'export',
        entity_id: null,
        state_before: null,
        state_after: JSON.stringify({ export: kind, title: result.title, rows: result.rows.length, format, branches: scope ?? 'all' }),
        occurred_at: new Date(),
      })
      .execute();

    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return { kind, ...result, fileName: `${kind}-${day}`, generatedAt: new Date().toISOString() };
  });
}
