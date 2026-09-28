/**
 * Item analysis: what came in, what went out, and how fast.
 *
 * Read left to right it is a stores ledger for every item - opening stock,
 * received from suppliers, sold, closing stock - and then the buyer's
 * questions: how much of what was available sold (sell-through), how fast
 * (sold per week), and how long today's stock will last (days of cover).
 *
 * Click an item to see its own history week by week or month by month:
 * received (teal) against sold (blue), and the stock left at the end of each.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';

import { ReportTabs } from '../components/ReportTabs.js';
import { api, type ItemHistory, type ItemRow, type ItemStatus } from '../lib/api.js';
import { ChartCard, KpiTile, MiniTable, SeriesChart, VIZ, type SeriesPoint } from '../lib/charts.js';
import { bucketHeading, bucketLabel, fillBuckets } from '../lib/chartMath.js';
import { downloadCsv } from '../lib/csv.js';
import { PRESETS, daysBetween, describePeriod, rangeFor, type Preset } from '../lib/salesRange.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

type SortKey = 'productName' | 'opening' | 'received' | 'sold' | 'closing' | 'sellThroughPercent' | 'perWeek' | 'daysOfCover' | 'lastSold' | 'net' | 'grossProfit';

const STATUS: Record<ItemStatus, { label: string; tone: 'good' | 'info' | 'neutral' | 'warn' | 'bad'; why: string }> = {
  fast: { label: 'Fast', tone: 'good', why: 'Among the top fifth of items that sold, by units' },
  steady: { label: 'Steady', tone: 'neutral', why: 'Selling at a middling pace' },
  slow: { label: 'Slow', tone: 'info', why: 'Among the slowest third of items that sold, by units' },
  not_selling: { label: 'Not selling', tone: 'warn', why: 'Stock on hand and nothing sold in the whole period' },
  out_of_stock: { label: 'Out of stock', tone: 'bad', why: 'Sold in the period, but none is left' },
};

const pct = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}%`);
const dash = (n: number | null, f: (n: number) => string): string => (n === null ? '—' : f(n));

export function Items() {
  const context = useAsync(() => api.businessToday(), []);
  const today = context.data?.today;

  const [preset, setPreset] = useState<Preset>('last30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branchId, setBranchId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ItemStatus | 'all'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'sold', dir: -1 });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (today !== undefined && from === '') {
      const r = rangeFor('last30', today);
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
  const valid = from !== '' && to !== '' && to >= from && daysBetween(from, to) <= 400;

  // Searching types quickly; wait for a pause rather than hitting the server on every key.
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const report = useAsync(
    () =>
      valid
        ? api.itemReport({
            from,
            to,
            ...(branchId === '' ? {} : { branchId }),
            ...(categoryId === '' ? {} : { categoryId }),
            ...(term === '' ? {} : { search: term }),
          })
        : Promise.resolve(undefined),
    [from, to, branchId, categoryId, term, valid],
  );
  const r = report.data;

  const rows = useMemo(() => {
    if (r === undefined) return [];
    const list = status === 'all' ? r.items : r.items.filter((i) => i.status === status);
    const val = (i: ItemRow): number | string => {
      const v = i[sort.key];
      return v === null ? (sort.dir === -1 ? -Infinity : Infinity) : v;
    };
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number)) * sort.dir;
    });
  }, [r, status, sort]);

  const sortBy = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: key === 'productName' ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : '');

  function exportCsv() {
    if (r === undefined) return;
    downloadCsv(
      `item-analysis-${r.period.from}-to-${r.period.to}.csv`,
      ['Item', 'SKU', 'Category', 'Opening stock', 'Received', 'Transfers in', 'Transfers out', 'Adjustments', 'Sold', 'Closing stock',
        'Sell-through %', 'Sold per week', 'Days of cover', 'Last sold', 'Status', 'Net sales', 'Cost of sales', 'Gross profit'],
      rows.map((i) => [i.productName, i.sku, i.categoryName, i.opening, i.received, i.transfersIn, i.transfersOut, i.adjustments, i.sold, i.closing,
        i.sellThroughPercent ?? '', i.perWeek, i.daysOfCover ?? '', i.lastSold ?? '', STATUS[i.status].label, i.net, i.cost, i.grossProfit]),
    );
  }

  const select = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';
  const s = r?.summary;

  const chips: { value: ItemStatus | 'all'; label: string; n: number }[] =
    s === undefined
      ? []
      : [
          { value: 'all', label: 'All', n: s.items },
          { value: 'fast', label: 'Fast', n: s.fast },
          { value: 'steady', label: 'Steady', n: s.steady },
          { value: 'slow', label: 'Slow', n: s.slow },
          { value: 'not_selling', label: 'Not selling', n: s.notSelling },
          { value: 'out_of_stock', label: 'Out of stock', n: s.outOfStock },
        ];

  return (
    <div className="space-y-4">
      <ReportTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Item analysis</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            For every item: what was in stock, what came in from suppliers, what was sold, and what is left - and from
            that, how fast it sells and how long the stock will last. Click an item to see its history.
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
            <span className="text-ink-500 mb-1 block text-[11px]">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={select} aria-label="Branch">
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={select} aria-label="Category">
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-48 flex-1">
            <span className="text-ink-500 mb-1 block text-[11px]">Find an item</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or SKU…" aria-label="Find an item" className={`${select} w-full`} />
          </label>
        </div>
      </Card>

      {!valid && from !== '' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900">
          Choose an end date on or after the start date, at most 400 days apart.
        </div>
      )}
      {report.error !== undefined && <ErrorNote error={report.error} />}

      {report.loading && r === undefined ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : r === undefined || s === undefined ? null : (
        <>
          <div className="text-ink-500 text-[12px]" data-testid="period">
            {describePeriod(r.period.from, r.period.to)} · {r.period.days} {r.period.days === 1 ? 'day' : 'days'}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="kpis">
            <KpiTile label="Received" value={qty(s.received)} sub="units from suppliers" />
            <KpiTile label="Sold" value={qty(s.sold)} sub={`${s.itemsSold.toLocaleString()} of ${s.items.toLocaleString()} items sold`} />
            <KpiTile label="Sell-through" value={pct(s.sellThroughPercent)} sub="of opening stock + received" />
            <KpiTile label="Closing stock" value={qty(s.closing)} sub={`from ${qty(s.opening)} at the start`} />
            <KpiTile label="Not selling" value={s.notSelling.toLocaleString()} sub="in stock, none sold" />
            <KpiTile label="Out of stock" value={s.outOfStock.toLocaleString()} sub="sold, none left" />
          </div>

          <Card className="overflow-hidden">
            <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <div className="no-print flex flex-wrap gap-1" role="group" aria-label="Filter by status">
                {chips.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setStatus(c.value)}
                    aria-pressed={status === c.value}
                    title={c.value === 'all' ? undefined : STATUS[c.value].why}
                    className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition ${
                      status === c.value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100 bg-white ring-1 ring-inset ring-ink-200'
                    }`}
                  >
                    {c.label} <span className="tnum opacity-70">{c.n}</span>
                  </button>
                ))}
              </div>
              <p className="text-ink-400 text-[11.5px]">Click a heading to sort · click an item for its history</p>
            </div>

            {rows.length === 0 ? (
              <Empty title="No items match" hint="Widen the period, or clear a filter. Items with no stock and no movement in the period are left out." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]" data-testid="items">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-[11px] uppercase tracking-wider">
                      <Th onClick={() => sortBy('productName')} left>Item{arrow('productName')}</Th>
                      <Th onClick={() => sortBy('opening')}>Opening{arrow('opening')}</Th>
                      <Th onClick={() => sortBy('received')}>Received{arrow('received')}</Th>
                      <Th onClick={() => sortBy('sold')}>Sold{arrow('sold')}</Th>
                      <Th onClick={() => sortBy('closing')}>Closing{arrow('closing')}</Th>
                      <Th onClick={() => sortBy('sellThroughPercent')}>Sell-through{arrow('sellThroughPercent')}</Th>
                      <Th onClick={() => sortBy('perWeek')}>Sold / week{arrow('perWeek')}</Th>
                      <Th onClick={() => sortBy('daysOfCover')}>Days of cover{arrow('daysOfCover')}</Th>
                      <Th onClick={() => sortBy('lastSold')}>Last sold{arrow('lastSold')}</Th>
                      <th className="px-2 py-2 text-left font-medium">Status</th>
                      <Th onClick={() => sortBy('net')}>Net sales{arrow('net')}</Th>
                      <Th onClick={() => sortBy('grossProfit')} last>Profit{arrow('grossProfit')}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {rows.map((i) => (
                      <Fragment key={i.productId}>
                        <tr
                          className={`hover:bg-ink-50/60 cursor-pointer ${open === i.productId ? 'bg-ink-50/70' : ''}`}
                          onClick={() => setOpen(open === i.productId ? null : i.productId)}
                          data-testid="item-row"
                        >
                          <td className="px-4 py-1.5">
                            <span className="font-medium">{i.productName}</span>
                            <span className="text-ink-400 ml-2 font-mono text-[11px]">{i.sku}</span>
                            <div className="text-ink-400 text-[11px]">{i.categoryName}</div>
                          </td>
                          <td className="tnum px-2 py-1.5 text-right">{qty(i.opening)}</td>
                          <td className="tnum px-2 py-1.5 text-right">{qty(i.received)}</td>
                          <td className="tnum px-2 py-1.5 text-right font-medium">{qty(i.sold)}</td>
                          <td className={`tnum px-2 py-1.5 text-right ${i.closing < 0 ? 'font-medium text-red-700' : ''}`}>{qty(i.closing)}</td>
                          <td className="tnum px-2 py-1.5 text-right">{pct(i.sellThroughPercent)}</td>
                          <td className="tnum px-2 py-1.5 text-right">{qty(i.perWeek)}</td>
                          <td className="tnum px-2 py-1.5 text-right">{dash(i.daysOfCover, (n) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1)))}</td>
                          <td className="text-ink-600 px-2 py-1.5 text-right whitespace-nowrap">{i.lastSold === null ? '—' : describePeriod(i.lastSold, i.lastSold)}</td>
                          <td className="px-2 py-1.5">
                            <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
                          </td>
                          <td className="tnum px-2 py-1.5 text-right">{money(i.net)}</td>
                          <td className={`tnum px-2 py-1.5 pr-4 text-right ${i.grossProfit < 0 ? 'font-medium text-red-700' : ''}`}>{money(i.grossProfit)}</td>
                        </tr>
                        {open === i.productId && (
                          <tr>
                            <td colSpan={12} className="bg-ink-50/40 px-4 py-3">
                              <History item={i} from={r.period.from} to={r.period.to} branchId={branchId} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <details className="text-ink-500 text-[12px]">
            <summary className="hover:text-ink-800 cursor-pointer font-medium">How these figures are worked out</summary>
            <ul className="mt-2 max-w-3xl list-disc space-y-1 pl-5">
              <li>Opening stock + received from suppliers + transfers in − transfers out + adjustments − sold = closing stock, for every item. Opening and closing come from the stock ledger, so they agree with the Stock ledger and Stock reconciliation screens.</li>
              <li><b>Sell-through</b> is what was sold as a share of what was available: opening stock plus received.</li>
              <li><b>Sold per week</b> is units sold divided by the days in the period, times seven. <b>Days of cover</b> is closing stock divided by units sold per day - how long today's stock lasts if it keeps selling at that pace.</li>
              <li><b>Fast</b> and <b>slow</b> are relative to the other items in this report and period (top fifth and bottom third of those that sold, by units). With fewer than five selling items nothing is ranked. <b>Not selling</b>: stock on hand, nothing sold in the whole period. <b>Out of stock</b>: sold in the period, none left.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function Th({
  children,
  onClick,
  left = false,
  last = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  left?: boolean;
  last?: boolean;
}) {
  return (
    <th className={`px-2 py-2 font-medium ${left ? 'px-4 text-left' : 'text-right'} ${last ? 'pr-4' : ''}`}>
      <button onClick={onClick} className="hover:text-ink-900 uppercase tracking-wider whitespace-nowrap">
        {children}
      </button>
    </th>
  );
}

/** One item's received and sold, period by period, and the stock left at the end of each. */
function History({ item, from, to, branchId }: { item: ItemRow; from: string; to: string; branchId: string }) {
  const days = daysBetween(from, to);
  const [group, setGroup] = useState<'day' | 'week' | 'month'>(days <= 31 ? 'day' : days <= 200 ? 'week' : 'month');

  const h = useAsync<ItemHistory>(
    () => api.itemHistory(item.productId, { from, to, groupBy: group, ...(branchId === '' ? {} : { branchId }) }),
    [item.productId, from, to, group, branchId],
  );

  const points = useMemo(() => {
    if (h.data === undefined) return { flow: [] as SeriesPoint[], stock: [] as SeriesPoint[] };
    const zero = (bucket: string) => ({ bucket, received: 0, sold: 0, other: 0, closing: Number.NaN });
    const filled = fillBuckets(h.data.series, from, to, group, zero);
    // A quiet period has no movements, so the stock left is whatever it was before.
    let last = h.data.opening;
    const rows = filled.map((b) => {
      const closing = Number.isNaN(b.closing) ? last : b.closing;
      last = closing;
      return { ...b, closing };
    });
    const label = (b: string) => bucketLabel(b, group);
    const heading = (b: string) => bucketHeading(b, group);
    return {
      flow: rows.map((b) => ({ label: label(b.bucket), heading: heading(b.bucket), values: [b.received, b.sold] })),
      stock: rows.map((b) => ({ label: label(b.bucket), heading: heading(b.bucket), values: [Math.max(0, b.closing)] })),
    };
  }, [h.data, from, to, group]);

  const select = 'border-ink-200 rounded-lg border bg-white px-2 py-1 text-[12px] outline-none';

  return (
    <div className="space-y-3" data-testid="item-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12.5px]">
          <span className="font-semibold">{item.productName}</span>
          <span className="text-ink-500">
            {' '}
            · {qty(item.received)} received, {qty(item.sold)} sold in {describePeriod(from, to)}
          </span>
        </div>
        <label className="text-ink-500 flex items-center gap-1.5 text-[12px]">
          By
          <select value={group} onChange={(e) => setGroup(e.target.value as typeof group)} className={select} aria-label="History by">
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </label>
      </div>
      {h.error !== undefined && <ErrorNote error={h.error} />}
      {h.data === undefined ? (
        <div className="grid place-items-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard
            title={`Received and sold, by ${group}`}
            loading={h.loading}
            chart={
              <SeriesChart
                series={[
                  { key: 'received', label: 'Received', color: VIZ.received },
                  { key: 'sold', label: 'Sold', color: VIZ.sold },
                ]}
                points={points.flow}
                kind="column"
                height={190}
                ariaLabel={`Units of ${item.productName} received and sold each ${group}`}
              />
            }
            table={<MiniTable head={['Period', 'Received', 'Sold']} rows={points.flow.map((p) => [p.heading, p.values[0] ?? 0, p.values[1] ?? 0])} />}
          />
          <ChartCard
            title="Stock left at the end of each period"
            loading={h.loading}
            chart={
              <SeriesChart
                series={[{ key: 'closing', label: 'Closing stock', color: VIZ.neutral }]}
                points={points.stock}
                kind="line"
                height={190}
                ariaLabel={`Stock of ${item.productName} at the end of each ${group}`}
              />
            }
            table={<MiniTable head={['Period', 'Closing stock']} rows={points.stock.map((p) => [p.heading, p.values[0] ?? 0])} />}
          />
        </div>
      )}
    </div>
  );
}
