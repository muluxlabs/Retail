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
import {
  BarList,
  ChartCard,
  Delta,
  KpiTile,
  MiniTable,
  SeriesChart,
  VIZ,
} from '../lib/charts.js';
import {
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  bucketHeading,
  fillBuckets,
  bucketLabel,
  pctChange,
} from '../lib/chartMath.js';
import { Button, Card, Empty, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

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

/**
 * The stretch of time of the same length immediately before [from, to], for
 * "vs the previous period". Null for a range too long to be worth comparing.
 * Done in UTC calendar days so a viewer's time zone cannot move a boundary.
 */
function previousRange(from: string, to: string): { from: string; to: string; days: number } | null {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === undefined || fm === undefined || fd === undefined) return null;
  if (ty === undefined || tm === undefined || td === undefined) return null;
  const DAY = 86_400_000;
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  const days = Math.round((b - a) / DAY) + 1;
  if (!(days >= 1 && days <= 400)) return null;
  const prevTo = a - DAY;
  const prevFrom = prevTo - (days - 1) * DAY;
  return {
    from: new Date(prevFrom).toISOString().slice(0, 10),
    to: new Date(prevTo).toISOString().slice(0, 10),
    days,
  };
}

/** "27%" - one decimal under 10%, none above, so small shares are not rounded to nothing. */
const share = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '—';

/** The biggest few, and everything else folded into one honest "Other". */
function foldTail(rows: { key: string; label: string; value: number }[], keep: number) {
  if (rows.length <= keep + 1) return rows;
  const rest = rows.slice(keep).reduce((sum, r) => sum + r.value, 0);
  return [...rows.slice(0, keep), { key: '__other', label: `Other (${rows.length - keep})`, value: rest }];
}

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

  // The same slice over the period just before, so a tile can say whether a
  // number is moving. Grouped by year purely to keep that response small - only
  // its summary is read.
  const prevRange = useMemo(() => previousRange(from, to), [from, to]);
  const previous = useAsync(
    () =>
      prevRange === null
        ? Promise.resolve(null)
        : api.reportMovements({
            from: prevRange.from,
            to: prevRange.to,
            groupBy: 'year',
            ...(branchId === '' ? {} : { branchId }),
            ...(categoryId === '' ? {} : { categoryId }),
            ...(product === null ? {} : { productId: product.id }),
          }),
    [prevRange?.from, prevRange?.to, branchId, categoryId, product],
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
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => applyPreset(p.value)}
                className={`rounded-lg px-2 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition sm:px-2.5 ${
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

      {report.data === undefined ? (
        report.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : null
      ) : (
        <ReportBody
          data={report.data}
          previous={previous.data ?? null}
          prevDays={prevRange?.days ?? 0}
          loading={report.loading}
          branchLabel={branchLabel}
          exportLabel={exportLabel}
          singleProduct={product !== null}
        />
      )}
    </div>
  );
}

function ReportBody({
  data,
  previous,
  prevDays,
  loading,
  branchLabel,
  exportLabel,
  singleProduct,
}: {
  data: MovementReport;
  previous: MovementReport | null;
  prevDays: number;
  loading: boolean;
  branchLabel: string;
  exportLabel: string;
  singleProduct: boolean;
}) {
  const s = data.summary;
  const kind = data.groupBy;
  // The API omits periods with no movements; the chart, sparklines and table
  // need them back as zeros or the line bridges the gaps.
  const buckets = fillBuckets(data.buckets, data.from, data.to, kind, (bucket) => ({
    bucket,
    unitsSold: 0,
    unitsReceived: 0,
    costReceived: 0,
    unitsTransferredOut: 0,
    unitsTransferredIn: 0,
    unitsWrittenOff: 0,
    unitsAdjustedNet: 0,
  }));
  const versus = prevDays === 1 ? 'than the day before' : `than the ${prevDays} days before`;

  const net =
    s.unitsReceived +
    s.unitsTransferredIn -
    s.unitsTransferredOut -
    s.unitsSold -
    s.unitsWrittenOff +
    s.unitsAdjustedNet;

  // -- the cuts, each ranked and trimmed for its chart ---------------------------
  const topSold = data.topSellers.map((p) => ({
    key: p.productId,
    label: p.productName,
    hint: p.sku,
    value: p.unitsSold,
  }));

  const soldOnly = <T extends { unitsSold: number }>(rows: T[]) =>
    rows.filter((r) => r.unitsSold > 0).sort((x, y) => y.unitsSold - x.unitsSold);

  const branchRows = soldOnly(data.byBranch).map((b) => ({
    key: b.branchId,
    label: b.branchName,
    value: b.unitsSold,
  }));
  const categoryRows = foldTail(
    soldOnly(data.byCategory).map((c) => ({ key: c.categoryName, label: c.categoryName, value: c.unitsSold })),
    7,
  );

  // Monday..Sunday, always seven columns: a weekday with no sales is a real
  // zero, not a gap the reader has to notice is missing.
  const weekdays = WEEKDAY_NAMES.map((name, i) => {
    const row = data.byWeekday.find((w) => w.weekday === i + 1);
    return {
      name,
      short: WEEKDAY_SHORT[i] ?? name,
      sold: row?.unitsSold ?? 0,
      received: row?.unitsReceived ?? 0,
    };
  });
  const weekdaysWithSales = weekdays.filter((w) => w.sold > 0);
  const busiest = weekdays.reduce((best, w) => (w.sold > best.sold ? w : best), weekdays[0]!);

  const top5 = topSold.slice(0, 5).reduce((sum, r) => sum + r.value, 0);
  const leader = branchRows[0];
  const bestSeller = topSold[0];

  return (
    <div className="space-y-4">
      <div className={`grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-4 ${loading ? 'opacity-50' : ''}`}>
        <KpiTile
          label="Units sold"
          value={qty(s.unitsSold)}
          spark={{ values: buckets.map((b) => b.unitsSold), color: VIZ.sold }}
          delta={
            previous === null ? undefined : (
              <Delta pct={pctChange(s.unitsSold, previous.summary.unitsSold)} upIsGood={true} versus={versus} />
            )
          }
        />
        <KpiTile
          label="Units received"
          value={qty(s.unitsReceived)}
          spark={{ values: buckets.map((b) => b.unitsReceived), color: VIZ.received }}
          delta={
            previous === null ? undefined : (
              <Delta
                pct={pctChange(s.unitsReceived, previous.summary.unitsReceived)}
                upIsGood={null}
                versus={versus}
              />
            )
          }
        />
        <KpiTile
          label="Cost received"
          value={money(s.costReceived)}
          spark={{ values: buckets.map((b) => b.costReceived), color: VIZ.received }}
          delta={
            previous === null ? undefined : (
              <Delta
                pct={pctChange(s.costReceived, previous.summary.costReceived)}
                upIsGood={null}
                versus={versus}
              />
            )
          }
        />
        <KpiTile
          label="Net stock change"
          value={`${net > 0 ? '+' : ''}${qty(net)}`}
          sub="Received − sold − written off, ± transfers and counts"
        />
      </div>

      <ChartCard
        title="Sold and received over time"
        subtitle={`By ${kind} · ${branchLabel}`}
        loading={loading}
        empty={data.buckets.length === 0 ? <Empty title="No activity in this period" /> : undefined}
        actions={
          <Button
            onClick={() =>
              downloadCsv(
                `report_${exportLabel}.csv`,
                [
                  kind,
                  'units sold',
                  'units received',
                  'cost received',
                  'transferred out',
                  'transferred in',
                  'written off',
                  'adjusted (net)',
                ],
                buckets.map((b) => [
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
            disabled={data.buckets.length === 0}
          >
            Download CSV
          </Button>
        }
        chart={
          <SeriesChart
            ariaLabel={`Units sold and received by ${kind}`}
            series={[
              { key: 'sold', label: 'Sold', color: VIZ.sold },
              { key: 'received', label: 'Received', color: VIZ.received },
            ]}
            points={buckets.map((b) => ({
              label: bucketLabel(b.bucket, kind),
              heading: bucketHeading(b.bucket, kind),
              values: [b.unitsSold, b.unitsReceived],
            }))}
            height={260}
          />
        }
        table={
          <MiniTable
            head={[kind, 'Sold', 'Received', 'Cost received', 'Transfers in', 'Transfers out', 'Written off', 'Adjusted']}
            rows={buckets.map((b) => [
              bucketHeading(b.bucket, kind),
              b.unitsSold,
              b.unitsReceived,
              money(b.costReceived),
              b.unitsTransferredIn,
              b.unitsTransferredOut,
              b.unitsWrittenOff,
              b.unitsAdjustedNet,
            ])}
          />
        }
      />

      {!singleProduct && (
        <section aria-labelledby="stands-out">
          <h2 id="stands-out" className="text-ink-500 mb-2 text-[11px] font-medium uppercase tracking-wider">
            What stands out
          </h2>
          <div className={`grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-4 ${loading ? 'opacity-50' : ''}`}>
            <KpiTile
              label="Busiest weekday"
              value={weekdaysWithSales.length >= 2 ? busiest.name : '—'}
              sub={
                weekdaysWithSales.length >= 2
                  ? `${share(busiest.sold, s.unitsSold)} of units sold`
                  : 'Needs sales on more than one weekday'
              }
            />
            <KpiTile
              label="Best-selling product"
              value={bestSeller?.label ?? '—'}
              sub={
                bestSeller === undefined
                  ? 'No sales in this period'
                  : `${share(bestSeller.value, s.unitsSold)} of units sold`
              }
            />
            <KpiTile
              label="Top five products"
              value={topSold.length > 0 ? share(top5, s.unitsSold) : '—'}
              sub={topSold.length > 0 ? 'of all units sold' : 'No sales in this period'}
            />
            <KpiTile
              label="Leading branch"
              value={branchRows.length >= 2 && leader !== undefined ? leader.label : '—'}
              sub={
                branchRows.length >= 2 && leader !== undefined
                  ? `${share(leader.value, s.unitsSold)} of units sold`
                  : 'Needs sales at more than one branch'
              }
            />
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {!singleProduct && (
          <ChartCard
            title="Top sellers"
            subtitle="Units sold"
            loading={loading}
            empty={topSold.length === 0 ? <Empty title="No sales in this period" /> : undefined}
            chart={<BarList color={VIZ.sold} rows={topSold.slice(0, 8)} format={qty} />}
          />
        )}

        <ChartCard
          title="Sales by weekday"
          subtitle="Units sold - the busiest day in colour"
          loading={loading}
          empty={weekdaysWithSales.length === 0 ? <Empty title="No sales in this period" /> : undefined}
          chart={
            <SeriesChart
              ariaLabel="Units sold by day of the week"
              series={[{ key: 'sold', label: 'Sold', color: VIZ.sold }]}
              points={weekdays.map((w) => ({ label: w.short, heading: w.name, values: [w.sold] }))}
              kind="column"
              emphasizeMax
              height={320}
            />
          }
          table={
            <MiniTable
              head={['Weekday', 'Sold', 'Received']}
              rows={weekdays.map((w) => [w.name, w.sold, w.received])}
            />
          }
        />
      </div>

      {(branchRows.length > 1 || categoryRows.length > 1) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {branchRows.length > 1 && (
            <ChartCard
              title="Sales by branch"
              subtitle="Units sold"
              loading={loading}
              chart={<BarList color={VIZ.sold} rows={branchRows} format={qty} />}
            />
          )}
          {categoryRows.length > 1 && (
            <ChartCard
              title="Sales by category"
              subtitle="Units sold"
              loading={loading}
              chart={<BarList color={VIZ.sold} rows={categoryRows} format={qty} />}
            />
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">
            {singleProduct ? 'This product' : 'Most active products'}
          </h2>
          <Button
            onClick={() =>
              downloadCsv(
                `report_by_product_${exportLabel}.csv`,
                ['SKU', 'Product', 'units sold', 'units received', 'cost received', 'written off'],
                data.byProduct.map((p) => [
                  p.sku,
                  p.productName,
                  p.unitsSold,
                  p.unitsReceived,
                  p.costReceived,
                  p.unitsWrittenOff,
                ]),
              )
            }
            disabled={data.byProduct.length === 0}
          >
            Download CSV
          </Button>
        </div>
        {data.byProduct.length === 0 ? (
          <p className="text-ink-400 px-4 py-6 text-center text-[12px]">No product activity in this period.</p>
        ) : (
          <ul className="divide-ink-100 divide-y">
            {data.byProduct.map((p) => (
              <li
                key={p.productId}
                className="flex flex-col gap-1 px-4 py-2.5 text-[12.5px] sm:flex-row sm:items-center sm:gap-3 sm:py-2"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{p.productName}</span>
                {/* sm:contents drops this wrapper from the box model at sm+, so its
                    children fall back into a single dense row - below sm, it stays a
                    normal flex row of its own underneath the name. */}
                <div className="text-ink-400 grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4.75rem] items-center gap-2 font-mono text-[11px] sm:contents">
                  <span className="truncate sm:w-20 sm:shrink-0 sm:text-right">{p.sku}</span>
                  <span className="tnum text-ink-800 text-right sm:w-20 sm:shrink-0 sm:text-[12.5px]">
                    -{qty(p.unitsSold)}
                  </span>
                  <span className="tnum text-ink-800 text-right sm:w-20 sm:shrink-0 sm:text-[12.5px]">
                    +{qty(p.unitsReceived)}
                  </span>
                  <span className="text-ink-500 tnum text-right sm:w-24 sm:shrink-0 sm:text-[12.5px]">
                    {money(p.costReceived)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
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
