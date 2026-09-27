/**
 * Importing items from a spreadsheet.
 *
 * 1. Download the template (Excel or CSV) — the columns, an example, and what
 *    each column means.
 * 2. Upload the filled file (Excel .xlsx or CSV), or paste rows copied from a
 *    spreadsheet. Nothing is saved yet: every row is checked, and problems are
 *    shown by row and column.
 * 3. Import. The good items are created in one go; items already in the item
 *    master are skipped, never duplicated; items that only LOOK like existing
 *    ones are created only if ticked "create anyway"; problem rows can be
 *    downloaded, fixed and uploaded again. Stock on hand in the file comes in
 *    as opening stock at the branch chosen here.
 * 4. The report, item by item, stays on this screen.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, type ItemImportCheck } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { shortDateTime } from '../lib/buying.js';
import { downloadCsv } from '../lib/csv.js';
import { useMyBranches } from '../lib/myBranches.js';
import { IMPORT_TEMPLATE, parseDelimited, readSpreadsheet, writeTemplateXlsx } from '../lib/spreadsheet.js';
import { Badge, Button, Card, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

/** "1 item", "3 items". */
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface Loaded {
  fileName: string | null;
  headings: string[];
  rows: Record<string, string>[];
}

export function ItemImport() {
  const { can } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [check, setCheck] = useState<ItemImportCheck | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<Awaited<ReturnType<typeof api.importItems>> | null>(null);
  const history = useAsync(() => api.itemImports(), [done]);
  const branches = useMyBranches();
  /** Look-alikes the importer has decided to create anyway. */
  const [createAnyway, setCreateAnyway] = useState<Set<string>>(new Set());
  const [bringStock, setBringStock] = useState(true);
  const [stockBranch, setStockBranch] = useState('');

  async function load(l: Loaded) {
    setBusy(true);
    setError(null);
    setDone(null);
    setCheck(null);
    try {
      if (l.rows.length === 0) throw new Error('The file has no rows under its heading row.');
      setLoaded(l);
      setCheck(await api.checkItemImport({ headings: l.headings, rows: l.rows }));
      setCreateAnyway(new Set());
      setId(crypto.randomUUID());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File | undefined) {
    if (f === undefined) return;
    try {
      const sheet = await readSpreadsheet(f);
      await load({ fileName: f.name, ...sheet });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport() {
    if (loaded === null) return;
    setBusy(true);
    setError(null);
    try {
      const withStock = (check?.summary.withStock ?? 0) > 0 && check?.mayOpenStock === true && bringStock;
      setDone(
        await api.importItems({
          id, fileName: loaded.fileName, headings: loaded.headings, rows: loaded.rows,
          confirmSimilar: [...createAnyway], stockBranchId: withStock ? stockBranch : null,
        }),
      );
      setCheck(null);
      setLoaded(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function downloadProblems() {
    if (loaded === null || check === null) return;
    const byRow = new Map<number, string[]>();
    for (const p of check.problems) byRow.set(p.row, [...(byRow.get(p.row) ?? []), `${p.column === null ? '' : `${p.column}: `}${p.message}`]);
    const rows = [...byRow.keys()].filter((r) => r > 1).sort((a, b) => a - b);
    downloadCsv('items-to-fix.csv', [...loaded.headings, 'Problem'], rows.map((r) => [...loaded.headings.map((h) => loaded.rows[r - 2]?.[h] ?? ''), byRow.get(r)!.join(' | ')]));
  }

  const s = check?.summary;
  const newItems = check?.items.filter((i) => i.status === 'new') ?? [];
  const existing = check?.items.filter((i) => i.status === 'exists') ?? [];
  const similar = check?.items.filter((i) => i.status === 'similar') ?? [];
  const hasPrices = newItems.some((i) => i.packs.some((p) => p.sellPrice !== null));
  const toCreate = newItems.length + similar.filter((i) => createAnyway.has(i.key)).length;
  const stockMatters = (s?.withStock ?? 0) > 0 && check?.mayOpenStock === true && bringStock;
  const needsBranch = stockMatters && stockBranch === '';
  const toggle = (key: string) =>
    setCreateAnyway((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="text-ink-400 text-[12px]">
        <Link to="/products" className="hover:text-ink-700 hover:underline">
          Item master
        </Link>{' '}
        / Import items
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Import items from a spreadsheet</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Add hundreds or thousands of items at once from Excel or CSV: one row per pack. Nothing is saved until you have checked the preview.
        </p>
      </div>

      {/* 1. the template */}
      <Card className="px-4 py-4">
        <h2 className="text-[13px] font-semibold tracking-tight">1. Get the template</h2>
        <p className="text-ink-500 mt-0.5 mb-3 text-[12.5px]">
          One row per pack. Rows with the same SKU (or, with no SKU, the same item name) become one item with several packs. Only <b>Item name</b>, <b>Pack</b> and{' '}
          <b>Units in pack</b> are needed.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void writeTemplateXlsx()}>
            Download Excel template
          </Button>
          <Button onClick={() => downloadCsv('item-import-template.csv', IMPORT_TEMPLATE.map((c) => c.heading), IMPORT_TEMPLATE[0]!.examples.map((_, i) => IMPORT_TEMPLATE.map((c) => c.examples[i] ?? '')))}>
            Download CSV template
          </Button>
        </div>
        <details className="mt-3">
          <summary className="text-accent-700 cursor-pointer text-[12.5px] font-medium">What goes in each column</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="template-columns">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="py-1.5 pr-3 font-medium">Column</th>
                  <th className="py-1.5 pr-3 font-medium">Needed?</th>
                  <th className="py-1.5 pr-3 font-medium">What to put</th>
                  <th className="py-1.5 font-medium">Example</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {IMPORT_TEMPLATE.map((c) => (
                  <tr key={c.heading}>
                    <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{c.heading}</td>
                    <td className="py-1.5 pr-3">{c.required ? <Badge tone="warn">needed</Badge> : <span className="text-ink-400">optional</span>}</td>
                    <td className="text-ink-600 py-1.5 pr-3">{c.help}</td>
                    <td className="py-1.5 font-mono text-[11.5px]">{c.examples[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-ink-500 mt-2 text-[12px]">
            Tip: in Excel, format the <b>Barcode</b> column as <b>Text</b> before typing, or long barcodes turn into numbers like 6.0E+12.
          </p>
        </details>
      </Card>

      {/* 2. the file */}
      <Card className="space-y-3 px-4 py-4">
        <h2 className="text-[13px] font-semibold tracking-tight">2. Upload the filled file</h2>
        <label className="block">
          <span className={label}>Excel (.xlsx) or CSV file</span>
          <input
            type="file"
            accept=".xlsx,.csv,.txt,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
            aria-label="Item spreadsheet"
            className="text-[12.5px]"
          />
        </label>
        <details>
          <summary className="text-accent-700 cursor-pointer text-[12.5px] font-medium">…or paste rows copied from a spreadsheet</summary>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            placeholder={'Copy the rows including the heading row, then paste here.'}
            aria-label="Pasted rows"
            className="border-ink-200 focus:border-accent-500 mt-2 w-full rounded-lg border bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none"
          />
          <Button className="mt-2" onClick={() => void load({ fileName: null, ...parseDelimited(paste) })} disabled={paste.trim() === '' || busy}>
            Check the pasted rows
          </Button>
        </details>
        {busy && check === null && (
          <div className="text-ink-500 flex items-center gap-2 text-[12.5px]">
            <Spinner /> Checking every row…
          </div>
        )}
        {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      </Card>

      {/* 3. the preview */}
      {check !== null && s !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="import-summary">
            {(
              [
                ['Rows read', s.rows, ''],
                ['New items', s.newItems, 'text-accent-700'],
                ['New packs', s.newPacks, ''],
                ['Already in the item master', s.existing, s.existing > 0 ? 'text-ink-500' : ''],
                ['Look like existing items', s.similar, s.similar > 0 ? 'text-amber-700' : ''],
                ['Rows with problems', s.problemRows, s.problemRows > 0 ? 'text-red-700' : ''],
                ['New categories', check.newCategories.length, ''],
              ] as const
            ).map(([t, v, tone]) => (
              <Card key={t} className="px-3 py-2.5">
                <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">{t}</div>
                <div className={`tnum mt-0.5 text-xl font-semibold ${tone}`}>{v.toLocaleString()}</div>
              </Card>
            ))}
          </div>

          {check.columns.some((c) => c.field === null) && (
            <p className="text-ink-500 text-[12.5px]">
              Columns not used: {check.columns.filter((c) => c.field === null).map((c) => `“${c.heading}”`).join(', ')}.
            </p>
          )}
          {hasPrices && !check.mayPrice && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
              The file has selling prices, but setting prices needs price access: the items will be created without prices, to be priced on the Prices screen.
            </div>
          )}
          {check.newCategories.length > 0 && <p className="text-ink-600 text-[12.5px]">New categories to be created: {check.newCategories.join(', ')}.</p>}

          {check.problems.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight text-red-800">Rows that will be left out ({s.problemRows})</h2>
                <Button onClick={downloadProblems}>Download these rows to fix</Button>
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-[12.5px]" data-testid="import-problems">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 font-medium">Row</th>
                      <th className="px-2 py-2 font-medium">Column</th>
                      <th className="px-4 py-2 font-medium">Problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {check.problems.slice(0, 300).map((p, i) => (
                      <tr key={i}>
                        <td className="tnum px-4 py-1.5">{p.row}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{p.column ?? '—'}</td>
                        <td className="px-4 py-1.5">{p.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {similar.length > 0 && (
            <Card className="overflow-hidden border-amber-200" data-testid="import-similar">
              <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b bg-amber-50/60 px-4 py-2.5">
                <div>
                  <h2 className="text-[13px] font-semibold tracking-tight text-amber-900">Look like items you already have ({similar.length})</h2>
                  <p className="text-[12px] text-amber-900/80">
                    A near-identical name — a spelling difference, or the same name under another SKU. These are left out unless you tick <b>Create anyway</b>.
                  </p>
                </div>
                <div className="flex gap-2 text-[12px]">
                  <button className="text-accent-700 hover:underline" onClick={() => setCreateAnyway(new Set(similar.map((i) => i.key)))}>
                    Tick all
                  </button>
                  <button className="text-accent-700 hover:underline" onClick={() => setCreateAnyway(new Set())}>
                    Untick all
                  </button>
                </div>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 font-medium">In your file</th>
                      <th className="px-2 py-2 font-medium">Looks like</th>
                      <th className="px-4 py-2 text-right font-medium">Create anyway?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {similar.map((it) => (
                      <tr key={it.key} className="align-top" data-testid="similar-row">
                        <td className="px-4 py-2">
                          <div className="font-medium">{it.name}</div>
                          <div className="text-ink-400 text-[11px]">
                            Row {it.rows[0]}
                            {it.sku !== null && <> · SKU {it.sku}</>}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          {it.similarTo.map((x, i) => (
                            <div key={i} className="text-[12px]">
                              <b>{x.name}</b>
                              <span className="text-ink-500">
                                {x.sku !== null && ` · SKU ${x.sku}`} · {x.row === null ? 'in the item master' : `row ${x.row} of this file`} · {Math.round(x.score * 100)}% alike
                              </span>
                            </div>
                          ))}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <label className="inline-flex items-center gap-1.5 text-[12.5px]">
                            <input type="checkbox" checked={createAnyway.has(it.key)} onChange={() => toggle(it.key)} aria-label={`Create ${it.name} anyway`} />
                            Create anyway
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {s.withStock > 0 && (
            <Card className="space-y-2 px-4 py-3" data-testid="import-stock">
              <h2 className="text-[13px] font-semibold tracking-tight">Stock on hand in the file ({s.withStock} items)</h2>
              {check.mayOpenStock ? (
                <>
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" checked={bringStock} onChange={(e) => setBringStock(e.target.checked)} />
                    Bring this stock onto the books as <b>opening stock</b> for the new items, at:
                  </label>
                  {bringStock && (
                    <select value={stockBranch} onChange={(e) => setStockBranch(e.target.value)} aria-label="Stock branch" className="border-ink-200 focus:border-accent-500 w-full max-w-xs rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none">
                      <option value="">Choose the branch the stock is at…</option>
                      {branches.list.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="text-ink-500 text-[12px]">
                    It becomes one numbered opening stock document, valued at the cost prices in the file. Items already in the item master are not touched — change
                    their stock with a stock take.
                  </p>
                </>
              ) : (
                <p className="text-[12.5px] text-amber-900">
                  Bringing in stock needs the opening stock permission, so the items will be created without their stock. Someone with that permission can bring it in
                  afterwards.
                </p>
              )}
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="border-ink-100 border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">Items to be created ({newItems.length.toLocaleString()})</h2>
            </div>
            {newItems.length === 0 ? (
              <p className="text-ink-400 px-4 py-4 text-[12.5px]">Nothing new to create.</p>
            ) : (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-[12.5px]" data-testid="import-items">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 font-medium">Item</th>
                      <th className="px-2 py-2 font-medium">SKU</th>
                      <th className="px-2 py-2 font-medium">Category</th>
                      <th className="px-4 py-2 font-medium">Packs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {newItems.slice(0, 200).map((it) => (
                      <tr key={it.key} className="align-top">
                        <td className="px-4 py-1.5 font-medium">
                          {it.name}
                          {it.isWeighed && <span className="text-ink-400 font-normal"> · weighed</span>}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[11.5px]">{it.sku ?? <span className="text-ink-400 font-sans">made up</span>}</td>
                        <td className="text-ink-600 px-2 py-1.5">{it.category ?? '—'}</td>
                        <td className="px-4 py-1.5">
                          {it.packs.map((p) => (
                            <div key={p.label} className="text-[12px]">
                              {p.label} ({p.qtyBase} {it.baseUom})
                              {p.barcode !== null && <span className="text-ink-400 font-mono"> · {p.barcode}</span>}
                              {p.sellPrice !== null && check.mayPrice && <span> · {money(p.sellPrice)}</span>}
                              {p.isDefaultSell && <Badge tone="good">sells</Badge>} {p.isDefaultBuy && <Badge tone="info">buys</Badge>}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {newItems.length > 200 && <p className="text-ink-400 px-4 py-2 text-[12px]">…and {newItems.length - 200} more.</p>}
              </div>
            )}
          </Card>

          {existing.length > 0 && (
            <details className="rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
              <summary className="cursor-pointer text-[13px] font-semibold tracking-tight">Already in the item master — skipped ({existing.length})</summary>
              <ul className="text-ink-600 mt-2 space-y-0.5 text-[12.5px]">
                {existing.slice(0, 200).map((it) => (
                  <li key={it.key}>
                    Row {it.rows[0]}: <b>{it.name}</b> — {it.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Card className="flex flex-wrap items-center gap-3 px-4 py-4">
            <Button variant="primary" onClick={() => void doImport()} disabled={busy || toCreate === 0 || needsBranch || !can('product.write')}>
              {busy ? <Spinner /> : null}
              Import {toCreate.toLocaleString()} item{toCreate === 1 ? '' : 's'}
            </Button>
            <span className="text-ink-500 text-[12.5px]">
              {needsBranch
                ? 'Choose the branch the stock is at, or untick bringing in the stock.'
                : `${s.problemRows + s.existing + similar.length - (toCreate - newItems.length) > 0 ? 'Problem rows, items already in the master and look-alikes not ticked are left out. ' : ''}All the new items are created together, or none are.`}
            </span>
          </Card>
        </>
      )}

      {done?.report != null && (
        <Card className="overflow-hidden" data-testid="import-report">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">What happened, item by item</h2>
          </div>
          <div className="grid gap-4 px-4 py-3 lg:grid-cols-3">
            <div>
              <div className="text-accent-700 mb-1 text-[12px] font-semibold">Created ({done.report.created.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.created.map((c) => (
                  <li key={c.sku}>
                    {c.name} <span className="text-ink-400 font-mono text-[11px]">{c.sku}</span>
                    {c.stock !== null && <span className="text-ink-500"> · {c.stock} in stock</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-ink-600 mb-1 text-[12px] font-semibold">Already in the item master — not created ({done.report.existing.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.existing.map((c) => (
                  <li key={`${c.row}`}>
                    Row {c.row}: {c.name} <span className="text-ink-500">— {c.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[12px] font-semibold text-amber-800">Look-alikes left out ({done.report.similarSkipped.length})</div>
              <ul className="max-h-64 space-y-0.5 overflow-auto text-[12.5px]">
                {done.report.similarSkipped.map((c) => (
                  <li key={`${c.row}`}>
                    Row {c.row}: {c.name} <span className="text-ink-500">— {c.reason}</span>
                  </li>
                ))}
              </ul>
              {done.report.problemRows > 0 && (
                <p className="mt-2 text-[12px] text-red-700">
                  {plural(done.report.problemRows, 'row')} had problems and {done.report.problemRows === 1 ? 'was' : 'were'} left out.
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {done !== null && (
        <div className="border-accent-300/60 bg-accent-50 rounded-xl border px-4 py-3 text-[13px]" data-testid="import-done">
          <div className="font-semibold">
            Imported as <span className="font-mono">{done.importNo}</span>
          </div>
          <div className="text-ink-700 mt-0.5">
            {plural(done.itemsCreated, 'item')} and {plural(done.packsCreated, 'pack')} created
            {done.categoriesCreated > 0 && `, ${plural(done.categoriesCreated, 'new category', 'new categories')}`}
            {done.rowsSkipped > 0 && `; ${plural(done.rowsSkipped, 'row')} left out`}
            {!done.pricesSet && ' · no prices set'}
            {done.openingDocNo !== null && (
              <>
                {' · stock brought in as '}
                <span className="font-mono">{done.openingDocNo}</span>
              </>
            )}
            .{' '}
            <Link to="/products" className="text-accent-700 font-medium hover:underline">
              Open the item master
            </Link>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-ink-100 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Recent imports</h2>
        </div>
        {history.error !== undefined ? (
          <ErrorNote error={history.error} />
        ) : (history.data?.items ?? []).length === 0 ? (
          <p className="text-ink-400 px-4 py-4 text-[12.5px]">No imports yet.</p>
        ) : (
          <table className="w-full text-[12.5px]" data-testid="import-history">
            <tbody className="divide-ink-100 divide-y">
              {(history.data?.items ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-2 font-mono">{h.importNo}</td>
                  <td className="text-ink-600 px-2 py-2">{h.fileName ?? 'pasted rows'}</td>
                  <td className="px-2 py-2">
                    {plural(h.itemsCreated, 'item')}
                    {h.rowsSkipped > 0 && `, ${plural(h.rowsSkipped, 'row')} left out`}
                  </td>
                  <td className="text-ink-500 px-4 py-2 text-right whitespace-nowrap">
                    {shortDateTime(h.createdAt)} · {h.byName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
