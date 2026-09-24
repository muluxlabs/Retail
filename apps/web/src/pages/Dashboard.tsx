/**
 * Overview.
 *
 * Chosen to answer the auditor's questions, not to look impressive. The
 * headline numbers are: what the stock is worth, how much of it we cannot
 * value, what is waiting to be cleared, and where the controls are firing.
 *
 * Note the "cannot value" tile. Their current dashboard reported a 0.11%
 * gross margin without comment because cost price equalled selling price.
 * Stating what we do not know is the point of that tile.
 *
 * The charts below the tiles follow the same rule as the tiles: every figure
 * is derived from the movement ledger, and sales are only ever shown in
 * UNITS - this system has never recorded a selling price, so there is no
 * honest revenue number to draw.
 */

import { Link } from 'react-router-dom';

import { api, type Dashboard as DashboardData } from '../lib/api.js';
import { BarList, ChartCard, Delta, KpiTile, MiniTable, SeriesChart, VIZ } from '../lib/charts.js';
import { bucketHeading, bucketLabel, pctChange } from '../lib/chartMath.js';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  EXCEPTION_LABEL,
  money,
  qty,
  Spinner,
  Stat,
  useAsync,
} from '../lib/ui.js';

const DAYS = 30;

/**
 * The API returns only days that had movements. A chart with the quiet days
 * simply missing draws a line straight across them and misreports the shape
 * of the month, so put the zero days back. Dates are the server's (UTC) day.
 */
function fillDays(activity: DashboardData['activity']) {
  const byDay = new Map(activity.map((a) => [a.day, a]));
  const out: { day: string; sold: number; received: number }[] = [];
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const day = d.toISOString().slice(0, 10);
    const row = byDay.get(day);
    out.push({ day, sold: Number(row?.unitsSold ?? 0), received: Number(row?.unitsReceived ?? 0) });
  }
  return out;
}

/** The biggest few, and everything else folded into one honest "Other". */
function foldTail<T extends { key: string; label: string; value: number }>(rows: T[], keep: number) {
  if (rows.length <= keep + 1) return rows;
  const head = rows.slice(0, keep);
  const rest = rows.slice(keep).reduce((sum, r) => sum + r.value, 0);
  return [...head, { key: '__other', label: `Other (${rows.length - keep})`, value: rest } as T];
}

export function Dashboard() {
  const dash = useAsync(() => api.dashboard(), []);
  const branches = useAsync(() => api.stockByBranch(), []);

  if (dash.loading && dash.data === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (dash.error !== undefined) return <ErrorNote error={dash.error} />;
  if (dash.data === undefined) return null;

  const d = dash.data;
  const days = fillDays(d.activity);
  const hasActivity = d.activity.length > 0;

  const soldDelta = pctChange(Number(d.trading.soldNow), Number(d.trading.soldBefore));
  const receivedDelta = pctChange(Number(d.trading.receivedNow), Number(d.trading.receivedBefore));

  const categoryRows = foldTail(
    d.inventoryByCategory.map((c) => ({ key: c.categoryName, label: c.categoryName, value: Number(c.value) })),
    7,
  );

  const branchList = branches.data ?? [];
  const maxBranchValue = Math.max(0, ...branchList.map((b) => Number(b.value)));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Every figure below is derived from the movement ledger. Nothing here is a stored total.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Inventory at cost"
          value={money(d.inventory.value)}
          hint={`${qty(d.inventory.lines)} product/branch positions`}
        />
        <Stat
          label="Cannot be valued"
          value={qty(d.inventory.linesWithoutCost)}
          tone={d.inventory.linesWithoutCost > 0 ? 'warn' : 'good'}
          hint="Positions with no costed receipt behind them"
        />
        <Stat
          label="Open exceptions"
          value={qty(d.exceptions.open)}
          tone={d.exceptions.open > 0 ? 'warn' : 'good'}
          hint={`${money(d.exceptions.valueAtRisk)} of value involved`}
        />
        <Stat
          label="Stock below zero"
          value={qty(d.controls.negativeStockLines)}
          tone={d.controls.negativeStockLines > 0 ? 'bad' : 'good'}
          hint="Positions the ledger says are impossible"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ChartCard
          title="Movement, last 30 days"
          subtitle="Units sold and received each day"
          loading={dash.loading}
          empty={!hasActivity ? <Empty title="No movements yet" /> : undefined}
          chart={
            <SeriesChart
              ariaLabel="Units sold and received per day over the last 30 days"
              series={[
                { key: 'sold', label: 'Sold', color: VIZ.sold },
                { key: 'received', label: 'Received', color: VIZ.received },
              ]}
              points={days.map((x) => ({
                label: bucketLabel(x.day, 'day'),
                heading: bucketHeading(x.day, 'day'),
                values: [x.sold, x.received],
              }))}
              kind="line"
              height={236}
            />
          }
          table={
            <MiniTable
              head={['Day', 'Sold', 'Received']}
              rows={[...days].reverse().map((x) => [bucketHeading(x.day, 'day'), x.sold, x.received])}
            />
          }
        />

        <div className="grid content-start gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <KpiTile
            label="Units sold · 30 days"
            value={qty(Number(d.trading.soldNow))}
            spark={{ values: days.map((x) => x.sold), color: VIZ.sold }}
            delta={<Delta pct={soldDelta} upIsGood={true} versus="than the 30 days before" />}
          />
          <KpiTile
            label="Units received · 30 days"
            value={qty(Number(d.trading.receivedNow))}
            spark={{ values: days.map((x) => x.received), color: VIZ.received }}
            delta={<Delta pct={receivedDelta} upIsGood={null} versus="than the 30 days before" />}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Top sellers, last 30 days"
          subtitle="Units sold"
          loading={dash.loading}
          empty={
            d.topProducts.length === 0 ? <Empty title="No sales in the last 30 days" /> : undefined
          }
          chart={
            <BarList
              color={VIZ.sold}
              rows={d.topProducts.map((p) => ({
                key: p.productId,
                label: p.productName,
                hint: p.sku,
                value: Number(p.unitsSold),
              }))}
              format={qty}
            />
          }
        />

        <ChartCard
          title="Where the stock value sits"
          subtitle="Inventory at cost, by category - adds up to the figure above"
          loading={dash.loading}
          empty={categoryRows.length === 0 ? <Empty title="No stock on hand" /> : undefined}
          chart={<BarList color={VIZ.neutral} rows={categoryRows} format={money} />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <Header
            title="Stock by branch"
            action={<Link to="/stock" className="text-accent-700 text-xs hover:underline">View all</Link>}
          />
          {branches.loading && branches.data === undefined ? (
            <div className="grid place-items-center py-12">
              <Spinner />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                    <th className="px-4 py-2 text-left font-medium">Branch</th>
                    <th className="px-3 py-2 text-right font-medium">Lines</th>
                    <th className="px-3 py-2 text-right font-medium">Units</th>
                    <th className="px-4 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-ink-100 divide-y">
                  {branchList.map((b) => (
                    <tr key={b.branchId} className="hover:bg-ink-50/60">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{b.branchName}</span>
                          {b.kind === 'warehouse' && <Badge tone="info">WH</Badge>}
                          {b.negativeLines > 0 && (
                            <Badge tone="bad">{b.negativeLines} negative</Badge>
                          )}
                        </div>
                      </td>
                      <td className="tnum text-ink-500 px-3 py-2 text-right">{qty(b.lines)}</td>
                      <td className="tnum text-ink-500 px-3 py-2 text-right">{qty(b.units)}</td>
                      <td className="tnum px-4 py-2 text-right font-medium">
                        {money(b.value)}
                        <div className="ml-auto mt-1 h-1 w-24" aria-hidden="true">
                          <div
                            className="h-1 rounded-r-[2px]"
                            style={{
                              width: `${maxBranchValue > 0 ? (Math.max(0, Number(b.value)) / maxBranchValue) * 100 : 0}%`,
                              background: VIZ.neutral,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <Header
              title="Controls firing"
              action={
                <Link to="/exceptions" className="text-accent-700 text-xs hover:underline">
                  Open queue
                </Link>
              }
            />
            {d.exceptions.byKind.length === 0 ? (
              <Empty title="Queue is clear" hint="No open work items across any branch." />
            ) : (
              <ul className="divide-ink-100 divide-y">
                {d.exceptions.byKind.map((k) => (
                  <li key={k.kind} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">
                      {EXCEPTION_LABEL[k.kind]}
                    </span>
                    {Number(k.valueAtRisk) > 0 && (
                      <span className="tnum text-ink-400 text-[11.5px]">
                        {money(Number(k.valueAtRisk))}
                      </span>
                    )}
                    <span className="tnum bg-amber-50 text-amber-800 ring-amber-200 inline-flex min-w-6 justify-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset">
                      {k.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <Header title="Item master health" />
            <dl className="divide-ink-100 divide-y text-[12.5px]">
              <Health label="Active products" value={qty(d.master.products)} />
              <Health
                label="Without a pack"
                value={qty(d.master.withoutPack)}
                bad={d.master.withoutPack > 0}
                hint="Cannot be bought or sold"
              />
              <Health
                label="Without a barcode"
                value={qty(d.master.withoutBarcode)}
                bad={d.master.withoutBarcode > 0}
                hint="Must be keyed by hand at the till"
              />
              <Health label="Merged in cleanse" value={qty(d.master.merged)} hint="History kept, movements blocked" />
              <Health
                label="Backdated movements"
                value={qty(d.controls.backdatedMovements)}
                bad={d.controls.backdatedMovements > 0}
                hint="Recorded over 48h after they happened"
              />
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Header({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {action}
    </div>
  );
}

function Health({
  label,
  value,
  hint,
  bad = false,
}: {
  label: string;
  value: string;
  hint?: string;
  bad?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {hint !== undefined && <div className="text-ink-400 text-[11px]">{hint}</div>}
      </div>
      <div className={`tnum font-semibold ${bad ? 'text-amber-700' : 'text-ink-700'}`}>{value}</div>
    </div>
  );
}
