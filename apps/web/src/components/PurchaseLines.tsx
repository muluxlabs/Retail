/**
 * The lines of an order or a delivery: what, in which pack, how many, at what
 * price per pack. Search adds an item; quantity and price are typed. Line totals
 * and the grand total are worked out as you type, by the same rule the server
 * applies (each line rounded to the cent).
 *
 * Costs are per PACK, because that is how a supplier invoices ("$13.50 a
 * case"); the server converts to a cost per base unit for the stock ledger.
 */

import { useState } from 'react';

import { api, type Product } from '../lib/api.js';
import { costLineCents, fromCents, parseCost, parseQty } from '../lib/basketMath.js';
import { packCost } from '../lib/buying.js';
import { Badge, Spinner, money, qty, useAsync } from '../lib/ui.js';

export interface PurchaseLine {
  key: string;
  productId: string;
  packId: string;
  name: string;
  sku: string;
  packs: { id: string; label: string; qtyBase: number }[];
  qty: string;
  cost: string;
  /** Set when the line comes from a purchase order. */
  poLineId?: string | null;
  orderedPacks?: number;
  orderedCost?: number;
  receivedPacks?: number;
}

export const newKey = (): string => crypto.randomUUID();

export function lineFromProduct(p: Product): PurchaseLine | null {
  const pack = p.packs.find((k) => k.isDefaultBuy) ?? p.packs[0];
  if (pack === undefined) return null;
  return {
    key: newKey(),
    productId: p.id,
    packId: pack.id,
    name: p.name,
    sku: p.sku,
    packs: p.packs.map((k) => ({ id: k.id, label: k.label, qtyBase: k.qtyBase })),
    qty: '',
    cost: '',
  };
}

export interface ParsedLines {
  ok: boolean;
  /** Worked out only for lines that are complete. */
  totalCents: number;
  perLine: { cents: number | null; problem: string | null }[];
  problem: string | null;
}

export function parseLines(lines: PurchaseLine[]): ParsedLines {
  const perLine = lines.map((l) => {
    const q = parseQty(l.qty);
    const c = parseCost(l.cost);
    if (q === null) return { cents: null, problem: 'Enter a quantity' };
    if (c === null) return { cents: null, problem: 'Enter the price per pack' };
    return { cents: costLineCents(q, c), problem: null };
  });
  const problem = lines.length === 0 ? 'Add at least one item.' : (perLine.find((p) => p.problem !== null)?.problem ?? null);
  return {
    ok: problem === null,
    totalCents: perLine.reduce((s, p) => s + (p.cents ?? 0), 0),
    perLine,
    problem,
  };
}

export function PurchaseLines({
  lines,
  onChange,
  showOrdered = false,
  canAdd = true,
}: {
  lines: PurchaseLine[];
  onChange: (lines: PurchaseLine[]) => void;
  /** Show the ordered quantity and price beside what is being received. */
  showOrdered?: boolean;
  canAdd?: boolean;
}) {
  const [search, setSearch] = useState('');
  const results = useAsync(
    () => (search.trim() === '' ? Promise.resolve({ items: [] as Product[], total: 0, limit: 0, offset: 0 }) : api.products({ search, limit: 8 })),
    [search],
  );
  const parsed = parseLines(lines);

  const patch = (key: string, p: Partial<PurchaseLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const input = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2 py-1.5 text-[13px] outline-none';

  function add(p: Product) {
    const line = lineFromProduct(p);
    if (line === null) return;
    // The same product and pack twice is one line with more on it.
    const same = lines.find((l) => l.packId === line.packId && (l.poLineId ?? null) === null);
    if (same !== undefined) patch(same.key, { qty: String((parseQty(same.qty) ?? 0) + 1) });
    else onChange([...lines, line]);
    setSearch('');
  }

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="relative">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Add an item</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or SKU…"
              aria-label="Search items to add"
              className={`${input} w-full`}
            />
          </label>
          {search.trim() !== '' && (
            <div className="border-ink-100 mt-1 max-h-64 divide-y overflow-y-auto rounded-lg border bg-white">
              {results.loading ? (
                <div className="grid place-items-center py-4">
                  <Spinner />
                </div>
              ) : (results.data?.items ?? []).length === 0 ? (
                <p className="text-ink-400 px-3 py-3 text-[12.5px]">No item matches “{search}”. Add it in the Item master first.</p>
              ) : (
                (results.data?.items ?? []).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => add(p)}
                    className="hover:bg-ink-50 flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px]"
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-ink-400 shrink-0 font-mono text-[11px]">{p.sku}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {lines.length === 0 ? (
        <p className="text-ink-400 rounded-lg border border-dashed px-4 py-6 text-center text-[12.5px]">No items yet. Search above to add the first.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="purchase-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="py-2 pr-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Pack</th>
                {showOrdered && <th className="px-2 py-2 text-right font-medium">Ordered</th>}
                <th className="px-2 py-2 text-right font-medium">Quantity</th>
                <th className="px-2 py-2 text-right font-medium">Price per pack</th>
                <th className="px-2 py-2 text-right font-medium">Line total</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {lines.map((l, i) => {
                const pl = parsed.perLine[i]!;
                const orderedCost = l.orderedCost;
                const c = parseCost(l.cost);
                const priceDiffers = orderedCost !== undefined && c !== null && Math.abs(c - orderedCost) > 0.00005;
                return (
                  <tr key={l.key} className="align-top" data-testid="purchase-line">
                    <td className="py-2 pr-2">
                      <div className="font-medium">{l.name}</div>
                      <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                    </td>
                    <td className="px-2 py-2">
                      {l.poLineId !== undefined && l.poLineId !== null ? (
                        <span className="text-ink-600">{l.packs.find((k) => k.id === l.packId)?.label}</span>
                      ) : (
                        <select
                          value={l.packId}
                          onChange={(e) => patch(l.key, { packId: e.target.value })}
                          aria-label={`Pack of ${l.name}`}
                          className={input}
                        >
                          {l.packs.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.label} ({qty(k.qtyBase)})
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    {showOrdered && (
                      <td className="tnum text-ink-500 px-2 py-2 text-right">
                        {l.orderedPacks === undefined ? '—' : qty(l.orderedPacks)}
                        {l.receivedPacks !== undefined && l.receivedPacks > 0 && (
                          <div className="text-[11px]">{qty(l.receivedPacks)} already in</div>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-2 text-right">
                      <input
                        inputMode="decimal"
                        value={l.qty}
                        aria-label={`Quantity of ${l.name}`}
                        onChange={(e) => patch(l.key, { qty: e.target.value })}
                        className={`${input} tnum w-24 text-right`}
                      />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <input
                        inputMode="decimal"
                        value={l.cost}
                        placeholder="0.00"
                        aria-label={`Price per pack of ${l.name}`}
                        onChange={(e) => patch(l.key, { cost: e.target.value })}
                        className={`${input} tnum w-28 text-right`}
                      />
                      {priceDiffers && orderedCost !== undefined && (
                        <div className="mt-0.5 text-[11px] text-amber-700">ordered at {packCost(orderedCost)}</div>
                      )}
                    </td>
                    <td className="tnum px-2 py-2 text-right font-medium">
                      {pl.cents === null ? <span className="text-ink-300">—</span> : money(fromCents(pl.cents))}
                    </td>
                    <td className="pr-1 text-right">
                      <button
                        onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                        aria-label={`Remove ${l.name}`}
                        className="text-ink-400 py-2 text-[15px] leading-none hover:text-red-600"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t">
                <td colSpan={showOrdered ? 5 : 4} className="py-2 pr-2 text-right text-[12px] font-medium">
                  Total
                </td>
                <td className="tnum px-2 py-2 text-right text-[14px] font-semibold" data-testid="lines-total">
                  {money(fromCents(parsed.totalCents))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {parsed.problem !== null && lines.length > 0 && <Badge tone="warn">{parsed.problem}</Badge>}
    </div>
  );
}
