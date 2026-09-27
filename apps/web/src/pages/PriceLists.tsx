/**
 * Supplier price lists.
 *
 * Paste (or open) the list a supplier sent, choose how selling prices should
 * follow the new costs, and preview every line: old and new cost, current and
 * new price, the margin before and after. Tick what to apply; unmatched lines
 * are listed with the reason. Applying records the supplier's costs (which
 * then fill in new orders) and changes the ticked prices, as one numbered,
 * unchangeable price list.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { api, ApiError, type PriceListPreview, type PriceRuleInput } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { parseMoney } from '../lib/basketMath.js';
import { packCost, shortDateTime } from '../lib/buying.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`);

export function ruleText(rule: { mode: string; markupPercent?: number; roundToCents?: number }): string {
  const step = rule.roundToCents === undefined ? '' : `, rounded up to ${money(rule.roundToCents / 100)}`;
  if (rule.mode === 'keep_margin') return `Prices keep their margin${step}`;
  if (rule.mode === 'markup') return `Prices set at cost + ${rule.markupPercent}%${step}`;
  return 'Costs only: prices left alone';
}

export function PriceLists() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const suppliers = useAsync(() => api.suppliers(), []);
  const lists = useAsync(() => api.supplierPriceLists({ ...(supplierId === '' ? {} : { supplierId }) }), [supplierId]);
  const rows = lists.data?.items ?? [];
  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Supplier price lists</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            When a supplier sends new prices, import them here: their costs are recorded, and your selling prices can follow.
          </p>
        </div>
        {can('price.write') && (
          <Link to={`/price-lists/new${supplierId === '' ? '' : `?supplierId=${supplierId}`}`}>
            <Button variant="primary">Import a price list</Button>
          </Link>
        )}
      </div>
      <Card className="px-4 py-3">
        <label className="block max-w-xs">
          <span className={label}>Supplier</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={field} aria-label="Supplier">
            <option value="">All suppliers</option>
            {(suppliers.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </Card>
      {lists.error !== undefined && <ErrorNote error={lists.error} />}
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <Empty title={lists.loading ? 'Loading…' : 'No price lists imported yet'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="price-lists">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Price list</th>
                  <th className="px-2 py-2 font-medium">Supplier</th>
                  <th className="px-2 py-2 font-medium">Imported</th>
                  <th className="px-2 py-2 font-medium">How prices were set</th>
                  <th className="px-2 py-2 text-right font-medium">Items</th>
                  <th className="px-4 py-2 text-right font-medium">Prices changed</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {rows.map((l) => (
                  <tr key={l.id} className="hover:bg-ink-50/60" data-testid="price-list-row">
                    <td className="px-4 py-2">
                      <Link to={`/price-lists/${l.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                        {l.listNo}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{l.supplierName}</td>
                    <td className="text-ink-600 px-2 py-2 whitespace-nowrap">
                      {shortDateTime(l.createdAt)} · {l.byName}
                    </td>
                    <td className="text-ink-600 px-2 py-2">{ruleText(l.rule)}</td>
                    <td className="tnum px-2 py-2 text-right">{l.lines}</td>
                    <td className="tnum px-4 py-2 text-right font-medium">{l.pricesChanged}</td>
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

// -- importing ------------------------------------------------------------------------------------------------------

interface Choice {
  tick: boolean;
  /** The new selling price as typed; '' leaves the price alone. */
  sell: string;
}

export function NewPriceList() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const suppliers = useAsync(() => api.suppliers(), []);
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'keep_margin' | 'markup' | 'costs_only'>('keep_margin');
  const [markup, setMarkup] = useState('25');
  const [roundTo, setRoundTo] = useState<0.01 | 0.05 | 0.1 | 0.5 | 1>(0.05);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<PriceListPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  /** Lines linked to an item by hand ("did you mean…?"): code (lower case) -> pack. */
  const [links, setLinks] = useState<Record<string, string>>({});
  const [id] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const markupN = Number(markup);
  const rule: PriceRuleInput | null =
    mode === 'costs_only'
      ? { mode }
      : mode === 'markup'
        ? markup.trim() !== '' && Number.isFinite(markupN) && markupN >= 0
          ? { mode, markupPercent: markupN, roundTo }
          : null
        : { mode, roundTo };

  async function readFile(f: File | undefined) {
    if (f === undefined) return;
    setText(await f.text());
    setPreview(null);
  }

  async function doPreview(withLinks: Record<string, string> = links) {
    if (rule === null) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewPriceList({ supplierId, text, rule, links: withLinks });
      const kept = preview === null ? {} : choices;
      setPreview(p);
      const c: Record<number, Choice> = {};
      for (const l of p.lines) {
        if (l.match === null || l.cost === null) continue;
        const priceMoves = l.match.suggestedSell !== null && l.match.suggestedSell !== l.match.currentSell;
        const costMoves = l.match.oldCost === null || Math.abs(l.match.oldCost - l.cost) > 0.00005;
        // A line already decided on keeps its choice when the list is checked again after linking.
        c[l.row] = kept[l.row] ?? { tick: priceMoves || costMoves, sell: l.match.suggestedSell === null ? '' : l.match.suggestedSell.toFixed(2) };
      }
      setChoices(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const matched = (preview?.lines ?? []).filter((l) => l.match !== null);
  const unmatched = (preview?.lines ?? []).filter((l) => l.match === null);
  const picked = matched.filter((l) => choices[l.row]?.tick === true);
  const sellOf = (row: number): number | null | 'bad' => {
    const s = choices[row]?.sell.trim() ?? '';
    if (s === '') return null;
    const v = parseMoney(s);
    return v === null || v <= 0 ? 'bad' : v;
  };
  const problems = useMemo(
    () =>
      picked.flatMap((l) => {
        const v = sellOf(l.row);
        if (v === 'bad') return [`Line ${l.row}: the new price is not a valid amount.`];
        if (v !== null && l.cost !== null && v < l.cost) return [`Line ${l.row}: ${l.match!.name} would sell below its new cost.`];
        return [];
      }),
    [picked, choices], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const priceChanges = picked.filter((l) => {
    const v = sellOf(l.row);
    return v !== null && v !== 'bad' && v !== l.match!.currentSell;
  }).length;

  async function apply() {
    if (rule === null || preview === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.applyPriceList({
        id,
        supplierId,
        rule,
        note: note.trim() === '' ? null : note.trim(),
        lines: picked.map((l) => {
          const v = sellOf(l.row);
          return { packId: l.match!.packId, supplierCode: l.match!.by === 'barcode' ? null : l.code, cost: l.cost!, newSell: v === 'bad' ? null : v };
        }),
      });
      nav(`/price-lists/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  const tickAll = (on: boolean) => setChoices((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, tick: on }])));

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 text-[12px]">
        <Link to="/price-lists" className="hover:text-ink-700 hover:underline">
          Price lists
        </Link>{' '}
        / Import
      </div>
      <h1 className="text-lg font-semibold tracking-tight">Import a supplier’s price list</h1>

      <Card className="space-y-3 px-4 py-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <label className="block">
            <span className={label}>Supplier</span>
            <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPreview(null); }} className={field} aria-label="Supplier">
              <option value="">Choose the supplier…</option>
              {(suppliers.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Or open a file (CSV or text)</span>
            <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} aria-label="Price list file" className="text-[12.5px]" />
          </label>
        </div>
        <label className="block">
          <span className={label}>The list</span>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            rows={8}
            placeholder={'One item a line: the code (theirs, a barcode or our SKU) first, the price per pack last.\nAB-100\tCooking oil 2L x 12\t54.60\n6001234567890, Sugar 2kg, 2.3750'}
            aria-label="Price list"
            className={`${field} font-mono text-[12px]`}
          />
        </label>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
          <fieldset>
            <span className={label}>Selling prices</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
              {(
                [
                  ['keep_margin', 'Keep each item’s margin'],
                  ['markup', 'Cost plus a markup'],
                  ['costs_only', 'Record costs only'],
                ] as const
              ).map(([m, t]) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setPreview(null); }} />
                  {t}
                </label>
              ))}
            </div>
          </fieldset>
          {mode === 'markup' && (
            <label className="block w-28">
              <span className={label}>Markup %</span>
              <input inputMode="decimal" value={markup} onChange={(e) => { setMarkup(e.target.value); setPreview(null); }} aria-label="Markup percent" className={`${field} tnum text-right`} />
            </label>
          )}
          {mode !== 'costs_only' && (
            <label className="block w-32">
              <span className={label}>Round up to</span>
              <select value={roundTo} onChange={(e) => { setRoundTo(Number(e.target.value) as typeof roundTo); setPreview(null); }} className={field} aria-label="Round up to">
                {[0.01, 0.05, 0.1, 0.5, 1].map((s) => (
                  <option key={s} value={s}>
                    {money(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => {
              setLinks({});
              void doPreview({});
            }}
            disabled={supplierId === '' || text.trim() === '' || rule === null || busy}
          >
            {busy && preview === null ? <Spinner /> : null}
            Preview
          </Button>
          <span className="text-ink-400 text-[12px]">Nothing changes until you apply.</span>
        </div>
        {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      </Card>

      {preview !== null && (
        <>
          <Card className="overflow-hidden">
            <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">
                  {preview.matched} matched{preview.unmatched > 0 && <span className="text-amber-700"> · {preview.unmatched} not matched</span>}
                </h2>
                <p className="text-ink-400 text-[11.5px]">Old cost is what {preview.supplier.name} last charged; failing that, your average cost (marked avg).</p>
              </div>
              <div className="flex gap-2 text-[12px]">
                <button className="text-accent-700 hover:underline" onClick={() => tickAll(true)}>
                  Tick all
                </button>
                <button className="text-accent-700 hover:underline" onClick={() => tickAll(false)}>
                  Untick all
                </button>
              </div>
            </div>
            {matched.length === 0 ? (
              <Empty title="Nothing on the list matched an item" hint="Check the codes: a supplier code, a barcode or your SKU." />
            ) : (
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full text-[12.5px]" data-testid="preview-lines">
                  <thead className="bg-white">
                    <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                      <th className="w-8 px-3 py-2" />
                      <th className="px-2 py-2 font-medium">Item</th>
                      <th className="px-2 py-2 text-right font-medium">Cost: old → new</th>
                      <th className="px-2 py-2 text-right font-medium">Price now</th>
                      <th className="px-2 py-2 text-right font-medium">New price</th>
                      <th className="px-3 py-2 text-right font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {matched.map((l) => {
                      const m = l.match!;
                      const c = choices[l.row] ?? { tick: false, sell: '' };
                      const v = sellOf(l.row);
                      const newSell = v === 'bad' ? null : (v ?? m.currentSell);
                      const below = newSell !== null && l.cost !== null && newSell < l.cost;
                      const margin = newSell === null || l.cost === null || newSell <= 0 ? null : Math.round(((newSell - l.cost) / newSell) * 1000) / 10;
                      return (
                        <tr key={l.row} className={c.tick ? '' : 'opacity-60'} data-testid="preview-line">
                          <td className="px-3 py-2 align-top">
                            <input
                              type="checkbox"
                              checked={c.tick}
                              onChange={(e) => setChoices((x) => ({ ...x, [l.row]: { ...c, tick: e.target.checked } }))}
                              aria-label={`Apply line ${l.row}`}
                            />
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="font-medium">{m.name}</div>
                            <div className="text-ink-400 text-[11px]">
                              {m.packLabel} · <span className="font-mono">{l.code}</span> by {m.by}
                            </div>
                          </td>
                          <td className="tnum px-2 py-2 text-right align-top whitespace-nowrap">
                            <span className="text-ink-500">
                              {packCost(m.oldCost)}
                              {m.oldCostSource === 'average' && <span className="text-[10.5px]"> avg</span>}
                            </span>{' '}
                            → <span className="font-medium">{packCost(l.cost)}</span>
                            {m.costChangePercent !== null && m.costChangePercent !== 0 && (
                              <div className={`text-[11px] ${m.costChangePercent > 0 ? 'text-red-700' : 'text-accent-700'}`}>
                                {m.costChangePercent > 0 ? '+' : ''}
                                {m.costChangePercent.toFixed(1)}%
                              </div>
                            )}
                          </td>
                          <td className="tnum text-ink-600 px-2 py-2 text-right align-top">{m.currentSell === null ? 'no price' : money(m.currentSell)}</td>
                          <td className="px-2 py-2 text-right align-top">
                            <input
                              inputMode="decimal"
                              value={c.sell}
                              placeholder="keep"
                              onChange={(e) => setChoices((x) => ({ ...x, [l.row]: { ...c, sell: e.target.value } }))}
                              aria-label={`New price for line ${l.row}`}
                              className={`border-ink-200 focus:border-accent-500 tnum w-24 rounded-lg border bg-white px-2 py-1 text-right text-[12.5px] outline-none ${below || v === 'bad' ? 'border-red-400' : ''}`}
                            />
                            {below && <div className="mt-0.5 text-[11px] text-red-700">below cost</div>}
                          </td>
                          <td className="tnum px-3 py-2 text-right align-top whitespace-nowrap">
                            <span className="text-ink-500">{pct(m.oldMargin)}</span> → <span className={margin !== null && margin < 0 ? 'text-red-700' : ''}>{pct(margin)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {unmatched.length > 0 && (
            <Card className="px-4 py-3" data-testid="unmatched">
              <h2 className="mb-1 text-[13px] font-semibold tracking-tight text-amber-800">Not matched ({unmatched.length}): these are left out</h2>
              <p className="text-ink-500 mb-2 text-[11.5px]">To match one next time, give the item that barcode, or use your SKU on the list.</p>
              <ul className="space-y-0.5 text-[12px]">
                {unmatched.map((l) => (
                  <li key={l.row}>
                    <span className="text-ink-400">Line {l.row}:</span> <span className="font-mono">{l.code || '—'}</span> {l.description} {l.cost !== null && `· ${packCost(l.cost)}`}{' '}
                    <span className="text-amber-800">— {l.problem}</span>
                    {l.suggestions.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-4" data-testid="did-you-mean">
                        <span className="text-ink-500">Did you mean:</span>
                        {l.suggestions.map((sg) => (
                          <button
                            key={sg.packId}
                            onClick={() => {
                              const next = { ...links, [l.code.toLowerCase()]: sg.packId };
                              setLinks(next);
                              void doPreview(next);
                            }}
                            className="border-accent-300/60 bg-accent-50 text-accent-700 hover:bg-accent-100 rounded-md border px-2 py-0.5 text-[12px]"
                          >
                            {sg.name} · {sg.packLabel} <span className="text-ink-400">({Math.round(sg.score * 100)}%)</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="space-y-3 px-4 py-4">
            <label className="block max-w-lg">
              <span className={label}>Note (optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Price increase from 1 October" aria-label="Note" className={field} />
            </label>
            {problems.length > 0 && (
              <ul className="space-y-0.5 text-[12px] text-red-700">
                {problems.slice(0, 5).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <Button variant="primary" onClick={() => void apply()} disabled={picked.length === 0 || problems.length > 0 || busy}>
              {busy ? <Spinner /> : null}
              Apply {picked.length} line{picked.length === 1 ? '' : 's'} · {priceChanges} price change{priceChanges === 1 ? '' : 's'}
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}

export function PriceListDetailPage() {
  const { id = '' } = useParams();
  const d = useAsync(() => api.supplierPriceList(id), [id]);
  if (d.error !== undefined) return <ErrorNote error={d.error} />;
  const p = d.data;
  if (p === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/price-lists" className="hover:text-ink-700 hover:underline">
          Price lists
        </Link>{' '}
        / {p.listNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Price list <span className="font-mono" data-testid="list-no">{p.listNo}</span>
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            <Link to={`/suppliers/${p.supplierId}`} className="hover:underline">
              {p.supplierName}
            </Link>{' '}
            · imported {shortDateTime(p.createdAt)} by {p.byName} · {ruleText(p.rule)}
            {p.note !== null && ` · ${p.note}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="info">{p.pricesChanged} prices changed</Badge>
          <Button className="no-print" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="list-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Their code</th>
                <th className="px-2 py-2 text-right font-medium">Old cost</th>
                <th className="px-2 py-2 text-right font-medium">New cost</th>
                <th className="px-2 py-2 text-right font-medium">Old price</th>
                <th className="px-4 py-2 text-right font-medium">New price</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {p.items.map((l) => (
                <tr key={l.lineNo}>
                  <td className="px-4 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-ink-400 text-[11px]">
                      {l.packLabel} · <span className="font-mono">{l.sku}</span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11.5px]">{l.supplierCode ?? '—'}</td>
                  <td className="tnum text-ink-500 px-2 py-1.5 text-right">{packCost(l.oldCost)}</td>
                  <td className="tnum px-2 py-1.5 text-right font-medium">{packCost(l.cost)}</td>
                  <td className="tnum text-ink-500 px-2 py-1.5 text-right">{l.oldSell === null ? '—' : money(l.oldSell)}</td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">
                    {l.newSell === null || l.newSell === l.oldSell ? <span className="text-ink-400 font-normal">unchanged</span> : money(l.newSell)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
