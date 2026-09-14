/**
 * The raw ledger.
 *
 * This screen exists because the audit trail IS the storage format, and the
 * sponsor is an auditor. Nothing here is a summary: it is the movement rows,
 * newest first, with the backdate gap shown as its own column so that
 * recording long after the fact is visible rather than inferable.
 */

import { useState } from 'react';

import { api } from '../lib/api.js';
import { Badge, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

export function Ledger() {
  const [branchId, setBranchId] = useState('');
  const branches = useAsync(() => api.branches(), []);
  const movements = useAsync(
    () => api.movements({ ...(branchId === '' ? {} : { branchId }), limit: 200 }),
    [branchId],
  );

  const items = movements.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Stock ledger</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Append-only. Nothing here is ever edited or deleted; corrections are new rows that
            reverse old ones.
          </p>
        </div>
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">All branches</option>
          {(branches.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      {movements.error !== undefined && <ErrorNote error={movements.error} />}

      <Card className="overflow-hidden">
        {movements.loading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : items.length === 0 ? (
          <Empty title="No movements" hint="Receipts, sales, transfers and count adjustments all appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                  <th className="px-4 py-2 text-left font-medium">Seq</th>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Branch</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-left font-medium">Reason</th>
                  <th className="px-3 py-2 text-left font-medium">Occurred</th>
                  <th className="px-4 py-2 text-right font-medium">Lag</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((m) => (
                  <tr key={m.seq} className="hover:bg-ink-50/60">
                    <td className="text-ink-300 tnum px-4 py-2 font-mono text-[11px]">{m.seq}</td>
                    <td className="px-3 py-2">
                      <div className="max-w-56 truncate font-medium">{m.productName}</div>
                      <div className="text-ink-400 font-mono text-[10.5px]">{m.sku}</div>
                    </td>
                    <td className="text-ink-600 px-3 py-2">{m.branchCode}</td>
                    <td className={`tnum px-3 py-2 text-right font-medium ${m.qtyBase < 0 ? 'text-red-600' : 'text-accent-700'}`}>
                      {m.qtyBase > 0 ? '+' : ''}{qty(m.qtyBase)}
                    </td>
                    <td className="tnum text-ink-500 px-3 py-2 text-right">
                      {m.unitCost === null ? '—' : money(Number(m.unitCost))}
                    </td>
                    <td className="text-ink-600 px-3 py-2">
                      {m.reason.replace(/_/g, ' ')}
                      {m.reversesSeq !== null && <Badge tone="info">reverses {m.reversesSeq}</Badge>}
                    </td>
                    <td className="text-ink-500 px-3 py-2">
                      {new Date(m.occurredAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {Number(m.backdateGapHours) > 48 ? (
                        <Badge tone="warn">{Math.round(Number(m.backdateGapHours) / 24)}d late</Badge>
                      ) : (
                        <span className="text-ink-300 text-[11px]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
