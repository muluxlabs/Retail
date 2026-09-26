/**
 * Stock count.
 *
 * This is the direct fix for IC-10027: a count that reconciled zero of 243
 * counted lines, with 571 of 814 items never counted at all. Two things this
 * screen refuses to let happen quietly:
 *
 *   - a line nobody typed a count for is not submitted as zero. Silence
 *     stays silence; it does not become a false shortage.
 *   - posting is the whole point. `postCount` writes the adjustment AND
 *     values it at weighted-average cost in one transaction - a count that
 *     sits half-entered on this screen and is never submitted changes
 *     nothing, exactly like the counts left "In progress" at Kernmaur,
 *     Mission and TM.
 *
 * A product with no history at this branch (book zero, hundreds on the
 * shelf - the Three Leaves 125g case) is addable by search, not just
 * pre-populated from what the ledger already expects.
 */

import { useEffect, useState } from 'react';

import { StockEntryTabs } from '../components/StockEntryTabs.js';
import { api, ApiError, type Branch } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

interface Row {
  productId: string;
  productName: string;
  sku: string;
  book: number;
  baseUom: string;
  counted: string;
}

type CountResult = Awaited<ReturnType<typeof api.postCount>>;

export function Count() {
  const { user } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [addSearch, setAddSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CountResult | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const stock = useAsync(
    () => (branchId === '' ? Promise.resolve({ items: [] }) : api.stock({ branchId, limit: 500 })),
    [branchId],
  );
  const addResults = useAsync(
    () =>
      addSearch.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search: addSearch, limit: 8 }),
    [addSearch],
  );

  useEffect(() => {
    if (stock.data === undefined) return;
    setRows(
      stock.data.items.map((s) => ({
        productId: s.productId,
        productName: s.productName,
        sku: s.sku,
        book: Number(s.qtyBase),
        baseUom: s.baseUom,
        counted: '',
      })),
    );
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock.data]);

  function setCounted(productId: string, value: string) {
    setRows((rs) => rs.map((r) => (r.productId === productId ? { ...r, counted: value } : r)));
  }

  function addProduct(p: { id: string; name: string; sku: string; baseUom: string }) {
    setRows((rs) =>
      rs.some((r) => r.productId === p.id)
        ? rs
        : [{ productId: p.id, productName: p.name, sku: p.sku, book: 0, baseUom: p.baseUom, counted: '' }, ...rs],
    );
    setAddSearch('');
  }

  const visible = rows.filter(
    (r) =>
      filter.trim() === '' ||
      r.productName.toLowerCase().includes(filter.toLowerCase()) ||
      r.sku.toLowerCase().includes(filter.toLowerCase()),
  );
  const entered = rows.filter((r) => r.counted.trim() !== '');

  async function submit() {
    if (user === null || entered.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.postCount({
        branchId,
        actorId: user.personId,
        lines: entered.map((r) => ({ productId: r.productId, countedBase: Number(r.counted) })),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <StockEntryTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Stock take</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Enter what you physically counted. A blank line is not submitted - it stays uncounted,
            not zero.
          </p>
        </div>
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">Select a branch…</option>
          {(branches.data ?? []).map((b: Branch) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {branchId === '' ? (
        <Card className="px-4 py-10">
          <Empty title="Choose a branch" hint="Pick a branch above to load its stock for counting." />
        </Card>
      ) : result !== null ? (
        <ResultPanel
          result={result}
          onNewCount={() => {
            setResult(null);
            stock.reload();
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter this list…"
              className="border-ink-200 focus:border-accent-500 min-w-56 flex-1 rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
            />
            <div className="relative w-full sm:w-64">
              <input
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="+ Add a product not listed…"
                className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
              />
              {addResults.data !== undefined && addResults.data.items.length > 0 && (
                <ul className="border-ink-200 absolute right-0 top-full z-10 mt-1 w-full divide-y divide-ink-100 overflow-hidden rounded-lg border bg-white shadow-lg">
                  {addResults.data.items.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => addProduct(p)}
                        className="hover:bg-ink-50 flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px]"
                      >
                        <span className="font-medium">{p.name}</span>
                        <span className="text-ink-400 font-mono text-[11px]">{p.sku}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="text-ink-400 text-[12px]">
              {entered.length} of {rows.length} lines entered
            </div>
          </div>

          {error !== null && <ErrorNote error={error} />}

          <Card className="overflow-hidden">
            {stock.loading ? (
              <div className="grid place-items-center py-16">
                <Spinner />
              </div>
            ) : visible.length === 0 ? (
              <Empty
                title="Nothing to count yet"
                hint="This branch has no stock history. Search above to add a product."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                      <th className="px-4 py-2 text-left font-medium">Product</th>
                      <th className="px-3 py-2 text-right font-medium">Book</th>
                      <th className="px-4 py-2 text-right font-medium">Counted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {visible.map((row) => {
                      const hasEntry = row.counted.trim() !== '';
                      const variance = hasEntry ? Number(row.counted) - row.book : null;
                      return (
                        <tr key={row.productId} className={hasEntry ? 'bg-accent-50/40' : ''}>
                          <td className="px-4 py-2">
                            <div className="font-medium">{row.productName}</div>
                            <div className="text-ink-400 font-mono text-[11px]">{row.sku}</div>
                          </td>
                          <td className="tnum text-ink-500 px-3 py-2 text-right">
                            {qty(row.book)} <span className="text-ink-300 text-[11px]">{row.baseUom}</span>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {variance !== null && variance !== 0 && (
                                <span className={`tnum text-[11px] ${variance < 0 ? 'text-red-600' : 'text-amber-700'}`}>
                                  {variance > 0 ? '+' : ''}
                                  {qty(variance)}
                                </span>
                              )}
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={row.counted}
                                onChange={(e) => setCounted(row.productId, e.target.value)}
                                placeholder="—"
                                className="tnum border-ink-200 focus:border-accent-500 w-24 rounded-lg border bg-white px-2 py-1 text-right outline-none"
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={() => void submit()} disabled={busy || entered.length === 0}>
              {busy ? <Spinner /> : null}
              Post count ({entered.length} line{entered.length === 1 ? '' : 's'})
            </Button>
            <span className="text-ink-400 text-[11.5px]">
              Posting values every variance at weighted-average cost and writes it to the exception
              queue.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function ResultPanel({ result, onNewCount }: { result: CountResult; onNewCount: () => void }) {
  const variances = result.lines.filter((l) => l.variance !== 0);
  return (
    <div className="space-y-4">
      <Card className="px-4 py-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Lines counted" value={String(result.summary.lines)} />
          <Stat label="Reconciled" value={String(result.summary.reconciled)} tone="good" />
          <Stat label="Variances" value={String(result.summary.variances)} tone={result.summary.variances > 0 ? 'warn' : 'good'} />
          <Stat label="Net value" value={money(result.summary.netValue)} tone={result.summary.netValue < 0 ? 'bad' : 'neutral'} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-ink-100 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Posted lines</h2>
        </div>
        {result.lines.length === 0 ? (
          <Empty title="No lines posted" />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                <th className="px-4 py-2 text-left font-medium">Line</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Counted</th>
                <th className="px-3 py-2 text-right font-medium">Variance</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {result.lines.map((l) => (
                <tr key={l.productId}>
                  <td className="text-ink-400 px-4 py-2 font-mono text-[11px]">{l.productId.slice(0, 8)}</td>
                  <td className="tnum px-3 py-2 text-right">{qty(l.expected)}</td>
                  <td className="tnum px-3 py-2 text-right">{qty(l.counted)}</td>
                  <td className={`tnum px-3 py-2 text-right font-medium ${l.variance < 0 ? 'text-red-600' : l.variance > 0 ? 'text-amber-700' : ''}`}>
                    {l.variance > 0 ? '+' : ''}
                    {qty(l.variance)}
                  </td>
                  <td className="tnum px-4 py-2 text-right">{l.valueImpact === null ? '—' : money(l.valueImpact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onNewCount}>
          Start another count
        </Button>
        {variances.length > 0 && (
          <span className="text-ink-400 text-[11.5px]">
            {variances.length} variance{variances.length === 1 ? '' : 's'} posted to the exception
            queue for review.
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const color =
    tone === 'good' ? 'text-accent-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-600' : 'text-ink-900';
  return (
    <div>
      <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">{label}</div>
      <div className={`tnum mt-0.5 text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
