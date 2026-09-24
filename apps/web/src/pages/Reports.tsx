/**
 * Reports: sales, purchases, and general stock activity, by period.
 *
 * One screen rather than three separate report pages, because "sales
 * report", "purchases report" and "product history" (the client's own three
 * names) are the same ledger sliced by reason and period - the API already
 * returns all three in one call (reports.ts), so splitting them into
 * separate pages would only mean three loading spinners for one answer.
 *
 * Deliberately no dollar figure next to units sold: this system has never
 * recorded a selling price, only a cost, so "revenue" is not a number it can
 * produce honestly. Purchases DO show real cost, because Receive posts a
 * real unit cost. The Dashboard already draws this same line; this follows
 * it rather than quietly inventing a number.
 */

import { useMemo, useState } from 'react';

import { api, type MovementReport, type Product } from '../lib/api.js';
import { Button, Card, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

type Preset = 'today' | 'week' | 'month' | 'year' | 'custom';
type GroupBy = MovementReport['groupBy'];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Calendar ranges in the browser's own local time - "today" means today here, not in UTC. */
function presetRange(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const to = ymd(now);
  if (preset === 'today') return { from: to, to };
  if (preset === 'week') {
    const sinceMonday = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - sinceMonday);
    return { from: ymd(monday), to };
  }
  if (preset === 'month') {
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }
  return { from: ymd(new Date(now.getFullYear(), 0, 1)), to };
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

export function Reports() {
  const [preset, setPreset] = useState<Preset>('month');
  const initial = presetRange('month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [branchId, setBranchId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [product, setProduct] = useState<Product | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const categories = useAsync(() => api.categories(), []);
  const productResults = useAsync(
    () =>
      productSearch.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search: productSearch, limit: 8 }),
    [productSearch],
  );

  const report = useAsync(
    () =>
      api.reportMovements({
        from,
        to,
        groupBy,
        ...(branchId === '' ? {} : { branchId }),
        ...(categoryId === '' ? {} : { categoryId }),
        ...(product === null ? {} : { productId: product.id }),
      }),
    [from, to, groupBy, branchId, categoryId, product],
  );

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === 'custom') return;
    const range = presetRange(p);
    setFrom(range.from);
    setTo(range.to);
    setGroupBy(p === 'year' ? 'month' : 'day');
  }

  const branchLabel = branches.data?.find((b) => b.id === branchId)?.name ?? 'All branches';

  const exportLabel = useMemo(() => `${from}_to_${to}`, [from, to]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Sales (in units), purchases (in cost), and stock activity for any period - pick a preset
          or choose your own dates.
        </p>
      </div>

      <Card className="px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => applyPreset(p.value)}
                className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition ${
                  preset === p.value
                    ? 'bg-ink-900 text-white'
                    : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <>
              <Field label="From">
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                />
              </Field>
            </>
          )}

          <Field label="Group by">
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </Field>

          <Field label="Branch">
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
          </Field>

          <Field label="Category">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="relative">
            <Field label="Product history for">
              {product === null ? (
                <input
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="All products…"
                  className="border-ink-200 focus:border-accent-500 w-48 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                />
              ) : (
                <span className="border-ink-200 flex w-48 items-center justify-between gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px]">
                  <span className="truncate">{product.name}</span>
                  <button
                    onClick={() => {
                      setProduct(null);
                      setProductSearch('');
                    }}
                    className="text-ink-400 hover:text-red-600 shrink-0"
                  >
                    ✕
                  </button>
                </span>
              )}
            </Field>
            {product === null && productSearch.trim() !== '' && (
              <div className="border-ink-100 absolute left-0 z-10 mt-1 max-h-52 w-[min(16rem,calc(100vw-2rem))] divide-y overflow-y-auto rounded-lg border bg-white shadow-lg">
                {(productResults.data?.items ?? []).length === 0 ? (
                  <p className="text-ink-400 px-3 py-2 text-[12px]">No match.</p>
                ) : (
                  (productResults.data?.items ?? []).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setProduct(p);
                        setProductSearch('');
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
        </div>
      </Card>

      {report.error !== undefined && <ErrorNote error={report.error} />}

      {report.loading ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : report.data === undefined ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Units sold" value={qty(report.data.summary.unitsSold)} />
            <SummaryCard
              label="Received"
              value={qty(report.data.summary.unitsReceived)}
              sub={money(report.data.summary.costReceived)}
            />
            <SummaryCard
              label="Transferred"
              value={`${qty(report.data.summary.unitsTransferredIn)} in`}
              sub={`${qty(report.data.summary.unitsTransferredOut)} out`}
            />
            <SummaryCard
              label="Written off / adjusted"
              value={qty(report.data.summary.unitsWrittenOff)}
              sub={`${report.data.summary.unitsAdjustedNet >= 0 ? '+' : ''}${qty(report.data.summary.unitsAdjustedNet)} net count adj.`}
            />
          </div>

          <Card className="overflow-hidden">
            <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">
                By {report.data.groupBy} · {branchLabel}
              </h2>
              <Button
                onClick={() =>
                  downloadCsv(
                    `report_${exportLabel}.csv`,
                    [
                      report.data!.groupBy,
                      'units sold',
                      'units received',
                      'cost received',
                      'transferred out',
                      'transferred in',
                      'written off',
                      'adjusted (net)',
                    ],
                    report.data!.buckets.map((b) => [
                      b.bucket,
                      b.unitsSold,
                      b.unitsReceived,
                      b.costReceived,
                      b.unitsTransferredOut,
                      b.unitsTransferredIn,
                      b.unitsWrittenOff,
                      b.unitsAdjustedNet,
                    ]),
                  )
                }
                disabled={report.data.buckets.length === 0}
              >
                Download CSV
              </Button>
            </div>
            {report.data.buckets.length === 0 ? (
              <p className="text-ink-400 px-4 py-6 text-center text-[12px]">
                No activity in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-ink-400 border-ink-100 border-b text-[10.5px] font-medium uppercase tracking-wider">
                      <th className="px-4 py-2 text-left">{report.data.groupBy}</th>
                      <th className="px-3 py-2 text-right">Sold</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="px-3 py-2 text-right">Cost received</th>
                      <th className="px-3 py-2 text-right">Transfers</th>
                      <th className="px-3 py-2 text-right">Written off</th>
                      <th className="px-4 py-2 text-right">Adjusted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {report.data.buckets.map((b) => (
                      <tr key={b.bucket}>
                        <td className="px-4 py-1.5 font-medium">{b.bucket}</td>
                        <td className="tnum px-3 py-1.5 text-right">{qty(b.unitsSold)}</td>
                        <td className="tnum px-3 py-1.5 text-right">{qty(b.unitsReceived)}</td>
                        <td className="tnum px-3 py-1.5 text-right">{money(b.costReceived)}</td>
                        <td className="tnum text-ink-500 px-3 py-1.5 text-right">
                          {qty(b.unitsTransferredIn)} in / {qty(b.unitsTransferredOut)} out
                        </td>
                        <td className="tnum px-3 py-1.5 text-right">{qty(b.unitsWrittenOff)}</td>
                        <td className="tnum px-4 py-1.5 text-right">{qty(b.unitsAdjustedNet)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">
                {product !== null ? 'This product' : 'Most active products'}
              </h2>
              <Button
                onClick={() =>
                  downloadCsv(
                    `report_by_product_${exportLabel}.csv`,
                    ['SKU', 'Product', 'units sold', 'units received', 'cost received', 'written off'],
                    report.data!.byProduct.map((p) => [
                      p.sku,
                      p.productName,
                      p.unitsSold,
                      p.unitsReceived,
                      p.costReceived,
                      p.unitsWrittenOff,
                    ]),
                  )
                }
                disabled={report.data.byProduct.length === 0}
              >
                Download CSV
              </Button>
            </div>
            {report.data.byProduct.length === 0 ? (
              <p className="text-ink-400 px-4 py-6 text-center text-[12px]">
                No product activity in this period.
              </p>
            ) : (
              <ul className="divide-ink-100 divide-y">
                {report.data.byProduct.map((p) => (
                  <li
                    key={p.productId}
                    className="flex flex-col gap-1 px-4 py-2.5 text-[12.5px] sm:flex-row sm:items-center sm:gap-3 sm:py-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{p.productName}</span>
                    {/* sm:contents drops this wrapper from the box model at sm+, so its
                        children fall back into a single dense row exactly like before -
                        below sm, it stays a normal flex row of its own underneath the name. */}
                    <div className="text-ink-400 flex items-center justify-between gap-3 font-mono text-[11px] sm:contents">
                      <span className="sm:w-20 sm:shrink-0 sm:text-right">{p.sku}</span>
                      <span className="tnum sm:w-20 sm:shrink-0 sm:text-right sm:text-[12.5px] text-red-600">
                        -{qty(p.unitsSold)}
                      </span>
                      <span className="tnum sm:w-20 sm:shrink-0 sm:text-right sm:text-[12.5px] text-accent-700">
                        +{qty(p.unitsReceived)}
                      </span>
                      <span className="text-ink-500 tnum sm:w-24 sm:shrink-0 sm:text-right sm:text-[12.5px]">
                        {money(p.costReceived)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">{label}</div>
      <div className="tnum mt-1 text-[20px] font-semibold tracking-tight">{value}</div>
      {sub !== undefined && <div className="text-ink-400 mt-0.5 text-[11.5px]">{sub}</div>}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
        {label}
      </span>
      {children}
    </label>
  );
}
