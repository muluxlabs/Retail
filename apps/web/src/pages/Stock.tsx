/**
 * Stock by branch.
 *
 * The "below zero only" filter is the screen their staff most needed and did
 * not have: it lists positions the ledger says are impossible, which is where
 * the override problem shows itself.
 */

import { useState } from 'react';

import { api } from '../lib/api.js';
import { Badge, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

export function Stock() {
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [negativeOnly, setNegativeOnly] = useState(false);

  const branches = useAsync(() => api.branches(), []);
  const stock = useAsync(
    () =>
      api.stock({
        ...(branchId === '' ? {} : { branchId }),
        ...(search === '' ? {} : { search }),
        ...(negativeOnly ? { negativeOnly: true } : {}),
        limit: 400,
      }),
    [branchId, search, negativeOnly],
  );

  const items = stock.data?.items ?? [];
  const totalValue = items.reduce((sum, i) => sum + Number(i.value), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Stock on hand</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Summed from the ledger on every request. Valued at weighted-average cost.
          </p>
        </div>
        <div className="text-right">
          <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">
            Shown
          </div>
          <div className="tnum text-base font-semibold">{money(totalValue)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product or SKU…"
          className="border-ink-200 focus:border-accent-500 min-w-56 flex-1 rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
        />
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
        <button
          onClick={() => setNegativeOnly((v) => !v)}
          className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset transition ${
            negativeOnly
              ? 'bg-red-600 text-white ring-red-600'
              : 'ring-ink-200 text-ink-600 hover:bg-ink-50 bg-white'
          }`}
        >
          Below zero only
        </button>
      </div>

      {stock.error !== undefined && <ErrorNote error={stock.error} />}

      <Card className="overflow-hidden">
        {stock.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title={negativeOnly ? 'Nothing below zero' : 'No stock matches'}
            hint={
              negativeOnly
                ? 'No branch is holding a position the ledger says is impossible.'
                : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                  <th className="px-4 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Branch</th>
                  <th className="px-3 py-2 text-right font-medium">On hand</th>
                  <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((line) => (
                  <tr
                    key={`${line.productId}-${line.branchId}`}
                    className="hover:bg-ink-50/60"
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium">{line.productName}</div>
                      <div className="text-ink-400 font-mono text-[11px]">{line.sku}</div>
                    </td>
                    <td className="text-ink-600 px-3 py-2">{line.branchCode}</td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`tnum font-medium ${
                          Number(line.qtyBase) < 0 ? 'text-red-600' : ''
                        }`}
                      >
                        {qty(line.qtyBase)}
                      </span>
                      <span className="text-ink-400 ml-1 text-[11px]">{line.baseUom}</span>
                    </td>
                    <td className="tnum text-ink-500 px-3 py-2 text-right">
                      {line.wac === null ? (
                        <Badge tone="warn">no cost</Badge>
                      ) : (
                        money(Number(line.wac))
                      )}
                    </td>
                    <td className="tnum px-4 py-2 text-right font-medium">
                      {money(Number(line.value))}
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
