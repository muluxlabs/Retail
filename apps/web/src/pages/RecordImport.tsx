/**
 * Importing customers or suppliers from a spreadsheet — one screen, two uses.
 *
 * Download the template, upload the filled file (Excel or CSV) or paste rows,
 * check the preview (new, already on file, look-alikes, problem rows), import.
 * Look-alikes are only created when ticked "Create anyway". The report, row by
 * row, stays on the screen.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, type RecordImportCheck, type RecordImportResult } from '../lib/api.js';
import { downloadCsv } from '../lib/csv.js';
import { CUSTOMER_TEMPLATE, parseDelimited, readSpreadsheet, SUPPLIER_TEMPLATE, writeTemplate, type TemplateDef } from '../lib/spreadsheet.js';
import { Badge, Button, Card, Spinner, money } from '../lib/ui.js';

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface Kind {
  noun: string;
  nouns: string;
  back: { to: string; label: string };
  template: TemplateDef;
  check: (b: { headings: string[]; rows: Record<string, string>[] }) => Promise<RecordImportCheck>;
  run: (b: { id: string; fileName: string | null; headings: string[]; rows: Record<string, string>[]; confirmSimilar: string[] }) => Promise<RecordImportResult>;
  /** A line describing one record in the preview. */
  describe: (r: Record<string, unknown>) => string;
  identity: string;
}

const KINDS: Record<'customers' | 'suppliers', Kind> = {
  customers: {
    noun: 'customer',
    nouns: 'customers',
    back: { to: '/customers', label: 'Customers' },
    template: CUSTOMER_TEMPLATE,
    check: api.checkCustomerImport,
    run: api.importCustomers,
    describe: (r) =>
      [r['phone'], Number(r['creditLimit']) > 0 ? `credit ${money(Number(r['creditLimit']))}, ${r['creditDays']} days` : 'cash only'].filter(Boolean).join(' · '),
    identity: 'A customer whose phone number is already on file is skipped; the same name with another phone, or a near-identical name, needs you to confirm.',
  },
  suppliers: {
    noun: 'supplier',
    nouns: 'suppliers',
    back: { to: '/suppliers', label: 'Suppliers' },
    template: SUPPLIER_TEMPLATE,
    check: api.checkSupplierImport,
    run: api.importSuppliers,
    describe: (r) =>
      [
        r['terms'] === 'credit' ? `credit, ${r['creditDays']} days` : r['terms'] === 'cash_on_delivery' ? 'cash on delivery' : 'prepaid',
        r['tin'] ? `TIN ${r['tin']}` : null,
        r['phone'],
      ]
        .filter(Boolean)
        .join(' · '),
    identity: 'A supplier already on file — same name, or same tax number — is skipped; a near-identical name needs you to confirm.',
  },
};

export function RecordImport({ kind }: { kind: 'customers' | 'suppliers' }) {
  const k = KINDS[kind];
  const [loaded, setLoaded] = useState<{ fileName: string | null; headings: string[]; rows: Record<string, string>[] } | null>(null);
  const [check, setCheck] = useState<RecordImportCheck | null>(null);
  const [anyway, setAnyway] = useState<Set<string>>(new Set());
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<RecordImportResult | null>(null);

  async function load(l: { fileName: string | null; headings: string[]; rows: Record<string, string>[] }) {
    setBusy(true);
    setError(null);
    setDone(null);
    setCheck(null);
    try {
      if (l.rows.length === 0) throw new Error('The file has no rows under its heading row.');
      setLoaded(l);
      setCheck(await k.check({ headings: l.headings, rows: l.rows }));
      setAnyway(new Set());
      setId(crypto.randomUUID());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (loaded === null) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await k.run({ id, fileName: loaded.fileName, headings: loaded.headings, rows: loaded.rows, confirmSimilar: [...anyway] }));
      setCheck(null);
      setLoaded(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function downloadProblems() {
    if (loaded === null || check === null) return;
    const byRow = new Map<number, string[]>();
    for (const p of check.problems) byRow.set(p.row, [...(byRow.get(p.row) ?? []), `${p.column === null ? '' : `${p.column}: `}${p.message}`]);
    const rows = [...byRow.keys()].filter((r) => r > 1).sort((a, b) => a - b);
    downloadCsv(`${k.nouns}-to-fix.csv`, [...loaded.headings, 'Problem'], rows.map((r) => [...loaded.headings.map((h) => loaded.rows[r - 2]?.[h] ?? ''), byRow.get(r)!.join(' | ')]));
  }

  const s = check?.summary;
  const fresh = check?.records.filter((r) => r.status === 'new') ?? [];
  const similar = check?.records.filter((r) => r.status === 'similar') ?? [];
  const existing = check?.records.filter((r) => r.status === 'exists') ?? [];
  const toCreate = fresh.length + similar.filter((r) => anyway.has(r.key)).length;

  return (
    <div className="space-y-4">
      <div className="text-ink-400 text-[12px]">
        <Link to={k.back.to} className="hover:text-ink-700 hover:underline">
          {k.back.label}
        </Link>{' '}
        / Import
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Import {k.nouns} from a spreadsheet</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          One row per {k.noun}, from Excel or CSV. Nothing is saved until you have checked the preview. {k.identity}
        </p>
      </div>

      <Card className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void writeTemplate(k.template)}>Download Excel template</Button>
          <Button onClick={() => downloadCsv(`${k.template.fileName}.csv`, k.template.columns.map((c) => c.heading), k.template.columns[0]!.examples.map((_, i) => k.template.columns.map((c) => c.examples[i] ?? '')))}>
            Download CSV template
          </Button>
          <span className="text-ink-400 text-[12px]">Needed: {k.template.columns.filter((c) => c.required).map((c) => c.heading).join(', ')}. Everything else is optional.</span>
        </div>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Excel (.xlsx) or CSV file</span>
          <input
            type="file"
            accept=".xlsx,.csv,.txt,.tsv"
            aria-label={`${k.noun} spreadsheet`}
            className="text-[12.5px]"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f !== undefined) void readSpreadsheet(f).then((sh) => load({ fileName: f.name, ...sh }), (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
          />
        </label>
        <details>
          <summary className="text-accent-700 cursor-pointer text-[12.5px] font-medium">…or paste rows copied from a spreadsheet</summary>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} aria-label="Pasted rows" placeholder="Copy the rows including the heading row, then paste here." className="border-ink-200 focus:border-accent-500 mt-2 w-full rounded-lg border bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none" />
          <Button className="mt-2" onClick={() => void load({ fileName: null, ...parseDelimited(paste) })} disabled={paste.trim() === '' || busy}>
            Check the pasted rows
          </Button>
        </details>
        {busy && check === null && (
          <div className="text-ink-500 flex items-center gap-2 text-[12.5px]">
            <Spinner /> Checking every row…
          </div>
        )}
        {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      </Card>

      {check !== null && s !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="record-summary">
            {(
              [
                ['Rows read', s.rows, ''],
                [`New ${k.nouns}`, s.new, 'text-accent-700'],
                ['Already on file', s.existing, 'text-ink-500'],
                ['Look like ones on file', s.similar, s.similar > 0 ? 'text-amber-700' : ''],
                ['Rows with problems', s.problemRows, s.problemRows > 0 ? 'text-red-700' : ''],
              ] as const
            ).map(([t, v, tone]) => (
              <Card key={t} className="px-3 py-2.5">
                <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">{t}</div>
                <div className={`tnum mt-0.5 text-xl font-semibold ${tone}`}>{v.toLocaleString()}</div>
              </Card>
            ))}
          </div>

          {check.problems.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight text-red-800">Rows that will be left out ({s.problemRows})</h2>
                <Button onClick={downloadProblems}>Download these rows to fix</Button>
              </div>
              <ul className="max-h-60 divide-y overflow-auto text-[12.5px]" data-testid="record-problems">
                {check.problems.slice(0, 300).map((p, i) => (
                  <li key={i} className="divide-ink-100 px-4 py-1.5">
                    <span className="text-ink-400">Row {p.row}</span>
                    {p.column !== null && <span className="font-medium"> · {p.column}</span>} — {p.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {similar.length > 0 && (
            <Card className="overflow-hidden border-amber-200" data-testid="record-similar">
              <div className="border-ink-100 border-b bg-amber-50/60 px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight text-amber-900">Look like {k.nouns} already on file ({similar.length})</h2>
                <p className="text-[12px] text-amber-900/80">Left out unless you tick <b>Create anyway</b>.</p>
              </div>
              <ul className="divide-ink-100 divide-y">
                {similar.map((r) => (
                  <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[12.5px]">
                    <span>
                      <b>{String(r.record['name'])}</b> <span className="text-ink-400">row {String(r.record['row'])}</span> — {r.reason}
                    </span>
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={anyway.has(r.key)}
                        onChange={() =>
                          setAnyway((prev) => {
                            const n = new Set(prev);
                            if (n.has(r.key)) n.delete(r.key);
                            else n.add(r.key);
                            return n;
                          })
                        }
                        aria-label={`Create ${String(r.record['name'])} anyway`}
                      />
                      Create anyway
                    </label>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="border-ink-100 border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">
                New {k.nouns} ({fresh.length.toLocaleString()})
              </h2>
            </div>
            <ul className="divide-ink-100 max-h-80 divide-y overflow-auto text-[12.5px]" data-testid="record-new">
              {fresh.slice(0, 300).map((r) => (
                <li key={r.key} className="px-4 py-1.5">
                  <b>{String(r.record['name'])}</b> <span className="text-ink-500">{k.describe(r.record)}</span>
                </li>
              ))}
              {fresh.length === 0 && <li className="text-ink-400 px-4 py-3">Nothing new.</li>}
            </ul>
          </Card>

          {existing.length > 0 && (
            <details className="rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
              <summary className="cursor-pointer text-[13px] font-semibold tracking-tight">Already on file — skipped ({existing.length})</summary>
              <ul className="text-ink-600 mt-2 space-y-0.5 text-[12.5px]">
                {existing.slice(0, 300).map((r) => (
                  <li key={r.key}>
                    Row {String(r.record['row'])}: <b>{String(r.record['name'])}</b> — {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Card className="flex flex-wrap items-center gap-3 px-4 py-4">
            <Button variant="primary" onClick={() => void run()} disabled={busy || toCreate === 0}>
              {busy ? <Spinner /> : null}
              Import {plural(toCreate, k.noun, k.nouns)}
            </Button>
            <span className="text-ink-500 text-[12.5px]">All created together, or none are.</span>
          </Card>
        </>
      )}

      {done?.report != null && (
        <Card className="overflow-hidden" data-testid="record-report">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Imported: {plural(done.created, k.noun, k.nouns)} created
              {done.existing + done.similarSkipped + done.problemRows > 0 && `, ${plural(done.existing + done.similarSkipped + done.problemRows, 'row')} left out`}
            </h2>
          </div>
          <div className="grid gap-4 px-4 py-3 lg:grid-cols-3">
            <div>
              <div className="text-accent-700 mb-1 text-[12px] font-semibold">Created ({done.report.created.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.created.map((c) => (
                  <li key={c.code}>
                    {c.name} <Badge tone="neutral">{c.code}</Badge>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-ink-600 mb-1 text-[12px] font-semibold">Already on file ({done.report.existing.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.existing.map((c) => (
                  <li key={c.row}>
                    Row {c.row}: {c.name} <span className="text-ink-500">— {c.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[12px] font-semibold text-amber-800">Look-alikes left out ({done.report.similarSkipped.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.similarSkipped.map((c) => (
                  <li key={c.row}>
                    Row {c.row}: {c.name} <span className="text-ink-500">— {c.reason}</span>
                  </li>
                ))}
              </ul>
              {done.problemRows > 0 && <p className="mt-2 text-[12px] text-red-700">{plural(done.problemRows, 'row')} had problems.</p>}
            </div>
          </div>
        </Card>
      )}
      {done !== null && done.report === null && (
        <Card className="px-4 py-3 text-[13px]" data-testid="record-replayed">
          <div className="font-semibold">This import was already done.</div>
          <div className="text-ink-600 mt-0.5">
            It was saved the first time you pressed Import (the reply was lost on the way back): {plural(done.created, k.noun, k.nouns)} created
            {done.existing > 0 && `, ${plural(done.existing, 'row')} already on file`}
            {done.similarSkipped > 0 && `, ${plural(done.similarSkipped, 'look-alike')} left out`}
            {done.problemRows > 0 && `, ${plural(done.problemRows, 'row')} with problems`}. Nothing was added twice.
          </div>
        </Card>
      )}
      {done !== null && (
        <Link to={k.back.to} className="text-accent-700 inline-block text-[13px] font-medium hover:underline">
          Back to {k.back.label.toLowerCase()}
        </Link>
      )}
    </div>
  );
}
