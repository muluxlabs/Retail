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
 */

import { Link } from 'react-router-dom';

import { api } from '../lib/api.js';
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

export function Dashboard() {
  const dash = useAsync(() => api.dashboard(), []);
  const branches = useAsync(() => api.stockByBranch(), []);

  if (dash.loading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (dash.error !== undefined) return <ErrorNote error={dash.error} />;
  if (dash.data === undefined) return null;

  const d = dash.data;
  const maxActivity = Math.max(
    1,
    ...d.activity.map((a) => Math.max(Number(a.unitsSold), Number(a.unitsReceived))),
  );

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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <Header
            title="Stock by branch"
            action={<Link to="/stock" className="text-accent-700 text-xs hover:underline">View all</Link>}
          />
          {branches.loading ? (
            <div className="grid place-items-center py-12">
              <Spinner />
            </div>
          ) : (
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
                {(branches.data ?? []).map((b) => (
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
                    <td className="tnum px-4 py-2 text-right font-medium">{money(b.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

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
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <Header title="Movement, last 30 days" />
          {d.activity.length === 0 ? (
            <Empty title="No movements yet" />
          ) : (
            <div className="px-4 py-4">
              <div className="flex h-28 items-end gap-[3px]">
                {d.activity.map((a) => {
                  const sold = Number(a.unitsSold);
                  const received = Number(a.unitsReceived);
                  return (
                    <div
                      key={a.day}
                      className="group relative flex flex-1 flex-col justify-end gap-[2px]"
                      title={`${a.day} · ${qty(received)} in, ${qty(sold)} out`}
                    >
                      <div
                        className="bg-accent-500/85 rounded-t-[2px]"
                        style={{ height: `${(received / maxActivity) * 70}%` }}
                      />
                      <div
                        className="bg-ink-300 rounded-b-[2px]"
                        style={{ height: `${(sold / maxActivity) * 70}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="text-ink-400 mt-3 flex items-center gap-4 text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="bg-accent-500/85 size-2 rounded-sm" /> Received
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="bg-ink-300 size-2 rounded-sm" /> Sold
                </span>
              </div>
            </div>
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
