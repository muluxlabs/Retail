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

import { ScanQty, type ScanHit } from '../components/ScanQty.js';
import { StockEntryTabs } from '../components/StockEntryTabs.js';
import { api, ApiError, type Branch } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useMyBranches } from '../lib/myBranches.js';
import { parseCountText } from '../lib/countText.js';
import { COUNT_TEMPLATE_COLUMNS, findColumn, readSpreadsheet, writeTemplate } from '../lib/spreadsheet.js';
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
  const [uploadReport, setUploadReport] = useState<{ filled: number; notFound: string[]; bad: string[]; packs: string[] } | null>(null);

  const branches = useMyBranches();
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

  /**
   * A scanned count: n of the scanned pack, in base units, ADDED to what is already counted for the item
   * (the same item on the shelf and in the store room adds up). A negative n takes an entry back.
   */
  function addScanned(hit: ScanHit, n: number) {
    const base = n * hit.qtyBase;
    const shown = (v: number) => String(Math.round(v * 10_000) / 10_000);
    setRows((rs) => {
      const row = rs.find((r) => r.productId === hit.productId);
      if (row === undefined) {
        if (base <= 0) return rs;
        return [{ productId: hit.productId, productName: hit.productName, sku: hit.sku, book: 0, baseUom: '', counted: shown(base) }, ...rs];
      }
      const before = row.counted.trim() === '' ? 0 : Number(row.counted);
      const after = (Number.isFinite(before) ? before : 0) + base;
      return rs.map((r) => (r.productId === hit.productId ? { ...r, counted: after <= 0 ? '' : shown(after) } : r));
    });
    setFilter('');
  }

  /** A count sheet for this branch: every item on the list, with a blank Counted column to fill in. */
  function downloadCountSheet() {
    const branchName = branches.list.find((b) => b.id === branchId)?.name ?? 'branch';
    void writeTemplate({
      fileName: `count-sheet-${branchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      sheet: 'Count',
      columns: COUNT_TEMPLATE_COLUMNS,
      notes: [
        'Fill in Counted for what you counted. Leave a line blank if you did not count it: blank is not zero.',
        'Add rows at the bottom for items not listed. With a SKU, count in the item’s base unit; with a pack’s barcode, count packs (5 cases of 24 = 120).',
        'The same item on several rows adds up (loose singles on one row, full cases on another).',
      ],
      rows: rows.map((r) => [r.sku, r.productName, r.baseUom, '']),
    });
  }

  /** Counts from a file fill in the Counted column; nothing is posted until Post count. */
  async function uploadCounts(file: File) {
    setError(null);
    try {
      const sh = await readSpreadsheet(file);
      const codeCol = findColumn(sh.headings, ['sku', 'code', 'barcode', 'item code', 'product code', 'sku or barcode']);
      const countCol = findColumn(sh.headings, ['counted', 'count', 'quantity', 'qty', 'physical', 'on shelf']);
      if (codeCol === undefined || countCol === undefined) {
        setError('The file needs an SKU (or barcode) column and a Counted column. Download the count sheet to see the layout.');
        return;
      }
      const bySku = new Map(rows.map((r) => [r.sku.toLowerCase(), r.productId]));
      // Base units counted per item. The same item on several rows adds up (loose singles plus full cases).
      const totals = new Map<string, number>();
      const add = (productId: string, base: number) => totals.set(productId, (totals.get(productId) ?? 0) + base);
      const added: Row[] = [];
      const notFound: string[] = [];
      const bad: string[] = [];
      const packs: string[] = [];
      for (const [i, r] of sh.rows.entries()) {
        const code = (r[codeCol] ?? '').trim();
        const text = (r[countCol] ?? '').trim();
        if (code === '' || text === '') continue; // not counted stays not counted
        const n = parseCountText(text);
        if (!n.ok) {
          bad.push(`Row ${i + 2} (${code}): ${n.reason}`);
          continue;
        }
        // A SKU: counted in the item's base unit.
        const known = bySku.get(code.toLowerCase()) ?? added.find((a) => a.sku.toLowerCase() === code.toLowerCase())?.productId;
        if (known !== undefined) {
          add(known, n.value);
          continue;
        }
        // A barcode: counted in packs of the pack it is printed on - 5 of a case of 24 is 120.
        try {
          const hit = await api.resolveBarcode(code);
          const base = n.value * Number(hit.qtyBase);
          if (Number(hit.qtyBase) !== 1) packs.push(`${hit.productName}: ${n.value} × ${hit.packLabel} = ${base}`);
          if (!bySku.has(hit.sku.toLowerCase()) && !added.some((a) => a.productId === hit.productId)) {
            added.push({ productId: hit.productId, productName: hit.productName, sku: hit.sku, book: 0, baseUom: '', counted: '' });
          }
          add(hit.productId, base);
          continue;
        } catch {
          /* not a barcode: try it as a SKU of an item not on the list */
        }
        const found = (await api.products({ search: code, limit: 5 })).items.find((p) => p.sku.toLowerCase() === code.toLowerCase());
        if (found === undefined) {
          notFound.push(code);
          continue;
        }
        added.push({ productId: found.id, productName: found.name, sku: found.sku, book: 0, baseUom: found.baseUom, counted: '' });
        add(found.id, n.value);
      }
      const shown = (v: number) => String(Math.round(v * 10_000) / 10_000);
      setRows((rs) => {
        const listed = new Set(rs.map((r) => r.productId));
        const fresh = added.filter((a) => !listed.has(a.productId));
        return [...fresh, ...rs].map((r) => (totals.has(r.productId) ? { ...r, counted: shown(totals.get(r.productId)!) } : r));
      });
      setUploadReport({ filled: totals.size, notFound, bad, packs });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
          {branches.list.map((b: Branch) => (
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
            <Button onClick={downloadCountSheet} disabled={rows.length === 0}>
              Download count sheet
            </Button>
            <label className="border-ink-200 text-ink-700 hover:bg-ink-50 inline-flex cursor-pointer items-center rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] font-medium">
              Upload counts…
              <input
                type="file"
                accept=".xlsx,.csv,.txt,.tsv"
                className="hidden"
                aria-label="Count file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f !== undefined) void uploadCounts(f);
                }}
              />
            </label>
          </div>

          <ScanQty
            storeKey="count"
            title="Count by scanning: scan an item, type how many are on this shelf, Enter. Scanning it again elsewhere adds up."
            onAdd={addScanned}
          />

          {uploadReport !== null && (
            <div className="border-accent-300/60 bg-accent-50 rounded-lg border px-3 py-2 text-[12.5px]" data-testid="count-upload-report">
              <b>{uploadReport.filled}</b> count{uploadReport.filled === 1 ? '' : 's'} filled in from the file — check them below, then post.
              {uploadReport.notFound.length > 0 && <div className="text-amber-800">Not found: {uploadReport.notFound.slice(0, 20).join(', ')}{uploadReport.notFound.length > 20 && ` and ${uploadReport.notFound.length - 20} more`}</div>}
              {uploadReport.packs.length > 0 && (
                <div className="text-ink-600">Counted by pack barcode: {uploadReport.packs.slice(0, 8).join('; ')}{uploadReport.packs.length > 8 && ` and ${uploadReport.packs.length - 8} more`}.</div>
              )}
              {uploadReport.bad.length > 0 && <div className="text-red-700">Left out — {uploadReport.bad.slice(0, 10).join('; ')}</div>}
            </div>
          )}

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
