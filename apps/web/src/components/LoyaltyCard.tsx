/**
 * A customer's loyalty points: the balance, what it is worth at the till, every
 * movement, and (for managers) adding or taking away points with a reason.
 */

import { useState } from 'react';

import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { shortDateTime } from '../lib/buying.js';
import { Badge, Button, Card, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

const REASON: Record<string, string> = { earn: 'Earned', redeem: 'Spent', adjust: 'Adjusted' };

export function LoyaltyCard({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const d = useAsync(() => api.customerPoints(customerId), [customerId]);
  const [adjusting, setAdjusting] = useState(false);
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const p = d.data;
  if (p === undefined) {
    return (
      <Card className="grid place-items-center py-6">
        <Spinner />
      </Card>
    );
  }
  if (!p.enabled && p.movements.length === 0) return null;

  const n = Number(points);
  const pointsOk = points.trim() !== '' && Number.isInteger(n) && n !== 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.adjustPoints(customerId, { id, points: n, note: note.trim() });
      setAdjusting(false);
      setPoints('');
      setNote('');
      setId(crypto.randomUUID());
      d.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight">
            Loyalty points {!p.enabled && <Badge tone="neutral">Switched off</Badge>}
          </h2>
          <p className="text-ink-400 text-[11.5px]">
            {p.earned.toLocaleString()} earned · {p.redeemed.toLocaleString()} spent
            {p.adjusted !== 0 && ` · ${p.adjusted > 0 ? '+' : ''}${p.adjusted.toLocaleString()} adjusted`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="tnum text-xl font-semibold" data-testid="points-balance">
              {p.points.toLocaleString()} pts
            </div>
            <div className="text-ink-500 text-[11.5px]">worth {money(p.worth)}</div>
          </div>
          {can('loyalty.adjust') && (
            <Button className="no-print" onClick={() => setAdjusting((v) => !v)}>
              {adjusting ? 'Cancel' : 'Adjust points'}
            </Button>
          )}
        </div>
      </div>
      {adjusting && (
        <div className="border-ink-100 grid gap-3 border-b px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-end">
          <label className="block">
            <span className={label}>Points (+ or −)</span>
            <input inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="e.g. 100 or -50" aria-label="Points to add" className={`${field} tnum text-right`} />
          </label>
          <label className="block">
            <span className={label}>Reason</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the points are changing" aria-label="Reason for the change" className={field} />
          </label>
          <Button variant="primary" onClick={() => void save()} disabled={!pointsOk || note.trim().length < 5 || busy}>
            {busy ? <Spinner /> : null}
            Save
          </Button>
          {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800 sm:col-span-3">{error}</div>}
          <p className="text-ink-400 text-[11.5px] sm:col-span-3">Points are worth money at the till: every change is raised for review with its reason.</p>
        </div>
      )}
      {p.movements.length === 0 ? (
        <p className="text-ink-400 px-4 py-4 text-[12.5px]">No points yet. They are earned on sales where this customer is named.</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-[12.5px]" data-testid="points-history">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-2 py-2 font-medium">What</th>
                <th className="px-2 py-2 font-medium">Where / by</th>
                <th className="px-4 py-2 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {p.movements.map((m) => (
                <tr key={m.seq}>
                  <td className="px-4 py-1.5 whitespace-nowrap">{shortDateTime(m.at)}</td>
                  <td className="px-2 py-1.5">
                    {REASON[m.reason] ?? m.reason}
                    {m.receiptNo !== null && (
                      <>
                        {' on '}
                        <span className="font-mono">{m.receiptNo}</span>
                      </>
                    )}
                    {m.note !== null && <span className="text-ink-500"> · {m.note}</span>}
                  </td>
                  <td className="text-ink-500 px-2 py-1.5">
                    {m.branchName} · {m.byName}
                  </td>
                  <td className={`tnum px-4 py-1.5 text-right font-medium ${m.points < 0 ? 'text-red-700' : 'text-accent-700'}`}>
                    {m.points > 0 ? '+' : ''}
                    {m.points.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
