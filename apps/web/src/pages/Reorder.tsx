/**
 * Reorder: what a branch is about to run out of, how much to order, from whom.
 *
 * The numbers are the server's (routes/reorder.ts): selling pace over recent
 * weeks, stock on hand plus what is already on order or on its way, the
 * supplier's delivery time and how many more days of stock to hold. Each
 * supplier's list becomes a purchase order in one click - opened on the order
 * screen to check and place, never placed by itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import type { PurchaseLine } from '../components/PurchaseLines.js';
import { api, type ReorderItem } from '../lib/api.js';
import { useMyBranches } from '../lib/myBranches.js';
import { Badge, Button, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

function remembered(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(`reorder.${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, v: number) {
  try {
    localStorage.setItem(`reorder.${key}`, String(v));
  } catch {
    /* a convenience only */
  }
}

export function Reorder() {
  const nav = useNavigate();
  const branches = useMyBranches();
  const [branchId, setBranchId] = useState('');
  const [lookback, setLookback] = useState(() => remembered('lookback', 30));
  const [lead, setLead] = useState(() => remembered('lead', 7));
  const [cover, setCover] = useState(() => remembered('cover', 14));
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (branchId === '' && branches.list.length === 1 && branches.list[0] !== undefined) setBranchId(branches.list[0].id);
  }, [branches.list, branchId]);

  const data = useAsync(
    () => (branchId === '' ? Promise.resolve(null) : api.reorder({ branchId, lookbackDays: lookback, leadDays: lead, coverDays: cover })),
    [branchId, lookback, lead, cover],
  );
  useEffect(() => {
    setQtys({});
    setLeft(new Set());
  }, [data.data]);

  const items = data.data?.items ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, { supplier: ReorderItem['supplier']; items: ReorderItem[] }>();
    for (const i of items) {
      const k = i.supplier?.id ?? '';
      if (!m.has(k)) m.set(k, { supplier: i.supplier, items: [] });
      m.get(k)!.items.push(i);
    }
    // Suppliers by name; items with no supplier on record last.
    return [...m.entries()].sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : (x.supplier?.name ?? '').localeCompare(y.supplier?.name ?? '')));
  }, [items]);

  const packsOf = (i: ReorderItem) => {
    const t = qtys[i.productId];
    if (t === undefined) return i.suggestPacks;
    const v = Number(t);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const chosen = (i: ReorderItem) => !left.has(i.productId) && packsOf(i) > 0 && i.pack !== null;

  function createOrder(supplierId: string, list: ReorderItem[]) {
    const lines: PurchaseLine[] = list.filter(chosen).map((i) => ({
      key: crypto.randomUUID(),
      productId: i.productId,
      packId: i.pack!.id,
      name: i.name,
      sku: i.sku,
      packs: i.packs,
      qty: String(packsOf(i)),
      cost: i.costPerPack === null ? '' : String(i.costPerPack),
    }));
    nav('/orders/new', { state: { reorder: { supplierId, branchId, lines } } });
  }

  const out = items.filter((i) => i.urgency === 'out').length;

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Reorder</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          What this branch will run out of before a new delivery could arrive, and how much to order - worked out from how fast each item has been
          selling. Stock already on order or on its way is counted, so nothing is ordered twice. Each supplier’s list opens as a purchase order to
          check and place.
        </p>
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field} aria-label="Branch">
              <option value="">Select a branch…</option>
              {branches.list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <NumberSetting label="Selling pace over the last" unit="days" value={lookback} min={7} max={180} onChange={(v) => { setLookback(v); remember('lookback', v); }} />
          <NumberSetting label="Supplier delivers in" unit="days" value={lead} min={0} max={90} onChange={(v) => { setLead(v); remember('lead', v); }} />
          <NumberSetting label="Then hold stock for" unit="more days" value={cover} min={1} max={180} onChange={(v) => { setCover(v); remember('cover', v); }} />
        </div>
      </Card>

      {data.error !== undefined && <ErrorNote error={data.error} />}
      {branchId === '' ? (
        <Card className="px-4 py-10">
          <Empty title="Choose a branch" hint="Pick the branch to reorder for." />
        </Card>
      ) : data.loading ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card className="px-4 py-10">
          <Empty title="Nothing to reorder" hint="Everything that has been selling here will last until a new delivery could arrive." />
        </Card>
      ) : (
        <>
          <div className="text-ink-600 text-[12.5px]" data-testid="reorder-summary">
            <b>{items.length}</b> item{items.length === 1 ? '' : 's'} to reorder
            {out > 0 && (
              <>
                {' '}· <span className="font-medium text-red-700">{out} already out of stock</span>
              </>
            )}
          </div>
          {groups.map(([sid, g]) => {
            const total = g.items.filter(chosen).reduce((s, i) => s + (i.costPerPack ?? 0) * packsOf(i), 0);
            const n = g.items.filter(chosen).length;
            return (
              <Card key={sid || 'none'} className="overflow-hidden" data-testid="reorder-supplier">
                <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div className="text-[13.5px] font-semibold">{g.supplier?.name ?? 'No supplier on record'}</div>
                  <div className="flex items-center gap-3">
                    <span className="tnum text-ink-600 text-[12.5px]">{money(total)}</span>
                    <Button variant="primary" disabled={n === 0} onClick={() => createOrder(sid, g.items)}>
                      Create order ({n})
                    </Button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-ink-400 border-ink-100 border-b text-left text-[10.5px] uppercase tracking-wider">
                        <th className="w-8 px-3 py-2" />
                        <th className="px-2 py-2 font-medium">Item</th>
                        <th className="px-2 py-2 text-right font-medium">Left</th>
                        <th className="px-2 py-2 text-right font-medium">On the way</th>
                        <th className="px-2 py-2 text-right font-medium">Selling</th>
                        <th className="px-2 py-2 text-right font-medium">Order</th>
                        <th className="px-3 py-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-ink-100 divide-y">
                      {g.items.map((i) => {
                        const p = packsOf(i);
                        return (
                          <tr key={i.productId} className={chosen(i) ? '' : 'opacity-50'} data-testid="reorder-line">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={!left.has(i.productId)}
                                aria-label={`Order ${i.name}`}
                                onChange={(e) =>
                                  setLeft((s) => {
                                    const n2 = new Set(s);
                                    if (e.target.checked) n2.delete(i.productId);
                                    else n2.add(i.productId);
                                    return n2;
                                  })
                                }
                                className="accent-accent-600 size-3.5"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <div className="font-medium">{i.name}</div>
                              <div className="text-ink-400 font-mono text-[11px]">{i.sku}</div>
                            </td>
                            <td className="px-2 py-2 text-right">
                              <div className="tnum">{qty(i.onHand)}</div>
                              {i.urgency === 'out' ? (
                                <Badge tone="bad">out of stock</Badge>
                              ) : (
                                <span className={`text-[11px] ${i.urgency === 'soon' ? 'text-red-700' : 'text-amber-700'}`}>{qty(i.daysLeft)} days left</span>
                              )}
                            </td>
                            <td className="tnum text-ink-600 px-2 py-2 text-right">{i.onOrder + i.inTransit === 0 ? '—' : qty(i.onOrder + i.inTransit)}</td>
                            <td className="tnum text-ink-600 px-2 py-2 text-right">{qty(i.perDay)} a day</td>
                            <td className="px-2 py-2 text-right">
                              {i.pack === null ? (
                                <span className="text-amber-700 text-[11px]">no pack</span>
                              ) : (
                                <div className="flex items-center justify-end gap-1.5">
                                  <input
                                    inputMode="numeric"
                                    value={qtys[i.productId] ?? String(i.suggestPacks)}
                                    onChange={(e) => setQtys((s) => ({ ...s, [i.productId]: e.target.value }))}
                                    aria-label={`How many ${i.pack.label} of ${i.name}`}
                                    className={`${field} tnum w-16 text-right`}
                                  />
                                  <span className="text-ink-500 text-[11.5px] whitespace-nowrap">
                                    × {i.pack.label}
                                    {i.pack.qtyBase !== 1 && <span className="text-ink-400"> = {qty(p * i.pack.qtyBase)}</span>}
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="tnum px-3 py-2 text-right">
                              {i.costPerPack === null ? <span className="text-ink-400 text-[11px]">no price yet</span> : money(i.costPerPack * p)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
          <details className="text-ink-500 text-[12px]">
            <summary className="cursor-pointer">How this is worked out</summary>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li><b>Selling</b> is units sold at this branch over the period, per day (a warehouse also counts what it sent to branches).</li>
              <li>An item is listed when what is on hand, on order and on its way will not last until a new delivery could arrive.</li>
              <li><b>Order</b> brings it up to enough for the delivery time plus the extra days you choose, rounded up to whole buying packs.</li>
              <li>The price is the supplier’s latest price list, or else the last delivery. Items that have not sold in the period are not listed - see what is not moving instead.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function NumberSetting({ label: text, unit, value, min, max, onChange }: { label: string; unit: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="block">
      <span className={label}>{text}</span>
      <span className="flex items-center gap-1.5">
        <input
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = Math.round(Number(draft));
            if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
            else setDraft(String(value));
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={`${text} (${unit})`}
          className={`${field} tnum w-16 text-right`}
        />
        <span className="text-ink-500 text-[12px]">{unit}</span>
      </span>
    </label>
  );
}
