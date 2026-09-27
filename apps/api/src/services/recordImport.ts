/**
 * Importing customers and suppliers from a spreadsheet: check each row against
 * what is already on file, then create the new ones in one transaction.
 *
 *   new      nothing like it on file: created.
 *   exists   certainly on file already: a customer with the same phone (or the
 *            same name when no phone is given); a supplier with the same name
 *            or tax number. Never created.
 *   similar  a near-identical name (a spelling difference), or the same name
 *            with a different phone: created only if the importer ticks
 *            "create anyway".
 *
 * An import is identified by the id the client made; sending it again returns
 * the first result. Customers given credit are raised for review in one
 * exception for the whole import.
 */

import { nameIndex, parseCustomerRows, parseSupplierRows, phoneKey, type RowProblem } from '@retail-ops/domain';
import type { Database } from '@retail-ops/db';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type Db = Kysely<Database>;
type Tx = Transaction<Database>;

export interface Checked<R> {
  record: R;
  key: string;
  status: 'new' | 'exists' | 'similar';
  reason: string | null;
  similarTo: { name: string; code: string; score: number; row: number | null }[];
}

export interface RecordCheck<R> {
  records: Checked<R>[];
  problems: RowProblem[];
  columns: { heading: string; field: string | null }[];
  summary: { rows: number; new: number; existing: number; similar: number; problemRows: number };
}

function summarise<R>(rows: Record<string, string>[], records: Checked<R>[], problems: RowProblem[]) {
  return {
    rows: rows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== '')).length,
    new: records.filter((r) => r.status === 'new').length,
    existing: records.filter((r) => r.status === 'exists').length,
    similar: records.filter((r) => r.status === 'similar').length,
    problemRows: new Set(problems.filter((p) => p.row > 1).map((p) => p.row)).size,
  };
}

// ---- customers ---------------------------------------------------------------------------------------------------

type CustomerRec = ReturnType<typeof parseCustomerRows>['records'][number];

export async function checkCustomers(db: Db | Tx, rows: Record<string, string>[], headings: string[]): Promise<RecordCheck<CustomerRec>> {
  const parsed = parseCustomerRows(rows, headings);
  const onFile = (await sql<{ id: string; code: string; name: string; phone: string | null }>`SELECT id, code, name, phone FROM customer`.execute(db)).rows;
  const byPhone = new Map(onFile.filter((c) => c.phone !== null).map((c) => [phoneKey(c.phone!), c]));
  const ix = nameIndex(onFile.map((c) => ({ id: c.id, name: c.name, sku: c.code })));
  const fileIx = nameIndex<{ id: string; name: string; sku: string | null; row: number }>([]);
  const records = parsed.records.map((r): Checked<CustomerRec> => {
    const key = `row-${r.row}`;
    const done = (status: Checked<CustomerRec>['status'], reason: string | null, similarTo: Checked<CustomerRec>['similarTo'] = []) => {
      if (status !== 'exists') fileIx.add({ id: key, name: r.name, sku: null, row: r.row });
      return { record: r, key, status, reason, similarTo };
    };
    const samePhone = r.phoneKey === null ? undefined : byPhone.get(r.phoneKey);
    if (samePhone !== undefined) return done('exists', `phone ${r.phone} is already ${samePhone.name} (${samePhone.code})`);
    const sameName = ix.same(r.name);
    if (sameName.length > 0 && r.phoneKey === null) return done('exists', `already on file as ${sameName[0]!.name} (${sameName[0]!.sku})`);
    const alike = [
      ...sameName.map((x) => ({ name: x.name, code: x.sku ?? '', score: 1, row: null })),
      ...ix.alike(r.name).map((h) => ({ name: h.item.name, code: h.item.sku ?? '', score: h.score, row: null })),
      ...fileIx.same(r.name).map((h) => ({ name: h.name, code: '', score: 1, row: h.row })),
      ...fileIx.alike(r.name).map((h) => ({ name: h.item.name, code: '', score: h.score, row: h.item.row })),
    ].slice(0, 3);
    if (alike.length > 0) {
      const t = alike[0]!;
      return done('similar', t.row === null ? `looks like ${t.name} (${t.code})${t.score === 1 ? ', with another phone' : ''}` : `looks like ${t.name} on row ${t.row}`, alike);
    }
    return done('new', null);
  });
  return { records, problems: parsed.problems, columns: parsed.columns, summary: summarise(rows, records, parsed.problems) };
}

// ---- suppliers ----------------------------------------------------------------------------------------------------

type SupplierRec = ReturnType<typeof parseSupplierRows>['records'][number];

export async function checkSuppliers(db: Db | Tx, rows: Record<string, string>[], headings: string[]): Promise<RecordCheck<SupplierRec>> {
  const parsed = parseSupplierRows(rows, headings);
  const onFile = (await sql<{ id: string; code: string; name: string; tin: string | null }>`SELECT id, code, name, tin FROM supplier`.execute(db)).rows;
  const byName = new Map(onFile.map((s) => [s.name.toLowerCase(), s]));
  const byTin = new Map(onFile.filter((s) => s.tin !== null && s.tin !== '').map((s) => [s.tin!.replace(/\s/g, ''), s]));
  const ix = nameIndex(onFile.map((s) => ({ id: s.id, name: s.name, sku: s.code })));
  const fileIx = nameIndex<{ id: string; name: string; sku: string | null; row: number }>([]);
  const records = parsed.records.map((r): Checked<SupplierRec> => {
    const key = `row-${r.row}`;
    const done = (status: Checked<SupplierRec>['status'], reason: string | null, similarTo: Checked<SupplierRec>['similarTo'] = []) => {
      if (status !== 'exists') fileIx.add({ id: key, name: r.name, sku: null, row: r.row });
      return { record: r, key, status, reason, similarTo };
    };
    const same = byName.get(r.name.toLowerCase()) ?? ix.same(r.name).map((x) => onFile.find((s) => s.id === x.id)!)[0];
    if (same !== undefined) return done('exists', `already on file as ${same.name} (${same.code})`);
    const sameTin = r.tin === null ? undefined : byTin.get(r.tin);
    if (sameTin !== undefined) return done('exists', `tax number ${r.tin} is already ${sameTin.name} (${sameTin.code})`);
    const alike = [
      ...ix.alike(r.name).map((h) => ({ name: h.item.name, code: h.item.sku ?? '', score: h.score, row: null })),
      ...fileIx.alike(r.name).map((h) => ({ name: h.item.name, code: '', score: h.score, row: h.item.row })),
    ].slice(0, 3);
    if (alike.length > 0) {
      const t = alike[0]!;
      return done('similar', t.row === null ? `looks like ${t.name} (${t.code})` : `looks like ${t.name} on row ${t.row}`, alike);
    }
    return done('new', null);
  });
  return { records, problems: parsed.problems, columns: parsed.columns, summary: summarise(rows, records, parsed.problems) };
}

// ---- importing -------------------------------------------------------------------------------------------------------

export interface RecordImportResult {
  id: string;
  created: number;
  existing: number;
  similarSkipped: number;
  problemRows: number;
  replayed: boolean;
  report: null | {
    created: { name: string; code: string; row: number }[];
    existing: { name: string; row: number; reason: string }[];
    similarSkipped: { name: string; row: number; reason: string }[];
  };
}

async function replayOf(db: Db | Tx, id: string): Promise<RecordImportResult | undefined> {
  const r = await db.selectFrom('audit_log').select(['state_after']).where('event_id', '=', id).executeTakeFirst();
  if (r === undefined) return undefined;
  const a = (typeof r.state_after === 'string' ? JSON.parse(r.state_after) : r.state_after) as Record<string, number>;
  return { id, created: a['created'] ?? 0, existing: a['existing'] ?? 0, similarSkipped: a['similarSkipped'] ?? 0, problemRows: a['problemRows'] ?? 0, replayed: true, report: null };
}

export async function importCustomers(
  db: Db,
  input: { id: string; fileName: string | null; rows: Record<string, string>[]; headings: string[]; confirmSimilar: string[]; actorId: string; actorBranchId: string | null },
): Promise<RecordImportResult> {
  const done = await replayOf(db, input.id);
  if (done !== undefined) return done;
  try {
    return await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('customer-import', 0))`.execute(tx);
    const check = await checkCustomers(tx, input.rows, input.headings);
    const ok = new Set(input.confirmSimilar);
    const make = check.records.filter((r) => r.status === 'new' || (r.status === 'similar' && ok.has(r.key)));
    const at = new Date();
    const created: { name: string; code: string; row: number; limit: number }[] = [];
    for (const c of make) {
      const r = c.record;
      const row = await tx
        .insertInto('customer')
        .values({
          name: r.name, phone: r.phone, email: r.email, address: r.address, id_number: r.idNumber, credit_limit: r.creditLimit,
          credit_days: r.creditDays, notes: r.notes, created_by: input.actorId,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();
      created.push({ name: r.name, code: row.code, row: r.row, limit: r.creditLimit });
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(), action_code: 'CUSTOMER_ADDED', actor_id: input.actorId, terminal_id: null, branch_id: input.actorBranchId,
          entity_type: 'customer', entity_id: row.id, state_before: null,
          state_after: JSON.stringify({ name: r.name, phone: r.phone, creditLimit: r.creditLimit, via: `import ${input.fileName ?? 'pasted rows'}`, ...(c.status === 'similar' ? { createdAlthough: c.reason } : {}) }),
          occurred_at: at,
        })
        .execute();
    }
    // Credit given in bulk is one decision to review: one exception for the whole import.
    const credited = created.filter((c) => c.limit > 0);
    if (credited.length > 0) {
      const branch = input.actorBranchId ?? (await tx.selectFrom('branch').select('id').where('is_active', '=', true).orderBy('code').executeTakeFirstOrThrow()).id;
      const total = credited.reduce((s, c) => s + c.limit, 0);
      await tx
        .insertInto('exception_event')
        .values({
          event_id: crypto.randomUUID(), kind: 'credit_limit_change', branch_id: branch, terminal_id: null, actor_id: input.actorId, product_id: null,
          detail: JSON.stringify({
            customer: `${credited.length} customer${credited.length === 1 ? '' : 's'} imported with credit`, from: 0, to: total,
            importId: input.id, examples: credited.slice(0, 5).map((c) => `${c.name}: ${c.limit.toFixed(2)}`),
          }),
          value_impact: total, currency: 'USD', occurred_at: at,
        })
        .execute();
    }
    const similarSkipped = check.records.filter((r) => r.status === 'similar' && !ok.has(r.key));
    const existing = check.records.filter((r) => r.status === 'exists');
    await tx
      .insertInto('audit_log')
      .values({
        event_id: input.id, action_code: 'CUSTOMERS_IMPORTED', actor_id: input.actorId, terminal_id: null, branch_id: input.actorBranchId,
        entity_type: 'customer_import', entity_id: input.id, state_before: null,
        state_after: JSON.stringify({ file: input.fileName, created: created.length, existing: existing.length, similarSkipped: similarSkipped.length, problemRows: check.summary.problemRows, credited: credited.length }),
        occurred_at: at,
      })
      .execute();
    return {
      id: input.id, created: created.length, existing: existing.length, similarSkipped: similarSkipped.length, problemRows: check.summary.problemRows, replayed: false,
      report: {
        created: created.map(({ name, code, row }) => ({ name, code, row })),
        existing: existing.map((r) => ({ name: r.record.name, row: r.record.row, reason: r.reason ?? '' })),
        similarSkipped: similarSkipped.map((r) => ({ name: r.record.name, row: r.record.row, reason: r.reason ?? '' })),
      },
    };
    });
  } catch (error) {
    // The same import sent twice at once: the second finds the first's record.
    const e = error as { code?: string } | null;
    if (e?.code === '23505') {
      const again = await replayOf(db, input.id);
      if (again !== undefined) return again;
    }
    throw error;
  }
}

export async function importSuppliers(
  db: Db,
  input: { id: string; fileName: string | null; rows: Record<string, string>[]; headings: string[]; confirmSimilar: string[]; actorId: string },
): Promise<RecordImportResult> {
  const done = await replayOf(db, input.id);
  if (done !== undefined) return done;
  try {
    return await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('supplier-import', 0))`.execute(tx);
    const check = await checkSuppliers(tx, input.rows, input.headings);
    const ok = new Set(input.confirmSimilar);
    const make = check.records.filter((r) => r.status === 'new' || (r.status === 'similar' && ok.has(r.key)));
    const at = new Date();
    const created: { name: string; code: string; row: number }[] = [];
    for (const s of make) {
      const r = s.record;
      const row = await tx
        .insertInto('supplier')
        .values({
          name: r.name, contact_person: r.contactPerson, phone: r.phone, email: r.email, address: r.address, tin: r.tin, terms: r.terms,
          credit_days: r.creditDays, notes: r.notes, created_by: input.actorId,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();
      created.push({ name: r.name, code: row.code, row: r.row });
      await tx
        .insertInto('audit_log')
        .values({
          event_id: crypto.randomUUID(), action_code: 'SUPPLIER_ADDED', actor_id: input.actorId, terminal_id: null, branch_id: null,
          entity_type: 'supplier', entity_id: row.id, state_before: null,
          state_after: JSON.stringify({ code: row.code, name: r.name, terms: r.terms, via: `import ${input.fileName ?? 'pasted rows'}`, ...(s.status === 'similar' ? { createdAlthough: s.reason } : {}) }),
          occurred_at: at,
        })
        .execute();
    }
    const similarSkipped = check.records.filter((r) => r.status === 'similar' && !ok.has(r.key));
    const existing = check.records.filter((r) => r.status === 'exists');
    await tx
      .insertInto('audit_log')
      .values({
        event_id: input.id, action_code: 'SUPPLIERS_IMPORTED', actor_id: input.actorId, terminal_id: null, branch_id: null,
        entity_type: 'supplier_import', entity_id: input.id, state_before: null,
        state_after: JSON.stringify({ file: input.fileName, created: created.length, existing: existing.length, similarSkipped: similarSkipped.length, problemRows: check.summary.problemRows }),
        occurred_at: at,
      })
      .execute();
    return {
      id: input.id, created: created.length, existing: existing.length, similarSkipped: similarSkipped.length, problemRows: check.summary.problemRows, replayed: false,
      report: {
        created,
        existing: existing.map((r) => ({ name: r.record.name, row: r.record.row, reason: r.reason ?? '' })),
        similarSkipped: similarSkipped.map((r) => ({ name: r.record.name, row: r.record.row, reason: r.reason ?? '' })),
      },
    };
    });
  } catch (error) {
    // The same import sent twice at once: the second finds the first's record.
    const e = error as { code?: string } | null;
    if (e?.code === '23505') {
      const again = await replayOf(db, input.id);
      if (again !== undefined) return again;
    }
    throw error;
  }
}
