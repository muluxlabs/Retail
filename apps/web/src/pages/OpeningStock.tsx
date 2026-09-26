/**
 * Opening stock: bring the stock on a branch's shelves onto the books.
 *
 * For a new branch, or one started fresh: list each item, how many, and what
 * one pack cost - by searching, or by pasting a list from a spreadsheet or the
 * old system. Posting makes one numbered document, puts the stock on the ledger
 * as "opening stock introduced", and gives an auditor a work item to check it.
 *
 * Only items with nothing on hand at the branch can be opened; an item already
 * on the books with a different count on the shelf is a stock take. Items that
 * already have stock are flagged here before anything is sent.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { newKey, parseLines, PurchaseLines, type PurchaseLine } from '../components/PurchaseLines.js';
import { StockEntryTabs } from '../components/StockEntryTabs.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { fromCents, parseCost, parseQty } from '../lib/basketMath.js';
import { packCost, shortDate, shortDateTime } from '../lib/buying.js';
import { parsePasted } from '../lib/openingPaste.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function OpeningStock() {
  const { user } = useAuth();
  const allBranches = useAsync(() => api.branches(), []);
  // Someone tied to branches opens stock at those only (the API refuses the rest anyway).
  const scoped = user?.branchIds ?? [];
  const branchList = (allBranches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));
  const [branchId, setBranchId] = useState('');
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [note, setNote] = useState('');
  const [docId, setDocId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; docNo: string; totalCost: number; lines: number; linesWithoutCost: number } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteReport, setPasteReport] = useState<{ added: number; problems: string[] } | null>(null);

  useEffect(() => {
    if (branchId === '' && branchList.length === 1 && branchList[0] !== undefined) setBranchId(branchList[0].id);
  }, [branchList, branchId]);

  const positions = useAsync(() => (branchId === '' ? Promise.resolve(undefined) : api.openingPositions(branchId)), [branchId, done]);
  const onHand = useMemo(() => new Map((positions.data?.items ?? []).map((p) => [p.productId, p.qtyBase])), [positions.data]);
  const history = useAsync(() => (branchId === '' ? Promise.resolve(undefined) : api.openingDocs({ branchId, limit: 20 })), [branchId, done]);

  const parsed = parseLines(lines, true);
  const blocked = lines.filter((l) => (onHand.get(l.productId) ?? 0) !== 0);
  const uncosted = lines.filter((l) => l.cost.trim() === '').length;
  const canPost = branchId !== '' && parsed.ok && blocked.length === 0 && !busy;

  async function importPaste() {
    setError(null);
    const rows = parsePasted(pasteText);
    const problems = rows.filter((r) => r.problem !== null).map((r) => `Line ${r.line} (${r.code || 'blank'}): ${r.problem}`);
    const good = rows.filter((r) => r.problem === null);
    if (good.length === 0) {
      setPasteReport({ added: 0, problems: problems.length > 0 ? problems : ['Nothing to add: paste lines like  SKU-OR-BARCODE <tab> quantity <tab> cost'] });
      return;
    }
    setBusy(true);
    try {
      const { items } = await api.resolveOpeningCodes(branchId, good.map((r) => r.code));
      const byCode = new Map(items.map((i) => [i.code, i.match]));
      const next = [...lines];
      let added = 0;
      for (const r of good) {
        const m = byCode.get(r.code) ?? null;
        if (m === null) {
          problems.push(`Line ${r.line} (${r.code}): no item with that SKU or barcode`);
          continue;
        }
        if (next.some((l) => l.productId === m.productId)) {
          problems.push(`Line ${r.line} (${r.code}): ${m.name} is already in the list`);
          continue;
        }
        next.push({
          key: newKey(),
          productId: m.productId,
          packId: m.packId,
          name: m.name,
          sku: m.sku,
          packs: m.packs,
          qty: String(r.qty),
          cost: r.cost === null ? '' : String(r.cost),
        });
        added += 1;
      }
      setLines(next);
      // In the order they were pasted, whichever check caught them.
      problems.sort((x, y) => Number(x.match(/^Line (\d+)/)?.[1] ?? 0) - Number(y.match(/^Line (\d+)/)?.[1] ?? 0));
      setPasteReport({ added, problems });
      if (problems.length === 0) {
        setPasteText('');
        setPasting(false);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.postOpeningStock({
        id: docId,
        branchId,
        note: note.trim() === '' ? null : note.trim(),
        lines: lines.map((l) => ({
          productId: l.productId,
          packId: l.packId,
          qtyPacks: parseQty(l.qty)!,
          unitCost: l.cost.trim() === '' ? null : parseCost(l.cost),
        })),
      });
      setDone(r);
      setDocId(crypto.randomUUID());
      setLines([]);
      setNote('');
      setPasteReport(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <StockEntryTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Opening stock</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Bring the stock already on a branch's shelves onto the books - for a new branch, or one started fresh. List each item, how many,
          and what one pack cost; paste a list from a spreadsheet if you have one. Only items with nothing on hand can be opened: for an
          item already on the books, use a stock take.
        </p>
      </div>

      {done !== null && (
        <div className="bg-accent-50 border-accent-300/60 text-accent-700 rounded-lg border px-4 py-3 text-[13px]" role="status" data-testid="opening-done">
          Opening stock <span className="font-mono font-semibold">{done.docNo}</span> posted: {done.lines} {done.lines === 1 ? 'item' : 'items'},{' '}
          {money(done.totalCost)} at cost
          {done.linesWithoutCost > 0 && `, ${done.linesWithoutCost} without a cost`}. It is on the books, and an auditor has it to review.{' '}
          <Link to={`/opening-stock/${done.id}`} className="font-medium underline">
            View or print it
          </Link>
        </div>
      )}

      <Card className="px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Branch</span>
            <select
              value={branchId}
              disabled={lines.length > 0}
              onChange={(e) => setBranchId(e.target.value)}
              className={`${field} disabled:opacity-60`}
              aria-label="Branch"
            >
              <option value="">Choose a branch…</option>
              {branchList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Opening count, 1 October" aria-label="Note" className={field} />
          </label>
        </div>
      </Card>

      {branchId !== '' && (
        <Card className="px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">Items</h2>
            <Button onClick={() => setPasting((v) => !v)}>{pasting ? 'Close paste' : 'Paste a list'}</Button>
          </div>
          {pasting && (
            <div className="mb-4 space-y-2" data-testid="paste-panel">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={6}
                placeholder={'SKU or barcode, quantity, cost per pack - one item per line. Copy three columns straight from a spreadsheet.\nSUGAR-2KG\t120\t1.85\n6001234567890\t48'}
                aria-label="Paste a list"
                className={`${field} font-mono text-[12px]`}
              />
              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={() => void importPaste()} disabled={busy || pasteText.trim() === ''}>
                  {busy ? <Spinner /> : null}
                  Add to the list
                </Button>
                <span className="text-ink-400 text-[11.5px]">
                  The quantity is in the item's buying pack (a SKU) or the pack the barcode is printed on. Leave the cost out if it is not known.
                </span>
              </div>
              {pasteReport !== null && (
                <div className="text-[12.5px]" data-testid="paste-report">
                  <div className="text-accent-700 font-medium">
                    {pasteReport.added} {pasteReport.added === 1 ? 'item' : 'items'} added.
                  </div>
                  {pasteReport.problems.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-800">
                      {pasteReport.problems.slice(0, 30).map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                      {pasteReport.problems.length > 30 && <li>… and {pasteReport.problems.length - 30} more</li>}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
          <PurchaseLines
            lines={lines}
            onChange={setLines}
            costOptional
            costLabel="Cost per pack"
            note={(productId) => {
              const h = onHand.get(productId);
              return h === undefined || h === 0 ? null : `Already ${qty(h)} on hand here - use a stock take for this item, or remove it.`;
            }}
          />
          {uncosted > 0 && parsed.ok && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
              {uncosted} {uncosted === 1 ? 'item has' : 'items have'} no cost. {uncosted === 1 ? 'It goes' : 'They go'} on the books but cannot be valued, and{' '}
              {uncosted === 1 ? 'its' : 'their'} sales will show no cost of sales until a costed delivery arrives. Enter the cost if you know it.
            </p>
          )}
          {blocked.length > 0 && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800" data-testid="opening-blocked">
              {blocked.length} {blocked.length === 1 ? 'item already has' : 'items already have'} stock at this branch. Remove{' '}
              {blocked.length === 1 ? 'it' : 'them'} to post.
            </p>
          )}
        </Card>
      )}

      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      {branchId !== '' && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void post()} disabled={!canPost}>
            {busy ? <Spinner /> : null}
            Post opening stock
            {lines.length > 0 && ` · ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`}
            {parsed.totalCents > 0 && ` · ${money(fromCents(parsed.totalCents))}`}
          </Button>
          {lines.length > 1000 && <Badge tone="bad">At most 1,000 items in one document</Badge>}
        </div>
      )}

      {branchId !== '' && (
        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Opening stock posted at this branch</h2>
          </div>
          {(history.data?.items ?? []).length === 0 ? (
            <Empty title="None yet" />
          ) : (
            <ul className="divide-ink-100 divide-y" data-testid="opening-history">
              {(history.data?.items ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px]">
                  <Link to={`/opening-stock/${d.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                    {d.docNo}
                  </Link>
                  <span className="text-ink-500">{shortDate(d.enteredAt)}</span>
                  <span className="text-ink-500">{d.enteredByName}</span>
                  <span className="text-ink-500">
                    {d.lines} {d.lines === 1 ? 'item' : 'items'}
                    {d.linesWithoutCost > 0 && `, ${d.linesWithoutCost} without cost`}
                  </span>
                  <span className="tnum ml-auto font-medium">{money(d.totalCost)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

export function OpeningStockDetail() {
  const { id = '' } = useParams();
  const doc = useAsync(() => api.openingDoc(id), [id]);
  if (doc.error !== undefined) return <ErrorNote error={doc.error} />;
  const d = doc.data;
  if (d === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const noCost = d.lines.filter((l) => l.unitCost === null).length;
  return (
    <div className="space-y-4">
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/opening-stock" className="hover:text-ink-700 hover:underline">
          Opening stock
        </Link>{' '}
        / {d.docNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Opening stock <span className="font-mono" data-testid="opening-no">{d.docNo}</span>
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            {d.branchName} · posted {shortDateTime(d.enteredAt)} by {d.enteredByName}
          </p>
          {d.note !== null && <p className="text-ink-500 text-[12.5px]">{d.note}</p>}
        </div>
        <Button onClick={() => window.print()} className="no-print">
          Print
        </Button>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="opening-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Pack</th>
                <th className="px-2 py-2 text-right font-medium">Quantity</th>
                <th className="px-2 py-2 text-right font-medium">Units onto the books</th>
                <th className="px-2 py-2 text-right font-medium">Cost per pack</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {d.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="px-4 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                  </td>
                  <td className="px-2 py-1.5">{l.packLabel}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyPacks)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyBase)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{l.unitCost === null ? <span className="text-amber-700">not known</span> : packCost(l.unitCost)}</td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">{l.lineTotal === null ? '—' : money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t font-semibold">
                <td colSpan={5} className="px-4 py-2 text-right">
                  Value introduced at cost{noCost > 0 && ` (${noCost} ${noCost === 1 ? 'item' : 'items'} without a cost not included)`}
                </td>
                <td className="tnum px-4 py-2 text-right" data-testid="opening-total">{money(d.totalCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
