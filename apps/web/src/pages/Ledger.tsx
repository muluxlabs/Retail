/**
 * The stock ledger, in the form an accountant reads it.
 *
 * Three views of the same append-only movements:
 *
 *   Stock ledger          one product at one branch: opening balance b/f,
 *                         dated receipts and issues with a running balance,
 *                         closing balance c/f, and proof it agrees to stock
 *                         on hand. The bin card / stores ledger.
 *   Stock reconciliation  every product at a branch on one page: opening +
 *                         receipts - issues = closing, against stock on hand.
 *   Transaction log       the raw movements, newest first, with the late-
 *                         recording gap shown.
 *
 * An experienced auditor could not read the previous version of this screen,
 * because "opening balance" appeared in it as an ordinary row - a movement
 * dated whenever stock was loaded - instead of the balance at the start of a
 * period. Here an opening balance is always computed from everything before
 * the period, and the movement that introduced stock is named for what it is.
 *
 * Every term comes from lib/terms.ts, not from a database value with the
 * underscores removed.
 */

import { useState } from 'react';

import {
  api,
  type ReconciliationLine,
  type StockLedger,
  type StockReconciliation,
} from '../lib/api.js';
import { downloadCsv } from '../lib/csv.js';
import { docType, LEDGER_GLOSSARY, stockReason } from '../lib/terms.js';
import { Badge, Button, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

type Tab = 'ledger' | 'reconciliation' | 'log';
type Preset = 'month' | 'lastMonth' | 'year' | 'custom';

const TABS: { value: Tab; label: string }[] = [
  { value: 'ledger', label: 'Stock ledger' },
  { value: 'reconciliation', label: 'Stock reconciliation' },
  { value: 'log', label: 'Transaction log' },
];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rangeFor(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  if (preset === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (preset === 'lastMonth') {
    return {
      from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: ymd(now) };
}

/** Dates are the ledger's own (UTC) calendar day, so the date shown is the date the period maths used. */
const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

const fmtDay = (ymdStr: string): string => fmtDate(`${ymdStr}T00:00:00Z`);

interface Selection {
  branchId: string;
  product: { id: string; name: string; sku: string } | null;
}

export function Ledger() {
  const [tab, setTab] = useState<Tab>('ledger');
  const [selection, setSelection] = useState<Selection>({ branchId: '', product: null });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Stock ledger</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Append-only. Nothing here is ever edited or deleted; a correction is a new entry that
          reverses the old one.
        </p>
      </div>

      <div className="no-print flex flex-wrap items-center gap-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
              tab === t.value ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <details className="no-print border-ink-200/80 rounded-xl border bg-white px-4 py-2.5 text-[12.5px]">
        <summary className="text-ink-600 cursor-pointer font-medium">How to read this ledger</summary>
        <dl className="mt-3 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {LEDGER_GLOSSARY.map((g) => (
            <div key={g.term}>
              <dt className="font-medium">{g.term}</dt>
              <dd className="text-ink-500 mt-0.5">{g.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>

      {tab === 'ledger' && <BinCard selection={selection} onSelect={setSelection} />}
      {tab === 'reconciliation' && (
        <Reconciliation
          branchId={selection.branchId}
          onBranch={(branchId) => setSelection((s) => ({ ...s, branchId }))}
          onOpen={(product) => {
            setSelection((s) => ({ ...s, product }));
            setTab('ledger');
          }}
        />
      )}
      {tab === 'log' && <TransactionLog />}
    </div>
  );
}

// -- shared controls -----------------------------------------------------------

function PeriodPicker({
  preset,
  from,
  to,
  onChange,
}: {
  preset: Preset;
  from: string;
  to: string;
  onChange: (p: { preset: Preset; from: string; to: string }) => void;
}) {
  const options: { value: Preset; label: string }[] = [
    { value: 'month', label: 'This month' },
    { value: 'lastMonth', label: 'Last month' },
    { value: 'year', label: 'This year' },
    { value: 'custom', label: 'Custom' },
  ];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex items-center gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() =>
              onChange(o.value === 'custom' ? { preset: 'custom', from, to } : { preset: o.value, ...rangeFor(o.value) })
            }
            className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition ${
              preset === o.value ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <>
          <DateField label="From" value={from} onChange={(v) => onChange({ preset, from: v, to })} />
          <DateField label="To" value={to} onChange={(v) => onChange({ preset, from, to: v })} />
        </>
      )}
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
      />
    </label>
  );
}

function BranchSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const branches = useAsync(() => api.branches(), []);
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Branch</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
      >
        <option value="">Select a branch…</option>
        {(branches.data ?? []).map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The proof line an auditor looks for: it foots, and it agrees to what the system says is on hand. */
function ProofLine({
  opening,
  receipts,
  issues,
  closing,
  agrees,
  onHand,
}: {
  opening: number;
  receipts: number;
  issues: number;
  closing: number;
  agrees: boolean | null;
  onHand: number;
}) {
  return (
    <div className="border-ink-100 bg-ink-50/60 flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-3 text-[12.5px]">
      <span className="tnum">
        {qty(opening)} <span className="text-ink-400">opening</span> + {qty(receipts)}{' '}
        <span className="text-ink-400">receipts</span> − {qty(issues)} <span className="text-ink-400">issues</span> ={' '}
        <span className="font-semibold">{qty(closing)}</span> <span className="text-ink-400">closing</span>
      </span>
      {agrees === true && (
        <Badge tone="good">✓ Agrees to stock on hand ({qty(onHand)})</Badge>
      )}
      {agrees === false && (
        <Badge tone="bad">✗ Does not agree to stock on hand ({qty(onHand)}) - investigate</Badge>
      )}
      {agrees === null && (
        <span className="text-ink-400 text-[11.5px]">
          Period ended in the past, so there is no current figure to agree it to.
        </span>
      )}
    </div>
  );
}

// -- 1. the stock ledger (bin card) ----------------------------------------------

function BinCard({ selection, onSelect }: { selection: Selection; onSelect: (s: Selection) => void }) {
  const initial = rangeFor('month');
  const [period, setPeriod] = useState<{ preset: Preset; from: string; to: string }>({ preset: 'month', ...initial });
  const [search, setSearch] = useState('');

  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );

  const ledger = useAsync(
    () =>
      selection.branchId !== '' && selection.product !== null
        ? api.stockLedger({
            branchId: selection.branchId,
            productId: selection.product.id,
            from: period.from,
            to: period.to,
          })
        : Promise.resolve(null),
    [selection.branchId, selection.product?.id, period.from, period.to],
  );

  return (
    <div className="space-y-4">
      <Card className="no-print px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <BranchSelect value={selection.branchId} onChange={(branchId) => onSelect({ ...selection, branchId })} />

          <div className="relative">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Product</span>
            {selection.product === null ? (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or SKU…"
                className="border-ink-200 focus:border-accent-500 w-64 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
              />
            ) : (
              <span className="border-ink-200 flex w-64 items-center justify-between gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px]">
                <span className="truncate">{selection.product.name}</span>
                <button
                  onClick={() => {
                    onSelect({ ...selection, product: null });
                    setSearch('');
                  }}
                  className="text-ink-400 hover:text-red-600 shrink-0"
                  aria-label="Choose a different product"
                >
                  ✕
                </button>
              </span>
            )}
            {selection.product === null && search.trim() !== '' && (
              <div className="border-ink-100 absolute left-0 z-10 mt-1 max-h-52 w-[min(20rem,calc(100vw-2rem))] divide-y overflow-y-auto rounded-lg border bg-white shadow-lg">
                {(results.data?.items ?? []).length === 0 ? (
                  <p className="text-ink-400 px-3 py-2 text-[12px]">No match.</p>
                ) : (
                  (results.data?.items ?? []).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        onSelect({ ...selection, product: { id: p.id, name: p.name, sku: p.sku } });
                        setSearch('');
                      }}
                      className="hover:bg-ink-50 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px]"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-ink-400 shrink-0 font-mono text-[11px]">{p.sku}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <PeriodPicker {...period} onChange={setPeriod} />
        </div>
      </Card>

      {ledger.error !== undefined && <ErrorNote error={ledger.error} />}

      {selection.branchId === '' || selection.product === null ? (
        <Card className="px-4 py-10">
          <Empty title="Choose a branch and a product" hint="The ledger shows one product at one branch, the way a bin card does." />
        </Card>
      ) : ledger.data === undefined || ledger.data === null ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <LedgerBody l={ledger.data} loading={ledger.loading} />
      )}
    </div>
  );
}

function LedgerBody({ l, loading }: { l: StockLedger; loading: boolean }) {
  return (
    <Card className={`overflow-hidden transition-opacity ${loading ? 'opacity-50' : ''}`}>
      <div className="border-ink-100 flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight">
            {l.product.name} <span className="text-ink-400 font-mono text-[11.5px] font-normal">{l.product.sku}</span>
          </h2>
          <p className="text-ink-500 text-[12px]">
            {l.branch.name} · {fmtDay(l.from)} to {fmtDay(l.to)} · quantities in {l.product.baseUom}
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <Button
            onClick={() =>
              downloadCsv(
                `stock_ledger_${l.product.sku}_${l.branch.code}_${l.from}_to_${l.to}.csv`,
                ['Date', 'Document', 'Description', 'Receipts', 'Issues', 'Balance', 'Unit cost', 'Entered by'],
                [
                  [fmtDay(l.from), '', 'Opening balance b/f', '', '', l.opening, '', ''],
                  ...l.rows.map((r) => [
                    fmtDate(r.occurredAt),
                    r.reference ?? docType(r.docType) ?? '',
                    stockReason(r.reason).label,
                    r.qtyIn || '',
                    r.qtyOut || '',
                    r.balance,
                    r.unitCost ?? '',
                    r.actorName ?? '',
                  ]),
                  [fmtDay(l.to), '', 'Closing balance c/f', l.receipts, l.issues, l.closing, '', ''],
                ],
              )
            }
          >
            Download CSV
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-left font-medium">Document</th>
              <th className="px-3 py-2 text-left font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Receipts</th>
              <th className="px-3 py-2 text-right font-medium">Issues</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
              <th className="px-3 py-2 text-right font-medium">Unit cost</th>
              <th className="px-4 py-2 text-left font-medium">Entered by</th>
            </tr>
          </thead>
          <tbody className="divide-ink-100 divide-y">
            <tr className="bg-ink-50/70 font-semibold">
              <td className="px-4 py-2 whitespace-nowrap">{fmtDay(l.from)}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">Opening balance b/f</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              <td className={`tnum px-3 py-2 text-right ${l.opening < 0 ? 'text-red-700' : ''}`}>{qty(l.opening)}</td>
              <td className="px-3 py-2" />
              <td className="px-4 py-2" />
            </tr>

            {l.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-ink-400 px-4 py-5 text-center text-[12px]">
                  No entries in this period.
                </td>
              </tr>
            )}

            {l.rows.map((r) => {
              const term = stockReason(r.reason);
              return (
                <tr key={r.seq} className="hover:bg-ink-50/60">
                  <td className="px-4 py-1.5 whitespace-nowrap">{fmtDate(r.occurredAt)}</td>
                  <td className="text-ink-600 px-3 py-1.5">
                    {r.reference !== null ? (
                      <span className="font-mono text-[11.5px]">{r.reference}</span>
                    ) : (
                      (docType(r.docType) ?? <span className="text-ink-300">—</span>)
                    )}
                  </td>
                  <td className="px-3 py-1.5" title={term.meaning}>
                    {term.label}
                    {r.lateHours > 48 && (
                      <span className="ml-1.5">
                        <Badge tone="warn">recorded {Math.round(r.lateHours / 24)}d late</Badge>
                      </span>
                    )}
                  </td>
                  <td className="tnum px-3 py-1.5 text-right">{r.qtyIn > 0 ? qty(r.qtyIn) : ''}</td>
                  <td className="tnum px-3 py-1.5 text-right">{r.qtyOut > 0 ? qty(r.qtyOut) : ''}</td>
                  <td className={`tnum px-3 py-1.5 text-right font-medium ${r.balance < 0 ? 'text-red-700' : ''}`}>
                    {qty(r.balance)}
                  </td>
                  <td className="tnum text-ink-500 px-3 py-1.5 text-right">
                    {r.unitCost === null ? '—' : money(Number(r.unitCost))}
                  </td>
                  <td className="text-ink-500 px-4 py-1.5">{r.actorName ?? '—'}</td>
                </tr>
              );
            })}

            <tr className="border-ink-200 border-t-2 font-semibold">
              <td className="px-4 py-2 whitespace-nowrap">{fmtDay(l.to)}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">Closing balance c/f</td>
              <td className="tnum px-3 py-2 text-right">{qty(l.receipts)}</td>
              <td className="tnum px-3 py-2 text-right">{qty(l.issues)}</td>
              <td className={`tnum px-3 py-2 text-right ${l.closing < 0 ? 'text-red-700' : ''}`}>{qty(l.closing)}</td>
              <td className="px-3 py-2" />
              <td className="px-4 py-2" />
            </tr>
          </tbody>
        </table>
      </div>

      <ProofLine
        opening={l.opening}
        receipts={l.receipts}
        issues={l.issues}
        closing={l.closing}
        agrees={l.agreesToStockOnHand}
        onHand={l.onHandNow}
      />
    </Card>
  );
}

// -- 2. the reconciliation schedule -------------------------------------------------

function Reconciliation({
  branchId,
  onBranch,
  onOpen,
}: {
  branchId: string;
  onBranch: (id: string) => void;
  onOpen: (product: { id: string; name: string; sku: string }) => void;
}) {
  const initial = rangeFor('month');
  const [period, setPeriod] = useState<{ preset: Preset; from: string; to: string }>({ preset: 'month', ...initial });
  const [search, setSearch] = useState('');

  const recon = useAsync(
    () =>
      branchId === ''
        ? Promise.resolve(null)
        : api.stockReconciliation({
            branchId,
            from: period.from,
            to: period.to,
            ...(search.trim() === '' ? {} : { search: search.trim() }),
            limit: 500,
          }),
    [branchId, period.from, period.to, search],
  );

  return (
    <div className="space-y-4">
      <Card className="no-print px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <BranchSelect value={branchId} onChange={onBranch} />
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Product</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or SKU…"
              className="border-ink-200 focus:border-accent-500 w-56 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>
          <PeriodPicker {...period} onChange={setPeriod} />
        </div>
      </Card>

      {recon.error !== undefined && <ErrorNote error={recon.error} />}

      {branchId === '' ? (
        <Card className="px-4 py-10">
          <Empty title="Choose a branch" hint="The schedule lists every product at the branch, one line each." />
        </Card>
      ) : recon.data === undefined || recon.data === null ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <ReconciliationBody r={recon.data} loading={recon.loading} onOpen={onOpen} />
      )}
    </div>
  );
}

function ReconciliationBody({
  r,
  loading,
  onOpen,
}: {
  r: StockReconciliation;
  loading: boolean;
  onOpen: (product: { id: string; name: string; sku: string }) => void;
}) {
  const disagree = r.lines.filter((l) => l.agreesToStockOnHand === false).length;

  return (
    <Card className={`overflow-hidden transition-opacity ${loading ? 'opacity-50' : ''}`}>
      <div className="border-ink-100 flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight">Stock reconciliation - {r.branch.name}</h2>
          <p className="text-ink-500 text-[12px]">
            {fmtDay(r.from)} to {fmtDay(r.to)} · {r.lines.length} product{r.lines.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <Button
            onClick={() =>
              downloadCsv(
                `stock_reconciliation_${r.branch.code}_${r.from}_to_${r.to}.csv`,
                ['SKU', 'Product', 'Unit', 'Opening balance b/f', 'Purchases', 'Transfers in', 'Transfers out', 'Sales', 'Opening stock introduced', 'Adjustments', 'Closing balance c/f', 'Stock on hand', 'Difference'],
                r.lines.map((l) => [
                  l.sku,
                  l.productName,
                  l.baseUom,
                  l.opening,
                  l.purchases,
                  l.transfersIn,
                  l.transfersOut,
                  l.sales,
                  l.openingStock,
                  l.adjustments,
                  l.closing,
                  l.onHand,
                  r.reachesToday ? Number((l.closing - l.onHand).toFixed(4)) : '',
                ]),
              )
            }
            disabled={r.lines.length === 0}
          >
            Download CSV
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      {r.lines.length === 0 ? (
        <Empty title="No stock or movements at this branch in this period" />
      ) : (
        <>
          <div className="border-ink-100 flex flex-wrap items-center gap-2 border-b px-4 py-2.5 text-[12.5px]">
            {r.allBalanced ? (
              <Badge tone="good">✓ Every line foots (opening + each movement = closing)</Badge>
            ) : (
              <Badge tone="bad">✗ Some lines do not foot - investigate</Badge>
            )}
            {r.reachesToday ? (
              disagree === 0 ? (
                <Badge tone="good">✓ Every closing balance agrees to stock on hand</Badge>
              ) : (
                <Badge tone="bad">
                  ✗ {disagree} product{disagree === 1 ? '' : 's'} do not agree to stock on hand
                </Badge>
              )
            ) : (
              <span className="text-ink-400 text-[11.5px]">
                Period ended in the past: closing balances are historical, so there is no current stock figure to agree them to.
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                  <th className="px-4 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Opening b/f</th>
                  <th className="px-3 py-2 text-right font-medium">Purchases</th>
                  <th className="px-3 py-2 text-right font-medium">Transfers in</th>
                  <th className="px-3 py-2 text-right font-medium">Transfers out</th>
                  <th className="px-3 py-2 text-right font-medium">Sales</th>
                  <th className="px-3 py-2 text-right font-medium">Opening stock introduced</th>
                  <th className="px-3 py-2 text-right font-medium">Adjustments</th>
                  <th className="px-3 py-2 text-right font-medium">Closing c/f</th>
                  {r.reachesToday && <th className="px-3 py-2 text-right font-medium">On hand</th>}
                  {r.reachesToday && <th className="px-4 py-2 text-right font-medium">Difference</th>}
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {r.lines.map((l) => (
                  <Line key={l.productId} l={l} reachesToday={r.reachesToday} onOpen={onOpen} />
                ))}
              </tbody>
            </table>
          </div>
          {r.lines.length >= r.limit && (
            <p className="text-ink-400 border-ink-100 border-t px-4 py-2 text-[11.5px]">
              Showing the first {r.limit} products. Narrow the search to see the rest.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Line({
  l,
  reachesToday,
  onOpen,
}: {
  l: ReconciliationLine;
  reachesToday: boolean;
  onOpen: (product: { id: string; name: string; sku: string }) => void;
}) {
  const diff = Number((l.closing - l.onHand).toFixed(4));
  return (
    <tr className="hover:bg-ink-50/60">
      <td className="px-4 py-1.5">
        <button
          onClick={() => onOpen({ id: l.productId, name: l.productName, sku: l.sku })}
          className="hover:text-accent-700 text-left font-medium hover:underline"
          title="Open this product's stock ledger"
        >
          {l.productName}
        </button>
        <div className="text-ink-400 font-mono text-[10.5px]">
          {l.sku} · {l.baseUom}
        </div>
      </td>
      <td className="tnum px-3 py-1.5 text-right">{qty(l.opening)}</td>
      <Move v={l.purchases} />
      <Move v={l.transfersIn} />
      <Move v={l.transfersOut} />
      <Move v={l.sales} />
      <Move v={l.openingStock} />
      <Move v={l.adjustments} />
      <td className={`tnum px-3 py-1.5 text-right font-medium ${l.closing < 0 ? 'text-red-700' : ''}`}>{qty(l.closing)}</td>
      {reachesToday && <td className="tnum text-ink-500 px-3 py-1.5 text-right">{qty(l.onHand)}</td>}
      {reachesToday && (
        <td className={`tnum px-4 py-1.5 text-right ${diff === 0 ? 'text-ink-300' : 'font-semibold text-red-700'}`}>
          {diff === 0 ? '—' : qty(diff)}
        </td>
      )}
    </tr>
  );
}

/** A movement column: nothing shown for zero, a sign for everything else, so the row reads as a sum. */
function Move({ v }: { v: number }) {
  return (
    <td className="tnum px-3 py-1.5 text-right">
      {v === 0 ? <span className="text-ink-300">—</span> : `${v > 0 ? '+' : '−'}${qty(Math.abs(v))}`}
    </td>
  );
}

// -- 3. the transaction log -------------------------------------------------------------

function TransactionLog() {
  const [branchId, setBranchId] = useState('');
  const movements = useAsync(
    () => api.movements({ ...(branchId === '' ? {} : { branchId }), limit: 200 }),
    [branchId],
  );
  const branches = useAsync(() => api.branches(), []);
  const items = movements.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">All branches</option>
          {(branches.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <span className="text-ink-400 text-[12px]">The 200 most recent entries, newest first.</span>
      </div>

      {movements.error !== undefined && <ErrorNote error={movements.error} />}

      <Card className="overflow-hidden">
        {movements.loading && movements.data === undefined ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No entries" hint="Purchases, sales, transfers and stock take adjustments all appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                  <th className="px-4 py-2 text-left font-medium">Entry no.</th>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Branch</th>
                  <th className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-right font-medium">Recorded late</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((m) => {
                  const term = stockReason(m.reason);
                  return (
                    <tr key={m.seq} className="hover:bg-ink-50/60">
                      <td className="text-ink-300 tnum px-4 py-2 font-mono text-[11px]">{m.seq}</td>
                      <td className="px-3 py-2">
                        <div className="max-w-56 truncate font-medium">{m.productName}</div>
                        <div className="text-ink-400 font-mono text-[10.5px]">{m.sku}</div>
                      </td>
                      <td className="text-ink-600 px-3 py-2">{m.branchCode}</td>
                      <td className={`tnum px-3 py-2 text-right font-medium ${m.qtyBase < 0 ? 'text-ink-900' : 'text-ink-900'}`}>
                        {m.qtyBase > 0 ? '+' : '−'}
                        {qty(Math.abs(m.qtyBase))}
                      </td>
                      <td className="tnum text-ink-500 px-3 py-2 text-right">
                        {m.unitCost === null ? '—' : money(Number(m.unitCost))}
                      </td>
                      <td className="text-ink-600 px-3 py-2" title={term.meaning}>
                        {term.label}
                        {m.reversesSeq !== null && <Badge tone="info">reverses {m.reversesSeq}</Badge>}
                      </td>
                      <td className="text-ink-500 px-3 py-2 whitespace-nowrap">{fmtDate(m.occurredAt)}</td>
                      <td className="px-4 py-2 text-right">
                        {Number(m.backdateGapHours) > 48 ? (
                          <Badge tone="warn">{Math.round(Number(m.backdateGapHours) / 24)}d late</Badge>
                        ) : (
                          <span className="text-ink-300 text-[11px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
