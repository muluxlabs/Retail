/**
 * Sales receipts: every till receipt, newest first, each one reprintable.
 *
 * A receipt is an immutable document: nothing here edits or deletes one. A
 * mistake is corrected by a later return or void, which keeps the trail an
 * auditor needs.
 */

import { useState } from 'react';

import { ReceiptDialog } from '../components/Receipt.js';
import { ReportTabs } from '../components/ReportTabs.js';
import { api, ApiError, type Receipt } from '../lib/api.js';
import { Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const PAGE = 50;

export function Sales() {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const list = useAsync(
    () =>
      api.sales({
        ...(branchId === '' ? {} : { branchId }),
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        limit: PAGE,
        offset: page * PAGE,
      }),
    [branchId, from, to, q, page],
  );

  const items = list.data?.items ?? [];
  const shownTotal = items.reduce((s, r) => s + r.net, 0);

  async function open(id: string) {
    setError(null);
    try {
      setReceipt(await api.receipt(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';

  return (
    <div className="space-y-4">
      <ReportTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sales receipts</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Every sale, newest first. Open one to see it as printed, or to print it again.
        </p>
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Branch</span>
            <select
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setPage(0);
              }}
              className={field}
            >
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(0);
              }}
              className={field}
            />
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(0);
              }}
              className={field}
            />
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Receipt no.</span>
            <input
              value={q}
              placeholder="e.g. HRE-0001"
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              className={`${field} w-36 font-mono`}
            />
          </label>
        </div>
      </Card>

      {list.error !== undefined && <ErrorNote error={list.error} />}
      {error !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>
      )}

      <Card className="overflow-hidden">
        {list.loading && items.length === 0 ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No receipts match" hint="Widen the dates, or clear the receipt number." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Receipt</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Branch</th>
                  <th className="px-2 py-2 font-medium">Cashier</th>
                  <th className="px-2 py-2 text-right font-medium">Items</th>
                  <th className="px-2 py-2 font-medium">Paid by</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/60" data-testid="sale-row">
                    <td className="px-4 py-2 font-mono font-medium">{r.receiptNo}</td>
                    <td className="text-ink-600 px-2 py-2 whitespace-nowrap">
                      {new Date(r.occurredAt).toLocaleString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-2 py-2">{r.branchName}</td>
                    <td className="text-ink-600 px-2 py-2">{r.cashierName}</td>
                    <td className="tnum px-2 py-2 text-right">{r.itemCount}</td>
                    <td className="text-ink-600 px-2 py-2">{r.paidBy ?? '—'}</td>
                    <td className="tnum px-2 py-2 text-right font-medium">{money(r.net)}</td>
                    <td className="px-2 py-2 text-right">
                      <button className="text-accent-700 text-[12px] hover:underline" onClick={() => void open(r.id)}>
                        View / print
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-ink-200 border-t font-medium">
                  <td className="px-4 py-2" colSpan={6}>
                    Total of the {items.length} shown
                  </td>
                  <td className="tnum px-2 py-2 text-right">{money(shownTotal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {(page > 0 || items.length === PAGE) && (
          <div className="border-ink-100 flex items-center justify-between border-t px-4 py-2 text-[12px]">
            <span className="text-ink-500">Page {page + 1}</span>
            <span className="flex gap-2">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Newer
              </Button>
              <Button variant="ghost" disabled={items.length < PAGE} onClick={() => setPage((p) => p + 1)}>
                Older
              </Button>
            </span>
          </div>
        )}
      </Card>

      {receipt !== null && <ReceiptDialog receipt={receipt} closeLabel="Close" onClose={() => setReceipt(null)} />}
    </div>
  );
}
