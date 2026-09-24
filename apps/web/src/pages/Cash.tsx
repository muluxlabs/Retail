/**
 * Cash custody.
 *
 * "Blind" here is a real UI guarantee, not just a label: the count form
 * below never fetches or displays the expected balance before you submit
 * a count. It cannot - a cashier holds cash.count but never cash.read, so
 * the API itself would refuse the request this screen would need to make
 * to cheat. The variance only appears in the response after posting.
 */

import { useState } from 'react';

import { api, ApiError, type Branch, type CashPointKind, type CashPointPosition, type CashPointRef } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Empty, ErrorNote, money, Spinner, timeAgo, useAsync } from '../lib/ui.js';

const KIND_LABEL: Record<string, string> = { till: 'Till', safe: 'Safe', petty: 'Petty cash', bank: 'Bank' };

export function Cash() {
  const { can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [moving, setMoving] = useState(false);
  const [counting, setCounting] = useState(false);
  const [creating, setCreating] = useState(false);

  const branches = useAsync(() => api.branches(), []);
  const positions = useAsync(
    () => (can('cash.read') ? api.cashPositions({ ...(branchId === '' ? {} : { branchId }) }) : Promise.resolve({ items: [] })),
    [branchId, can('cash.read')],
  );
  const ledger = useAsync(
    () => (can('cash.read') ? api.cashLedger({ limit: 12 }) : Promise.resolve({ items: [] })),
    [can('cash.read')],
  );

  const total = (positions.data?.items ?? []).reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cash custody</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Till, safe, petty cash and bank. A count is blind - it is posted before anyone sees
            whether it matched.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can('cash.count') && (
            <Button variant="primary" onClick={() => setCounting((v) => !v)}>
              {counting ? 'Close' : 'Blind count'}
            </Button>
          )}
          {can('cash.move') && (
            <Button onClick={() => setMoving((v) => !v)}>{moving ? 'Close' : 'Move cash'}</Button>
          )}
          {can('cash.move') && (
            <Button onClick={() => setCreating((v) => !v)}>{creating ? 'Close' : 'Add custody point'}</Button>
          )}
        </div>
      </div>

      {creating && (
        <CreatePointForm
          onDone={() => {
            setCreating(false);
            positions.reload();
          }}
        />
      )}

      {counting && (
        <CountForm
          onDone={() => {
            setCounting(false);
            positions.reload();
            ledger.reload();
          }}
        />
      )}

      {moving && (
        <MoveForm
          onDone={() => {
            setMoving(false);
            positions.reload();
            ledger.reload();
          }}
        />
      )}

      {can('cash.read') ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
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
            <div className="text-ink-400 text-[12px]">
              {positions.data !== undefined && `Total shown: ${money(total)}`}
            </div>
          </div>

          {positions.error !== undefined && <ErrorNote error={positions.error} />}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="overflow-hidden">
              {positions.loading ? (
                <div className="grid place-items-center py-16">
                  <Spinner />
                </div>
              ) : (positions.data?.items.length ?? 0) === 0 ? (
                <Empty title="No custody points" />
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                      <th className="px-4 py-2 text-left font-medium">Branch</th>
                      <th className="px-3 py-2 text-left font-medium">Point</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {(positions.data?.items ?? []).map((p: CashPointPosition) => (
                      <tr key={p.id} className="hover:bg-ink-50/60">
                        <td className="text-ink-600 px-4 py-2">{p.branchCode}</td>
                        <td className="px-3 py-2">
                          <span className="font-medium">{p.name}</span>
                          <Badge tone="neutral">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                        </td>
                        <td
                          className={`tnum px-4 py-2 text-right font-medium ${
                            Number(p.amount) < 0 ? 'text-red-600' : ''
                          }`}
                        >
                          {money(Number(p.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Card>

            <Card className="overflow-hidden">
              <div className="border-ink-100 border-b px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight">Recent activity</h2>
              </div>
              {(ledger.data?.items.length ?? 0) === 0 ? (
                <Empty title="Nothing recorded yet" />
              ) : (
                <ul className="divide-ink-100 divide-y">
                  {(ledger.data?.items ?? []).map((m) => (
                    <li key={m.seq} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                      <span
                        className={`tnum w-16 shrink-0 font-medium ${
                          Number(m.amount) < 0 ? 'text-red-600' : 'text-accent-700'
                        }`}
                      >
                        {Number(m.amount) > 0 ? '+' : ''}
                        {money(Number(m.amount))}
                      </span>
                      <span className="text-ink-600 min-w-0 flex-1 truncate">
                        {m.cashPointName} · {m.reason.replace(/_/g, ' ')}
                      </span>
                      <span className="text-ink-300 shrink-0 text-[11px]">{timeAgo(m.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      ) : (
        <Card className="px-4 py-10">
          <Empty
            title="Positions are not shown here"
            hint="Your role can count and move cash, but cannot see custody balances - that separation is what keeps a count blind."
          />
        </Card>
      )}
    </div>
  );
}

function CountForm({ onDone }: { onDone: () => void }) {
  const [cashPointId, setCashPointId] = useState('');
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ variance: number; counted: number } | null>(null);

  const points = useAsync(() => api.cashPoints(), []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.postCashCount({ cashPointId, countedAmount: Number(counted) });
      setResult({ variance: r.variance, counted: r.counted });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) {
    return (
      <Card className="px-4 py-4">
        <div className="text-[13px] font-medium">Count posted: {money(result.counted)}</div>
        {result.variance === 0 ? (
          <p className="text-accent-700 mt-1 text-[12.5px]">Reconciled exactly - no variance.</p>
        ) : (
          <p className="mt-1 text-[12.5px]">
            <span className={result.variance < 0 ? 'text-red-600' : 'text-amber-700'}>
              {result.variance > 0 ? 'Over' : 'Short'} by {money(Math.abs(result.variance))}.
            </span>{' '}
            Logged to the exception queue for review.
          </p>
        )}
        <Button className="mt-3" onClick={onDone}>
          Done
        </Button>
      </Card>
    );
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-ink-500 text-[12px]">
          Count the physical cash first, then enter it below. The system does not show you what it
          expects until after you submit.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Custody point
            </span>
            <select
              required
              value={cashPointId}
              onChange={(e) => setCashPointId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select…</option>
              {(points.data?.items ?? []).map((p: CashPointRef) => (
                <option key={p.id} value={p.id}>
                  {p.branchCode} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Counted amount
            </span>
            <input
              required
              type="number"
              min="0"
              step="0.01"
              autoFocus
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>
        </div>
        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          Submit count
        </Button>
      </form>
    </Card>
  );
}

function MoveForm({ onDone }: { onDone: () => void }) {
  const [fromCashPointId, setFrom] = useState('');
  const [toCashPointId, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<'float_issue' | 'float_return' | 'bank_deposit'>('float_issue');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const points = useAsync(() => api.cashPoints(), []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.moveCash({ fromCashPointId, toCashPointId, amount: Number(amount), reason });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">From</span>
            <select
              required
              value={fromCashPointId}
              onChange={(e) => setFrom(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select…</option>
              {(points.data?.items ?? []).map((p: CashPointRef) => (
                <option key={p.id} value={p.id}>
                  {p.branchCode} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">To</span>
            <select
              required
              value={toCashPointId}
              onChange={(e) => setTo(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select…</option>
              {(points.data?.items ?? []).map((p: CashPointRef) => (
                <option key={p.id} value={p.id}>
                  {p.branchCode} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Amount</span>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as typeof reason)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="float_issue">Float issue</option>
              <option value="float_return">Float return</option>
              <option value="bank_deposit">Bank deposit</option>
            </select>
          </label>
        </div>
        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          Move cash
        </Button>
      </form>
    </Card>
  );
}

function CreatePointForm({ onDone }: { onDone: () => void }) {
  const [branchId, setBranchId] = useState('');
  const [kind, setKind] = useState<CashPointKind>('safe');
  const [name, setName] = useState('');
  const [openingAmount, setOpeningAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const branches = useAsync(() => api.branches(), []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createCashPoint({
        branchId,
        kind,
        name,
        openingAmount: openingAmount === '' ? 0 : Number(openingAmount),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-ink-500 text-[12px]">
          Safe, petty cash and bank are one per branch. A till is created from terminal setup, not
          here.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Branch
            </span>
            <select
              required
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select…</option>
              {(branches.data ?? []).map((b: Branch) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as CashPointKind)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="safe">Safe</option>
              <option value="petty">Petty cash</option>
              <option value="bank">Bank</option>
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Name
            </span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main safe"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Opening balance
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
              placeholder="0.00"
              className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>
        </div>
        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          Create custody point
        </Button>
      </form>
    </Card>
  );
}
