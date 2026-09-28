/**
 * Prices: what every item sells for, against what it cost.
 *
 * Set one price by typing in its row; set many at once by ticking the items
 * (a whole category, a search result, every unpriced item) and applying a rule
 * - an exact price, a percentage up or down, or cost plus a markup. A rule only
 * fills in the new prices for review: nothing is saved until "Save", so a wrong
 * percentage is a mistake you can see, not one that is already live. Every
 * saved change is written to the audit log with the old and new price.
 */

import { useMemo, useState } from 'react';

import { api, ApiError, type PriceRow } from '../lib/api.js';
import { parseMoney } from '../lib/basketMath.js';
import { bulkPrice, marginPercent, ROUND_STEPS, type BulkMode, type RoundStep } from '../lib/pricing.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const PAGE = 100;
/** The API takes at most this many changes in one save. */
const MAX_SAVE = 500;

export function Prices() {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [page, setPage] = useState(0);

  // What has been typed, by pack. A pack absent from the map is untouched.
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Rows seen so far, so a selection that spans pages can still be worked out.
  const [known, setKnown] = useState<Map<string, PriceRow>>(new Map());

  const [mode, setMode] = useState<BulkMode>('markup');
  const [amount, setAmount] = useState('30');
  const [step, setStep] = useState<RoundStep>(0.05);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = useAsync(() => api.categories(), []);
  const list = useAsync(async () => {
    const r = await api.priceList({
      ...(search.trim() === '' ? {} : { search: search.trim() }),
      ...(categoryId === '' ? {} : { categoryId }),
      missingOnly,
      limit: PAGE,
      offset: page * PAGE,
    });
    setKnown((m) => {
      const next = new Map(m);
      for (const row of r.items) next.set(row.packId, row);
      return next;
    });
    return r;
  }, [search, categoryId, missingOnly, page]);

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const unpriced = list.data?.unpriced ?? 0;
  const catalogue = list.data?.catalogue ?? 0;

  /** The price a row would have if the draft were saved. */
  const effective = (r: PriceRow): number | null => {
    const d = draft.get(r.packId);
    if (d === undefined) return r.sellPrice;
    return d.trim() === '' ? null : parseMoney(d);
  };
  const invalid = (r: PriceRow): boolean => {
    const d = draft.get(r.packId);
    return d !== undefined && d.trim() !== '' && parseMoney(d) === null;
  };

  const pending = useMemo(() => {
    const out: { packId: string; sellPrice: number | null }[] = [];
    let bad = 0;
    for (const [packId, text] of draft) {
      const row = known.get(packId);
      if (row === undefined) continue;
      const v = text.trim() === '' ? null : parseMoney(text);
      if (text.trim() !== '' && v === null) {
        bad += 1;
        continue;
      }
      if (v !== row.sellPrice) out.push({ packId, sellPrice: v });
    }
    return { changes: out, bad };
  }, [draft, known]);

  function setOne(packId: string, text: string) {
    setMessage(null);
    setDraft((m) => new Map(m).set(packId, text));
  }

  function toggle(packId: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(packId)) n.delete(packId);
      else n.add(packId);
      return n;
    });
  }

  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.packId));
  function togglePage() {
    setSelected((s) => {
      const n = new Set(s);
      if (pageAllSelected) rows.forEach((r) => n.delete(r.packId));
      else rows.forEach((r) => n.add(r.packId));
      return n;
    });
  }

  /** Everything matching the current filter, not just this page (up to what one save can hold). */
  async function selectAllMatching() {
    setBusy(true);
    setMessage(null);
    try {
      const ids: string[] = [];
      const seen = new Map(known);
      for (let offset = 0; offset < Math.min(total, MAX_SAVE); offset += 200) {
        const r = await api.priceList({
          ...(search.trim() === '' ? {} : { search: search.trim() }),
          ...(categoryId === '' ? {} : { categoryId }),
          missingOnly,
          limit: 200,
          offset,
        });
        for (const row of r.items) {
          ids.push(row.packId);
          seen.set(row.packId, row);
        }
      }
      setKnown(seen);
      setSelected(new Set(ids.slice(0, MAX_SAVE)));
      if (total > MAX_SAVE) {
        setMessage({ tone: 'bad', text: `Selected the first ${MAX_SAVE} of ${total}. Narrow the filter to reach the rest.` });
      }
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const amountNum = Number(amount);
  const amountOk = amount.trim() !== '' && Number.isFinite(amountNum) && (mode !== 'set' || parseMoney(amount) !== null);

  /** Fill the draft for every selected item by the chosen rule. Nothing is saved. */
  function applyRule() {
    if (!amountOk) return;
    let filled = 0;
    let skipped = 0;
    const next = new Map(draft);
    for (const packId of selected) {
      const row = known.get(packId);
      if (row === undefined) continue;
      const current = effective(row);
      const price = bulkPrice(mode, amountNum, step, { current, cost: row.costPerPack });
      if (price === null) {
        skipped += 1;
        continue;
      }
      next.set(packId, price.toFixed(2));
      filled += 1;
    }
    setDraft(next);
    setMessage({
      tone: filled > 0 ? 'good' : 'bad',
      text:
        `${filled} price${filled === 1 ? '' : 's'} filled in for review.` +
        (skipped > 0
          ? ` ${skipped} skipped: ${mode === 'markup' ? 'no cost on record' : mode === 'percent' ? 'no price to adjust' : 'not a valid price'}.`
          : '') +
        ' Nothing is saved until you press Save.',
    });
  }

  async function save() {
    if (pending.changes.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      let updated = 0;
      for (let i = 0; i < pending.changes.length; i += MAX_SAVE) {
        updated += (await api.savePrices(pending.changes.slice(i, i + MAX_SAVE))).updated;
      }
      setDraft(new Map());
      setSelected(new Set());
      setMessage({ tone: 'good', text: `Saved ${updated} price${updated === 1 ? '' : 's'}.` });
      list.reload();
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function fillAllUnpriced() {
    if (!amountOk || mode !== 'markup') return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.fillMissingPrices({ markupPercent: amountNum, roundTo: step });
      setMessage({
        tone: 'good',
        text: `Priced ${r.updated} item${r.updated === 1 ? '' : 's'} at cost + ${amountNum}%.` +
          (r.skippedNoCost > 0 ? ` ${r.skippedNoCost} left unpriced: no cost on record yet.` : ''),
      });
      list.reload();
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Prices</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Set what each item sells for. Type in a row for one item, or tick several - a category, a search, every
          unpriced item - and apply one rule to all of them. Items with no price cannot be sold.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Items priced</div>
          <div className="tnum mt-1 text-xl font-semibold">
            {list.data === undefined ? '…' : `${(catalogue - unpriced).toLocaleString()} of ${catalogue.toLocaleString()}`}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">No price yet</div>
          <div className={`tnum mt-1 text-xl font-semibold ${unpriced > 0 ? 'text-amber-700' : ''}`}>{list.data === undefined ? '…' : unpriced}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Ticked</div>
          <div className="tnum mt-1 text-xl font-semibold">{selected.size}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Unsaved changes</div>
          <div className={`tnum mt-1 text-xl font-semibold ${pending.changes.length > 0 ? 'text-accent-700' : ''}`}>
            {pending.changes.length}
          </div>
        </Card>
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-48 flex-1">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Search</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Product name or SKU…"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
            />
          </label>
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Category</span>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setPage(0);
              }}
              className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-[12.5px]">
            <input
              type="checkbox"
              checked={missingOnly}
              onChange={(e) => {
                setMissingOnly(e.target.checked);
                setPage(0);
              }}
              className="accent-accent-600 size-3.5"
            />
            No price yet
          </label>
        </div>
      </Card>

      <Card className="px-4 py-3">
        <div className="text-ink-600 mb-2 text-[11px] font-medium uppercase tracking-wider">
          Apply one rule to the ticked items{selected.size > 0 ? ` (${selected.size})` : ''}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">Rule</span>
            <select
              value={mode}
              onChange={(e) => {
                const m = e.target.value as BulkMode;
                setMode(m);
                setAmount(m === 'set' ? '' : m === 'markup' ? '30' : '5');
              }}
              aria-label="Bulk rule"
              className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="markup">Cost + markup %</option>
              <option value="percent">Raise / lower by %</option>
              <option value="set">Set an exact price</option>
            </select>
          </label>
          <label className="block">
            <span className="text-ink-500 mb-1 block text-[11px]">
              {mode === 'set' ? 'Price' : mode === 'markup' ? 'Markup %' : '% (minus to lower)'}
            </span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Bulk amount"
              className="tnum border-ink-200 focus:border-accent-500 w-24 rounded-lg border bg-white px-2.5 py-1.5 text-right text-[12.5px] outline-none"
            />
          </label>
          {mode !== 'set' && (
            <label className="block">
              <span className="text-ink-500 mb-1 block text-[11px]">Round to</span>
              <select
                value={step}
                onChange={(e) => setStep(Number(e.target.value) as RoundStep)}
                className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
              >
                {ROUND_STEPS.map((s) => (
                  <option key={s} value={s}>
                    {s === 1 ? '$1.00' : `${Math.round(s * 100)}¢`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button onClick={applyRule} disabled={selected.size === 0 || !amountOk || busy}>
            Fill in prices for review
          </Button>
          {mode === 'markup' && unpriced > 0 && (
            <Button variant="secondary" onClick={() => void fillAllUnpriced()} disabled={!amountOk || busy}>
              Price all {unpriced} unpriced at once
            </Button>
          )}
        </div>
        <p className="text-ink-400 mt-2 text-[11.5px]">
          {mode === 'markup'
            ? 'Cost + markup rounds UP to the step, so a price is never below the markup asked for. Items with no cost on record are skipped.'
            : mode === 'percent'
              ? 'A percentage change rounds to the nearest step. Unpriced items are skipped.'
              : 'Every ticked item gets exactly this price.'}
        </p>
      </Card>

      {message !== null && (
        <div
          role="status"
          className={`rounded-lg border px-3.5 py-2 text-[12.5px] ${
            message.tone === 'good' ? 'border-accent-300/60 bg-accent-50 text-accent-700' : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}
      {list.error !== undefined && <ErrorNote error={list.error} />}

      <Card className="overflow-hidden">
        <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="text-[12.5px]">
            <span className="font-medium">{total.toLocaleString()}</span> <span className="text-ink-500">items</span>
            {total > rows.length && selected.size < Math.min(total, MAX_SAVE) && (
              <button
                onClick={() => void selectAllMatching()}
                disabled={busy}
                className="text-accent-700 ml-3 text-[12px] hover:underline"
              >
                Tick all {Math.min(total, MAX_SAVE)} matching
              </button>
            )}
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="text-ink-400 ml-3 text-[12px] hover:text-ink-700">
                Clear ticks
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pending.bad > 0 && <Badge tone="bad">{pending.bad} invalid</Badge>}
            {draft.size > 0 && (
              <Button variant="ghost" onClick={() => setDraft(new Map())} disabled={busy}>
                Discard changes
              </Button>
            )}
            <Button variant="primary" onClick={() => void save()} disabled={busy || pending.changes.length === 0 || pending.bad > 0}>
              {busy ? <Spinner /> : null}
              Save {pending.changes.length > 0 ? `${pending.changes.length} change${pending.changes.length === 1 ? '' : 's'}` : 'changes'}
            </Button>
          </div>
        </div>

        {list.loading && rows.length === 0 ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No items match" hint="Clear the search or category, or untick “No price yet”." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      checked={pageAllSelected}
                      onChange={togglePage}
                      aria-label="Tick every item on this page"
                      className="accent-accent-600 size-3.5"
                    />
                  </th>
                  <th className="px-2 py-2 font-medium">Item</th>
                  <th className="px-2 py-2 font-medium">Category</th>
                  <th className="px-2 py-2 text-right font-medium">Cost</th>
                  <th className="px-2 py-2 text-right font-medium">Selling price</th>
                  <th className="px-4 py-2 text-right font-medium">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {rows.map((r) => {
                  const eff = effective(r);
                  const dirty = draft.has(r.packId) && eff !== r.sellPrice;
                  const m = marginPercent(eff, r.costPerPack);
                  return (
                    <tr key={r.packId} className={dirty ? 'bg-accent-50/50' : ''} data-testid="price-row">
                      <td className="px-4 py-1.5">
                        <input
                          type="checkbox"
                          checked={selected.has(r.packId)}
                          onChange={() => toggle(r.packId)}
                          aria-label={`Tick ${r.name} ${r.packLabel}`}
                          className="accent-accent-600 size-3.5"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium">
                          {r.name} <span className="text-ink-400 font-normal">· {r.packLabel}</span>
                        </div>
                        <div className="text-ink-400 font-mono text-[11px]">{r.sku}</div>
                      </td>
                      <td className="text-ink-500 px-2 py-1.5">{r.categoryName ?? '—'}</td>
                      <td className="tnum text-ink-600 px-2 py-1.5 text-right">{money(r.costPerPack)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          inputMode="decimal"
                          value={draft.get(r.packId) ?? (r.sellPrice === null ? '' : r.sellPrice.toFixed(2))}
                          placeholder="not set"
                          aria-label={`Selling price of ${r.name} ${r.packLabel}`}
                          onChange={(e) => setOne(r.packId, e.target.value)}
                          className={`tnum w-24 rounded-lg border bg-white px-2 py-1 text-right outline-none ${
                            invalid(r) ? 'border-red-400' : 'border-ink-200 focus:border-accent-500'
                          }`}
                        />
                      </td>
                      <td
                        className={`tnum px-4 py-1.5 text-right ${
                          m === null ? 'text-ink-300' : m < 0 ? 'font-medium text-red-700' : 'text-ink-700'
                        }`}
                      >
                        {m === null ? '—' : `${m.toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="border-ink-100 flex items-center justify-between border-t px-4 py-2 text-[12px]">
            <span className="text-ink-500">
              Page {page + 1} of {pages}
            </span>
            <span className="flex gap-2">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
