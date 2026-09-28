/**
 * Cashier shifts: who was on which till, from when to when, and whether the
 * cash they handed over matched the books.
 *
 * The shift report explains the cash expected at the close line by line: the
 * float counted in, plus every cash movement on the till while the shift was
 * open. A supervisor can close a shift a cashier left open.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { CashTabs } from '../components/CashTabs.js';
import { CloseShiftDialog } from '../components/ShiftDialogs.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { shortDateTime } from '../lib/buying.js';
import { cashReason } from '../lib/terms.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

/** Over as a plain amount, short in brackets, none as a dash. */
export const overShort = (v: number | null): string => (v === null ? '' : v === 0 ? '—' : v < 0 ? `(${money(-v)})` : money(v));

export function Shifts() {
  const { user } = useAuth();
  const allBranches = useAsync(() => api.branches(), []);
  const scoped = user?.branchIds ?? [];
  const branchList = (allBranches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<'all' | 'open' | 'closed'>('all');
  const list = useAsync(() => api.shifts({ ...(branchId === '' ? {} : { branchId }), status, limit: 100 }), [branchId, status]);
  const rows = list.data?.shifts ?? [];

  return (
    <div className="space-y-4">
      <CashTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Cashier shifts</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Each shift starts with the cashier counting the float and ends with a blind count. Any over or short is posted to the till and named
          against the cashier.
        </p>
      </div>
      <Card className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,12rem)]">
        <label className="block">
          <span className={label}>Branch</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field} aria-label="Branch">
            <option value="">All branches</option>
            {branchList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={field} aria-label="Show">
            <option value="all">All shifts</option>
            <option value="open">Open now</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </Card>
      {list.error !== undefined && <ErrorNote error={list.error} />}
      <Card className="overflow-hidden">
        {list.loading && list.data === undefined ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No shifts" hint="Cashiers open a shift from the Sell screen." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="shift-list">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Shift</th>
                  <th className="px-2 py-2 font-medium">Cashier</th>
                  <th className="px-2 py-2 font-medium">Till</th>
                  <th className="px-2 py-2 font-medium">Opened</th>
                  <th className="px-2 py-2 font-medium">Closed</th>
                  <th className="px-2 py-2 text-right font-medium">Receipts</th>
                  <th className="px-2 py-2 text-right font-medium">Net sales</th>
                  <th className="px-4 py-2 text-right font-medium">Cash over / (short)</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {rows.map((s) => {
                  const v = s.closingVariance === null ? null : s.closingVariance + s.openingVariance;
                  return (
                    <tr key={s.id} className="hover:bg-ink-50/60" data-testid="shift-row">
                      <td className="px-4 py-2">
                        <Link to={`/shifts/${s.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                          {s.shiftNo}
                        </Link>
                      </td>
                      <td className="px-2 py-2">{s.cashierName}</td>
                      <td className="text-ink-600 px-2 py-2">
                        {s.tillName}
                        {branchId === '' && <span className="text-ink-400"> · {s.branchName}</span>}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">{shortDateTime(s.openedAt)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{s.closedAt === null ? <Badge tone="info">Open</Badge> : shortDateTime(s.closedAt)}</td>
                      <td className="tnum px-2 py-2 text-right">{s.receipts}</td>
                      <td className="tnum px-2 py-2 text-right font-medium">{money(s.net)}</td>
                      <td className={`tnum px-4 py-2 text-right ${v !== null && v < 0 ? 'font-medium text-red-700' : ''}`}>{overShort(v)}</td>
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

export function ShiftReportPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const r = useAsync(() => api.shift(id), [id]);
  const [closing, setClosing] = useState(false);
  if (r.error !== undefined) return <ErrorNote error={r.error} />;
  const d = r.data;
  if (d === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const oversees = can('shift.manage') || can('sale.read');
  return (
    <div className="space-y-4">
      {oversees && <CashTabs />}
      <div className="text-ink-400 no-print text-[12px]">
        {oversees ? (
          <Link to="/shifts" className="hover:text-ink-700 hover:underline">
            Shifts
          </Link>
        ) : (
          <Link to="/sell" className="hover:text-ink-700 hover:underline">
            Sell
          </Link>
        )}{' '}
        / {d.shiftNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Shift <span className="font-mono" data-testid="shift-no">{d.shiftNo}</span>{' '}
            {d.closedAt === null && <Badge tone="info">Open</Badge>}
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            {d.cashierName} on {d.tillName}, {d.branchName} · opened {shortDateTime(d.openedAt)}
            {d.closedAt !== null && ` · closed ${shortDateTime(d.closedAt)}${d.closedByName !== null && d.closedByName !== d.cashierName ? ` by ${d.closedByName}` : ''}`}
          </p>
        </div>
        <div className="no-print flex gap-2">
          {d.closedAt === null && can('shift.manage') && (
            <Button variant="primary" onClick={() => setClosing(true)}>
              Close this shift
            </Button>
          )}
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="px-4 py-4">
          <h2 className="mb-2 text-[13px] font-semibold tracking-tight">Sales on this shift</h2>
          <table className="w-full text-[12.5px]" data-testid="shift-sales">
            <tbody className="divide-ink-100 divide-y">
              <tr>
                <td className="text-ink-500 py-1.5">Receipts</td>
                <td className="tnum py-1.5 text-right font-medium">
                  {d.sales.receipts}
                  {d.sales.firstReceipt !== null && (
                    <div className="text-ink-400 font-mono text-[11px] font-normal">
                      {d.sales.firstReceipt} to {d.sales.lastReceipt}
                    </div>
                  )}
                </td>
              </tr>
              {d.byPayment.map((p) => (
                <tr key={p.name}>
                  <td className="text-ink-500 py-1.5 pl-3">
                    {p.name} <span className="text-[11px]">· {p.receipts}</span>
                  </td>
                  <td className="tnum py-1.5 text-right">{money(p.amount)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5">Net sales</td>
                <td className="tnum py-1.5 text-right" data-testid="shift-net">{money(d.sales.net)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card className="px-4 py-4">
          <h2 className="mb-2 text-[13px] font-semibold tracking-tight">Cash in the till</h2>
          <table className="w-full text-[12.5px]" data-testid="shift-cash">
            <tbody className="divide-ink-100 divide-y">
              <tr>
                <td className="text-ink-500 py-1.5">Float counted in</td>
                <td className="tnum py-1.5 text-right">{money(d.cash.opening)}</td>
              </tr>
              {d.cash.lines.map((l) => (
                <tr key={l.reason}>
                  <td className="text-ink-500 py-1.5 pl-3">{l.amount < 0 ? 'Less: ' : 'Add: '}{cashReason(l.reason).label.toLowerCase()}</td>
                  <td className="tnum py-1.5 text-right">{l.amount < 0 ? `(${money(-l.amount)})` : money(l.amount)}</td>
                </tr>
              ))}
              {d.cash.other !== 0 && (
                <tr>
                  <td className="py-1.5 pl-3 text-amber-800">Other movements on the till</td>
                  <td className="tnum py-1.5 text-right text-amber-800">{overShort(d.cash.other)}</td>
                </tr>
              )}
              <tr className="font-semibold">
                <td className="py-1.5">{d.closedAt === null ? 'Should be in the till now' : 'Should have been in the till'}</td>
                <td className="tnum py-1.5 text-right" data-testid="shift-expected">{money(d.cash.expected)}</td>
              </tr>
              {d.closing !== null && (
                <>
                  <tr>
                    <td className="text-ink-500 py-1.5">Counted at the close</td>
                    <td className="tnum py-1.5 text-right">{money(d.closing.counted)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-1.5">Over / (short)</td>
                    <td className={`tnum py-1.5 text-right ${d.closing.variance < 0 ? 'text-red-700' : ''}`} data-testid="shift-variance">
                      {overShort(d.closing.variance)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          {d.opening.variance !== 0 && (
            <p className="mt-2 text-[12px] text-amber-800">
              At the start, {money(d.opening.counted)} was counted where the books had {money(d.opening.expected)}: {overShort(d.opening.variance)}.
            </p>
          )}
        </Card>
      </div>

      {closing && (
        <CloseShiftDialog
          shiftId={d.id}
          shiftNo={d.shiftNo}
          tillName={d.tillName}
          cashierName={d.cashierName}
          onClose={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            r.reload();
          }}
        />
      )}
    </div>
  );
}
