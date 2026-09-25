/**
 * Sales and profit.
 *
 * The trading account of the business, for any period and any slice of it:
 *
 *   Total sales  -  Discounts  =  Net sales
 *   Net sales  -  Cost of sales  =  Gross profit        (gross margin = profit / net sales)
 *
 * Shown three ways at once - headline figures, a chart over time, and the
 * accountant's statement with the previous period beside it - because the
 * person reading it might be the owner glancing at a trend, or an auditor
 * tying a figure to a number. Every figure is drawn from the same report
 * response, so the chart, the tiles and the statement cannot disagree.
 *
 * A sale whose cost was never known is not free: it stays out of profit and
 * margin, and a banner says how much was left out.
 */

import { useEffect, useMemo, useState } from 'react';

import { ReportTabs } from '../components/ReportTabs.js';
import { api, type SalesStatement } from '../lib/api.js';
import { BarList, ChartCard, Delta, KpiTile, MiniTable, SeriesChart, VIZ, type SeriesPoint } from '../lib/charts.js';
import { bucketHeading, bucketKeys, bucketLabel, fillBuckets, pctChange } from '../lib/chartMath.js';
import { downloadCsv } from '../lib/csv.js';
import {
  PRESETS,
  daysBetween,
  defaultGrouping,
  describePeriod,
  hourKeys,
  hourLabel,
  rangeFor,
  type Grouping,
  type Preset,
} from '../lib/salesRange.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

const COLORS = { net: VIZ.sold, cost: VIZ.neutral, profit: VIZ.received } as const;

type Dimension = 'product' | 'category' | 'branch' | 'cashier';
type SortKey = 'net' | 'units' | 'cost' | 'grossProfit' | 'marginPercent' | 'receipts';

const pct = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}%`);

interface Filters {
  branchId: string;
  cashierId: string;
  categoryId: string;
  paymentTypeId: string;
  productId: string;
  fromHour: string;
  toHour: string;
}
const NO_FILTERS: Filters = { branchId: '', cashierId: '', categoryId: '', paymentTypeId: '', productId: '', fromHour: '', toHour: '' };

const empty = (): SalesStatement => ({
  receipts: 0, units: 0, gross: 0, discounts: 0, net: 0, cost: 0, grossProfit: 0,
  marginPercent: null, avgBasket: 0, uncostedNet: 0, uncostedLines: 0,
});

export function Profit() {
  const context = useAsync(() => api.businessToday(), []);
  const today = context.data?.today;

  const [preset, setPreset] = useState<Preset>('last7');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState<Grouping | 'auto'>('auto');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [dimension, setDimension] = useState<Dimension>('product');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'net', dir: -1 });
  const [cashiers, setCashiers] = useState<{ id: string; name: string }[]>([]);

  // Once the shop's "today" is known, land on the last seven days.
  useEffect(() => {
    if (today !== undefined && from === '') {
      const r = rangeFor('last7', today);
      setFrom(r.from);
      setTo(r.to);
    }
  }, [today, from]);

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom' && today !== undefined) {
      const r = rangeFor(p, today);
      setFrom(r.from);
      setTo(r.to);
    }
  }

  const branches = useAsync(() => api.branches(), []);
  const categories = useAsync(() => api.categories(), []);
  const paymentTypes = useAsync(() => api.paymentTypes(), []);

  const grouping: Grouping = groupBy === 'auto' ? (from === '' ? 'day' : defaultGrouping(from, to)) : groupBy;
  const validRange = from !== '' && to !== '' && to >= from && daysBetween(from, to) <= 400;

  const report = useAsync(
    () =>
      validRange
        ? api.salesReport({
            from,
            to,
            groupBy: grouping,
            ...(filters.branchId === '' ? {} : { branchId: filters.branchId }),
            ...(filters.cashierId === '' ? {} : { cashierId: filters.cashierId }),
            ...(filters.categoryId === '' ? {} : { categoryId: filters.categoryId }),
            ...(filters.productId === '' ? {} : { productId: filters.productId }),
            ...(filters.paymentTypeId === '' ? {} : { paymentTypeId: filters.paymentTypeId }),
            ...(filters.fromHour === '' ? {} : { fromHour: Number(filters.fromHour) }),
            ...(filters.toHour === '' ? {} : { toHour: Number(filters.toHour) }),
          })
        : Promise.resolve(undefined),
    [from, to, grouping, filters, validRange],
  );

  const r = report.data;

  // Remember who has cashed up in the period, so the cashier filter can offer them
  // even after one is chosen (a filtered response only contains that one).
  useEffect(() => {
    if (r !== undefined && filters.cashierId === '') {
      setCashiers(r.byCashier.map((c) => ({ id: c.cashierId, name: c.cashierName })));
    }
  }, [r, filters.cashierId]);

  const s = r?.summary ?? empty();
  const p = r?.previous ?? empty();
  const filtered = Object.values(filters).some((v) => v !== '');

  // -- the chart over time -----------------------------------------------------------------
  const points: SeriesPoint[] = useMemo(() => {
    if (r === undefined) return [];
    const zero = (bucket: string) => ({ ...empty(), bucket });
    const rows =
      grouping === 'hour'
        ? (() => {
            const byKey = new Map(r.series.map((x) => [x.bucket, x]));
            return hourKeys(r.period.from).map((k) => byKey.get(k) ?? zero(k));
          })()
        : fillBuckets(r.series, r.period.from, r.period.to, grouping, zero);
    return rows.map((x) => ({
      label: grouping === 'hour' ? x.bucket.slice(11) : bucketLabel(x.bucket, grouping),
      heading: grouping === 'hour' ? `${x.bucket.slice(0, 10)} ${x.bucket.slice(11)}` : bucketHeading(x.bucket, grouping),
      values: [x.net, x.cost, x.grossProfit],
    }));
  }, [r, grouping]);

  const hourPoints: SeriesPoint[] = useMemo(() => {
    if (r === undefined) return [];
    const byHour = new Map(r.byHour.map((h) => [h.hour, h]));
    const trading = r.byHour.map((h) => h.hour);
    if (trading.length === 0) return [];
    const lo = Math.max(0, Math.min(...trading) - 1);
    const hi = Math.min(23, Math.max(...trading) + 1);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((h) => ({
      label: hourLabel(h).slice(0, 2),
      heading: `${hourLabel(h)} to ${hourLabel(h).slice(0, 2)}:59`,
      values: [byHour.get(h)?.net ?? 0],
    }));
  }, [r]);

  // -- the breakdown table -----------------------------------------------------------------
  const rows = useMemo(() => {
    if (r === undefined) return [];
    const base =
      dimension === 'product'
        ? r.byProduct.map((x) => ({ key: x.productId, name: x.productName, hint: x.sku, ...x }))
        : dimension === 'category'
          ? r.byCategory.map((x) => ({ key: x.categoryName, name: x.categoryName, hint: '', ...x }))
          : dimension === 'branch'
            ? r.byBranch.map((x) => ({ key: x.branchId, name: x.branchName, hint: x.branchCode, ...x }))
            : r.byCashier.map((x) => ({ key: x.cashierId, name: x.cashierName, hint: '', ...x }));
    const val = (x: (typeof base)[number]): number => (x[sort.key] ?? -Infinity) as number;
    return [...base].sort((a, b) => (val(a) - val(b)) * sort.dir);
  }, [r, dimension, sort]);

  const pickFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  function drillInto(row: (typeof rows)[number]) {
    // Clicking a row narrows the whole screen to it - the natural "why is that number so high?".
    if (dimension === 'product') pickFilter({ productId: row.key });
    else if (dimension === 'branch') pickFilter({ branchId: row.key });
    else if (dimension === 'cashier') pickFilter({ cashierId: row.key });
    else {
      const c = (categories.data ?? []).find((x) => x.name === row.key);
      if (c !== undefined) pickFilter({ categoryId: c.id });
    }
  }

  function exportCsv() {
    if (r === undefined) return;
    downloadCsv(
      `sales-${dimension}-${r.period.from}-to-${r.period.to}.csv`,
      [dimension === 'product' ? 'Item' : dimension[0]!.toUpperCase() + dimension.slice(1), 'Receipts', 'Units', 'Net sales', 'Cost of sales', 'Gross profit', 'Margin %'],
      rows.map((x) => [x.name, x.receipts, x.units, x.net, x.cost, x.grossProfit, x.marginPercent ?? '']),
    );
  }

  const sortBy = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : '');

  const versus = r === undefined ? '' : `vs ${describePeriod(r.previousPeriod.from, r.previousPeriod.to)}`;
  const marginShift = s.marginPercent !== null && p.marginPercent !== null ? s.marginPercent - p.marginPercent : null;
  const noSales = r !== undefined && s.receipts === 0;

  const select =
    'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';

  return (
    <div className="space-y-4">
      <ReportTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Sales and profit</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            What was sold, what it cost, and what was left. Pick a period and narrow it by branch, cashier,
            category, payment method or time of day.
          </p>
        </div>
        <div className="no-print flex gap-2">
          <Button onClick={exportCsv} disabled={r === undefined || rows.length === 0}>
            Export CSV
          </Button>
          <Button onClick={() => window.print()} disabled={r === undefined}>
            Print
          </Button>
        </div>
      </div>

      {/* -- period and filters ---------------------------------------------------------- */}
      <Card className="no-print px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map((x) => (
            <button
              key={x.value}
              onClick={() => choose(x.value)}
              aria-pressed={preset === x.value}
              className={`rounded-lg px-2 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition sm:px-2.5 ${
                preset === x.value ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          {preset === 'custom' && (
            <>
              <label className="block">
                <span className="text-ink-500 mb-1 block text-[11px]">From</span>
                <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={select} />
              </label>
              <label className="block">
                <span className="text-ink-500 mb-1 block text-[11px]">To</span>
                <input type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} className={select} />
              </label>
            </>
          )}
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Chart by</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as Grouping | 'auto')} className={select} aria-label="Chart by">
              <option value="auto">Automatic</option>
              <option value="hour">Hour</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Branch</span>
            <select value={filters.branchId} onChange={(e) => pickFilter({ branchId: e.target.value })} className={select} aria-label="Branch">
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Cashier</span>
            <select value={filters.cashierId} onChange={(e) => pickFilter({ cashierId: e.target.value })} className={select} aria-label="Cashier">
              <option value="">All cashiers</option>
              {cashiers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Category</span>
            <select value={filters.categoryId} onChange={(e) => pickFilter({ categoryId: e.target.value })} className={select} aria-label="Category">
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Paid by</span>
            <select value={filters.paymentTypeId} onChange={(e) => pickFilter({ paymentTypeId: e.target.value })} className={select} aria-label="Payment method">
              <option value="">Any method</option>
              {(paymentTypes.data ?? []).filter((t) => t.atTill).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Time of day</span>
            <span className="flex items-center gap-1.5">
              <select value={filters.fromHour} onChange={(e) => pickFilter({ fromHour: e.target.value })} className={select} aria-label="From hour">
                <option value="">From</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              <span className="text-ink-400 text-[12px]">to</span>
              <select value={filters.toHour} onChange={(e) => pickFilter({ toHour: e.target.value })} className={select} aria-label="To hour">
                <option value="">Until</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h).slice(0, 2)}:59
                  </option>
                ))}
              </select>
            </span>
          </div>
          {filtered && (
            <Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          )}
        </div>

        {filters.productId !== '' && r !== undefined && (
          <div className="mt-3">
            <Badge tone="info">
              Item: {r.byProduct.find((x) => x.productId === filters.productId)?.productName ?? 'selected item'}
            </Badge>
          </div>
        )}
      </Card>

      {!validRange && from !== '' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900">
          Choose an end date on or after the start date, at most 400 days apart.
        </div>
      )}
      {report.error !== undefined && <ErrorNote error={report.error} />}

      {report.loading && r === undefined ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : r === undefined ? null : (
        <>
          <div className="text-ink-500 text-[12px]" data-testid="period">
            {describePeriod(r.period.from, r.period.to)} · {r.period.days} {r.period.days === 1 ? 'day' : 'days'} · times in {r.timezone}
            {filtered && ' · filtered'}
          </div>

          {/* -- headline figures ------------------------------------------------------------ */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="kpis">
            <KpiTile label="Total sales" value={money(s.gross)} sub="before discounts" delta={<Delta pct={pctChange(s.gross, p.gross)} upIsGood versus={versus} />} />
            <KpiTile label="Discounts" value={money(s.discounts)} sub="given at the till" delta={<Delta pct={pctChange(s.discounts, p.discounts)} upIsGood={false} versus={versus} />} />
            <KpiTile label="Net sales" value={money(s.net)} sub={`${s.receipts.toLocaleString()} receipts`} delta={<Delta pct={pctChange(s.net, p.net)} upIsGood versus={versus} />} />
            <KpiTile label="Cost of sales" value={money(s.cost)} sub="what the goods cost" delta={<Delta pct={pctChange(s.cost, p.cost)} upIsGood={null} versus={versus} />} />
            <KpiTile label="Gross profit" value={money(s.grossProfit)} sub="net sales less cost of sales" delta={<Delta pct={pctChange(s.grossProfit, p.grossProfit)} upIsGood versus={versus} />} />
            <KpiTile
              label="Gross margin"
              value={pct(s.marginPercent)}
              sub="profit as a share of net sales"
              delta={
                marginShift === null ? (
                  <span className="text-ink-400 text-[11.5px]">No earlier period to compare</span>
                ) : (
                  <span className={`text-[11.5px] font-medium ${marginShift < -0.05 ? 'text-red-700' : marginShift > 0.05 ? 'text-[var(--viz-good-text)]' : 'text-ink-500'}`}>
                    {marginShift > 0.05 ? '▲' : marginShift < -0.05 ? '▼' : '▬'} {Math.abs(marginShift).toFixed(1)} points{' '}
                    <span className="text-ink-400 font-normal">{versus}</span>
                  </span>
                )
              }
            />
          </div>

          {s.uncostedLines > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900" data-testid="uncosted">
              <span className="font-medium">{money(s.uncostedNet)} of these sales ({s.uncostedLines} {s.uncostedLines === 1 ? 'line' : 'lines'}) have no cost on record</span>{' '}
              - nothing costed had been received for them when they were sold. They are left out of cost of sales, gross profit and margin
              rather than counted as free, so the profit above is on the {money(s.net - s.uncostedNet)} that could be costed.
            </div>
          )}

          {noSales ? (
            <Card>
              <Empty title="No sales in this period" hint="Widen the dates or clear a filter. Only completed receipts are counted." />
            </Card>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <ChartCard
                  title={`Net sales, cost of sales and gross profit, by ${grouping}`}
                  subtitle={`${describePeriod(r.period.from, r.period.to)}`}
                  loading={report.loading}
                  chart={
                    <div>
                      <SeriesChart
                        series={[
                          { key: 'net', label: 'Net sales', color: COLORS.net },
                          { key: 'cost', label: 'Cost of sales', color: COLORS.cost },
                          { key: 'profit', label: 'Gross profit', color: COLORS.profit },
                        ]}
                        points={points}
                        format={money}
                        ariaLabel="Net sales, cost of sales and gross profit over time"
                      />
                    </div>
                  }
                  table={
                    <MiniTable
                      head={['Period', 'Net sales', 'Cost of sales', 'Gross profit']}
                      rows={points.map((pt) => [pt.heading, money(pt.values[0] ?? 0), money(pt.values[1] ?? 0), money(pt.values[2] ?? 0)])}
                    />
                  }
                />

                {/* -- the accountant's statement ------------------------------------------------ */}
                <Card className="overflow-hidden">
                  <div className="border-ink-100 border-b px-4 py-2.5">
                    <h2 className="text-[13px] font-semibold tracking-tight">Trading account</h2>
                    <p className="text-ink-400 text-[11.5px]">This period beside the one before it</p>
                  </div>
                  <table className="w-full text-[12.5px]" data-testid="statement">
                    <thead>
                      <tr className="text-ink-400 border-ink-100 border-b text-[10.5px] font-medium uppercase tracking-wider">
                        <th className="px-4 py-2 text-left" />
                        <th className="px-2 py-2 text-right">This period</th>
                        <th className="px-4 py-2 text-right">Before</th>
                      </tr>
                    </thead>
                    <tbody className="divide-ink-100 divide-y">
                      <StatementRow label="Total sales" now={s.gross} before={p.gross}  noBefore={p.receipts === 0} />
                      <StatementRow label="Less: discounts" now={-s.discounts} before={-p.discounts} indent  noBefore={p.receipts === 0} />
                      <StatementRow label="Net sales" now={s.net} before={p.net} strong  noBefore={p.receipts === 0} />
                      <StatementRow label="Less: cost of sales" now={-s.cost} before={-p.cost} indent  noBefore={p.receipts === 0} />
                      <StatementRow label="Gross profit" now={s.grossProfit} before={p.grossProfit} strong  noBefore={p.receipts === 0} />
                      <tr>
                        <td className="text-ink-500 px-4 py-1.5">Gross margin</td>
                        <td className="tnum px-2 py-1.5 text-right">{pct(s.marginPercent)}</td>
                        <td className="tnum text-ink-500 px-4 py-1.5 text-right">{p.receipts === 0 ? '—' : pct(p.marginPercent)}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-500 px-4 py-1.5">Receipts</td>
                        <td className="tnum px-2 py-1.5 text-right">{s.receipts.toLocaleString()}</td>
                        <td className="tnum text-ink-500 px-4 py-1.5 text-right">{p.receipts === 0 ? '—' : p.receipts.toLocaleString()}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-500 px-4 py-1.5">Average receipt</td>
                        <td className="tnum px-2 py-1.5 text-right">{money(s.avgBasket)}</td>
                        <td className="tnum text-ink-500 px-4 py-1.5 text-right">{p.receipts === 0 ? '—' : money(p.avgBasket)}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-500 px-4 py-1.5">Units sold</td>
                        <td className="tnum px-2 py-1.5 text-right">{qty(s.units)}</td>
                        <td className="tnum text-ink-500 px-4 py-1.5 text-right">{p.receipts === 0 ? '—' : qty(p.units)}</td>
                      </tr>
                      {(s.uncostedNet > 0 || p.uncostedNet > 0) && (
                        <tr>
                          <td className="px-4 py-1.5 text-amber-800">Sales with no cost on record</td>
                          <td className="tnum px-2 py-1.5 text-right text-amber-800">{money(s.uncostedNet)}</td>
                          <td className="tnum px-4 py-1.5 text-right text-amber-800">{money(p.uncostedNet)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCard
                  title="Net sales by hour of the day"
                  subtitle={`When the tills are busiest, in ${r.timezone} time`}
                  loading={report.loading}
                  chart={<SeriesChart series={[{ key: 'net', label: 'Net sales', color: COLORS.net }]} points={hourPoints} kind="column" emphasizeMax format={money} ariaLabel="Net sales by hour of the day" />}
                  table={<MiniTable head={['Hour', 'Net sales']} rows={hourPoints.map((h) => [h.heading, money(h.values[0] ?? 0)])} />}
                />
                <ChartCard
                  title="How customers paid"
                  subtitle="Amount applied to the bill on each payment method"
                  loading={report.loading}
                  chart={
                    <BarList
                      rows={r.byPayment.map((x) => ({ key: x.paymentTypeId, label: x.name, hint: `${x.receipts.toLocaleString()} receipts`, value: x.amount }))}
                      color={COLORS.net}
                      format={money}
                    />
                  }
                />
              </div>

              {/* -- where it comes from ------------------------------------------------------------ */}
              <Card className="overflow-hidden">
                <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div>
                    <h2 className="text-[13px] font-semibold tracking-tight">Where the sales and profit come from</h2>
                    <p className="text-ink-400 text-[11.5px]">Click a heading to sort. Click a row to narrow the whole screen to it.</p>
                  </div>
                  <div className="bg-ink-100 flex rounded-lg p-0.5" role="group" aria-label="Break down by">
                    {(['product', 'category', 'branch', 'cashier'] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => setDimension(d)}
                        aria-pressed={dimension === d}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium capitalize transition ${
                          dimension === d ? 'text-ink-900 bg-white shadow-sm' : 'text-ink-500 hover:text-ink-800'
                        }`}
                      >
                        {d === 'product' ? 'Items' : d === 'category' ? 'Categories' : d === 'branch' ? 'Branches' : 'Cashiers'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]" data-testid="breakdown">
                    <thead>
                      <tr className="text-ink-500 border-ink-100 border-b text-[11px] uppercase tracking-wider">
                        <th className="px-4 py-2 text-left font-medium">{dimension === 'product' ? 'Item' : dimension}</th>
                        {(
                          [
                            ['receipts', 'Receipts'],
                            ['units', 'Units'],
                            ['net', 'Net sales'],
                            ['cost', 'Cost of sales'],
                            ['grossProfit', 'Gross profit'],
                            ['marginPercent', 'Margin'],
                          ] as [SortKey, string][]
                        ).map(([k, label]) => (
                          <th key={k} className="px-2 py-2 text-right font-medium last:pr-4">
                            <button onClick={() => sortBy(k)} className="hover:text-ink-900 uppercase tracking-wider">
                              {label}
                              {arrow(k)}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-ink-100 divide-y">
                      {rows.map((x) => (
                        <tr key={x.key} className="hover:bg-ink-50/60 cursor-pointer" onClick={() => drillInto(x)} data-testid="breakdown-row">
                          <td className="px-4 py-1.5">
                            <span className="font-medium">{x.name}</span>
                            {x.hint !== '' && <span className="text-ink-400 ml-2 font-mono text-[11px]">{x.hint}</span>}
                          </td>
                          <td className="tnum px-2 py-1.5 text-right">{x.receipts.toLocaleString()}</td>
                          <td className="tnum px-2 py-1.5 text-right">{qty(x.units)}</td>
                          <td className="tnum px-2 py-1.5 text-right font-medium">{money(x.net)}</td>
                          <td className="tnum text-ink-600 px-2 py-1.5 text-right">{money(x.cost)}</td>
                          <td className={`tnum px-2 py-1.5 text-right font-medium ${x.grossProfit < 0 ? 'text-red-700' : ''}`}>{money(x.grossProfit)}</td>
                          <td className={`tnum px-2 py-1.5 pr-4 text-right ${x.marginPercent !== null && x.marginPercent < 0 ? 'font-medium text-red-700' : ''}`}>
                            {pct(x.marginPercent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-ink-200 border-t font-medium">
                        <td className="px-4 py-2">Total</td>
                        <td className="tnum px-2 py-2 text-right">{s.receipts.toLocaleString()}</td>
                        <td className="tnum px-2 py-2 text-right">{qty(s.units)}</td>
                        <td className="tnum px-2 py-2 text-right">{money(s.net)}</td>
                        <td className="tnum px-2 py-2 text-right">{money(s.cost)}</td>
                        <td className="tnum px-2 py-2 text-right">{money(s.grossProfit)}</td>
                        <td className="tnum px-2 py-2 pr-4 text-right">{pct(s.marginPercent)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {dimension === 'product' && r.byProduct.length >= 100 && (
                  <p className="text-ink-400 border-ink-100 border-t px-4 py-2 text-[11.5px]">
                    The 100 biggest items by net sales are listed; the total row covers everything.
                  </p>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function StatementRow({
  label,
  now,
  before,
  strong = false,
  indent = false,
  noBefore = false,
}: {
  label: string;
  now: number;
  before: number;
  /** No trading in the earlier period: show a dash, not a misleading $0.00. */
  noBefore?: boolean;
  strong?: boolean;
  indent?: boolean;
}) {
  const fmt = (n: number): string => (n < 0 ? `(${money(-n)})` : money(n + 0));
  return (
    <tr className={strong ? 'bg-ink-50/70 font-semibold' : ''}>
      <td className={`px-4 py-1.5 ${indent ? 'text-ink-500 pl-7' : ''}`}>{label}</td>
      <td className="tnum px-2 py-1.5 text-right">{fmt(now)}</td>
      <td className={`tnum px-4 py-1.5 text-right ${strong ? '' : 'text-ink-500'}`}>{noBefore ? '—' : fmt(before)}</td>
    </tr>
  );
}
