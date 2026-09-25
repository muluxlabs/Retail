/**
 * What is owed to suppliers, and how overdue: the aged creditors report.
 *
 * Every figure is worked out from the goods received notes and the payments.
 * Each delivery is due on the day it arrived plus the days of credit agreed
 * (none for prepaid or cash on delivery). Payments are applied to the oldest
 * delivery first, and money paid beyond what is owed is shown as a prepayment.
 */

import { Link } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { api } from '../lib/api.js';
import { shortDate, termsText } from '../lib/buying.js';
import { downloadCsv } from '../lib/csv.js';
import { Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const BUCKETS = [
  ['notDue', 'Not yet due'],
  ['d1_30', '1-30 days late'],
  ['d31_60', '31-60 days late'],
  ['d61_90', '61-90 days late'],
  ['over90', 'Over 90 days late'],
] as const;

export function Owed() {
  const data = useAsync(() => api.payables(), []);
  if (data.error !== undefined) return <ErrorNote error={data.error} />;
  const d = data.data;

  function exportCsv() {
    if (d === undefined) return;
    downloadCsv(
      `owed-to-suppliers-${d.asOf}.csv`,
      ['Supplier', 'Code', 'Terms', 'Not yet due', '1-30 days late', '31-60 days late', '61-90 days late', 'Over 90 days late', 'Total owed', 'Prepaid'],
      d.suppliers.map((s) => [s.name, s.code, s.terms, s.buckets.notDue, s.buckets.d1_30, s.buckets.d31_60, s.buckets.d61_90, s.buckets.over90, s.owed, s.credit]),
    );
  }

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Owed to suppliers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            What the business owes each supplier for goods received and not yet paid for, and how long it has been owed
            {d !== undefined && <> - as at {shortDate(d.asOf)}</>}.
          </p>
        </div>
        <div className="no-print flex gap-2">
          <Button onClick={exportCsv} disabled={d === undefined || d.suppliers.length === 0}>
            Export CSV
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      {d === undefined ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Total owed</div>
              <div className="tnum mt-1 text-2xl font-semibold" data-testid="total-owed">{money(d.totals.total)}</div>
              <div className="text-ink-400 text-xs">across {d.suppliers.filter((s) => s.owed > 0).length} suppliers</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Overdue</div>
              <div className={`tnum mt-1 text-2xl font-semibold ${d.totals.total - d.totals.notDue > 0 ? 'text-red-700' : ''}`} data-testid="total-overdue">
                {money(d.totals.total - d.totals.notDue)}
              </div>
              <div className="text-ink-400 text-xs">past the payment terms</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Not yet due</div>
              <div className="tnum mt-1 text-2xl font-semibold">{money(d.totals.notDue)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Prepaid with suppliers</div>
              <div className="tnum mt-1 text-2xl font-semibold">{money(d.totals.credit)}</div>
              <div className="text-ink-400 text-xs">paid ahead of delivery</div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            {d.suppliers.length === 0 ? (
              <Empty title="Nothing is owed to any supplier" hint="Goods received and not yet paid for appear here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]" data-testid="owed">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 text-left font-medium">Supplier</th>
                      {BUCKETS.map(([k, l]) => (
                        <th key={k} className="px-2 py-2 text-right font-medium">
                          {l}
                        </th>
                      ))}
                      <th className="px-2 py-2 text-right font-medium">Total owed</th>
                      <th className="px-4 py-2 text-right font-medium">Prepaid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {d.suppliers.map((s) => (
                      <tr key={s.supplierId} className="hover:bg-ink-50/60" data-testid="owed-row">
                        <td className="px-4 py-2">
                          <Link to={`/suppliers/${s.supplierId}`} className="hover:text-accent-700 font-medium hover:underline">
                            {s.name}
                          </Link>
                          <div className="text-ink-400 text-[11px]">{termsText(s.terms, null).replace(' · 0 days', '')}</div>
                        </td>
                        {BUCKETS.map(([k]) => (
                          <td key={k} className={`tnum px-2 py-2 text-right ${k !== 'notDue' && s.buckets[k] > 0 ? 'font-medium text-red-700' : s.buckets[k] === 0 ? 'text-ink-300' : ''}`}>
                            {s.buckets[k] === 0 ? '—' : money(s.buckets[k])}
                          </td>
                        ))}
                        <td className="tnum px-2 py-2 text-right font-semibold">{money(s.owed)}</td>
                        <td className="tnum text-accent-700 px-4 py-2 text-right">{s.credit > 0 ? money(s.credit) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-ink-200 border-t font-semibold">
                      <td className="px-4 py-2">Total</td>
                      {BUCKETS.map(([k]) => (
                        <td key={k} className="tnum px-2 py-2 text-right">
                          {money(d.totals[k])}
                        </td>
                      ))}
                      <td className="tnum px-2 py-2 text-right">{money(d.totals.total)}</td>
                      <td className="tnum px-4 py-2 text-right">{money(d.totals.credit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
