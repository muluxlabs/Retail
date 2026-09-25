/**
 * Receive stock (goods received).
 *
 * The conversion from "5 cases" to "50 singles" happens here, at the edge,
 * exactly once - the UI multiplies the chosen pack's qtyBase by the quantity
 * entered before calling the API, and the ledger only ever sees the base-unit
 * result (AD-2). This is the fix for the mechanism behind the USD 214,516
 * variance: receiving in cases and selling in singles with no rule
 * connecting them.
 *
 * Cost is entered per pack, because that is how a supplier invoices ("$13.50
 * a case"), and converted to cost-per-base-unit before posting, because that
 * is what the ledger and the WAC view actually need.
 */

import { useState } from 'react';

import { api, ApiError, type Branch, type Product } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { stockReason } from '../lib/terms.js';
import { Badge, Button, Card, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

export function Receive() {
  const { user } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [packId, setPackId] = useState('');
  const [qtyPacks, setQtyPacks] = useState('');
  const [costPerPack, setCostPerPack] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{
    productName: string;
    qtyBase: number;
    qtyAfter: number;
  } | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );
  const recent = useAsync(
    () => (branchId === '' ? Promise.resolve({ items: [] }) : api.movements({ branchId, limit: 8 })),
    [branchId, lastReceipt],
  );

  const pack = product?.packs.find((p) => p.id === packId) ?? null;
  const parsedQty = Number(qtyPacks);
  const parsedCostPerPack = costPerPack.trim() === '' ? null : Number(costPerPack);
  const qtyBase = pack !== null && Number.isFinite(parsedQty) ? parsedQty * pack.qtyBase : null;
  const unitCost =
    pack !== null && parsedCostPerPack !== null && Number.isFinite(parsedCostPerPack)
      ? parsedCostPerPack / pack.qtyBase
      : null;

  function selectProduct(p: Product) {
    setProduct(p);
    setSearch('');
    const defaultBuy = p.packs.find((pk) => pk.isDefaultBuy) ?? p.packs[0];
    setPackId(defaultBuy?.id ?? '');
  }

  function reset() {
    setProduct(null);
    setPackId('');
    setQtyPacks('');
    setCostPerPack('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pack === null || qtyBase === null || user === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.postMovement({
        productId: product!.id,
        branchId,
        qtyBase,
        reason: 'grn',
        actorId: user.personId,
        unitCost,
        docType: 'GRN',
      });
      setLastReceipt({ productName: product!.name, qtyBase, qtyAfter: result.qtyAfter });
      reset();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Goods received</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Post a goods receipt. Enter what arrived, in the pack it arrived in - the ledger converts
          it to base units.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="px-4 py-4">
          <label className="mb-4 block max-w-xs">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Branch
            </span>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select a branch…</option>
              {(branches.data ?? []).map((b: Branch) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          {branchId === '' ? (
            <p className="text-ink-400 text-[12.5px]">Choose a branch to start receiving.</p>
          ) : product === null ? (
            <div>
              <label className="block">
                <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                  Find product
                </span>
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or SKU…"
                  className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
                />
              </label>
              {results.data !== undefined && results.data.items.length > 0 && (
                <ul className="border-ink-200 mt-2 divide-y divide-ink-100 overflow-hidden rounded-lg border">
                  {results.data.items.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => selectProduct(p)}
                        className="hover:bg-ink-50 flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px]"
                      >
                        <span>
                          <span className="font-medium">{p.name}</span>
                          <span className="text-ink-400 ml-2 font-mono text-[11px]">{p.sku}</span>
                        </span>
                        <span className="text-ink-400 text-[11px]">
                          {p.packs.length} pack{p.packs.length === 1 ? '' : 's'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3.5">
              <div className="border-accent-200 bg-accent-50/50 flex items-center justify-between rounded-lg border px-3 py-2">
                <div>
                  <div className="text-[13px] font-medium">{product.name}</div>
                  <div className="text-ink-400 font-mono text-[11px]">{product.sku}</div>
                </div>
                <button
                  type="button"
                  onClick={reset}
                  className="text-ink-400 hover:text-ink-700 text-[11.5px]"
                >
                  Change
                </button>
              </div>

              {product.packs.length === 0 ? (
                <div className="text-[12.5px] text-red-600">
                  This product has no pack defined - it cannot be received. Add a pack in the item
                  master first.
                </div>
              ) : (
                <>
                  <label className="block">
                    <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                      Received as
                    </span>
                    <select
                      value={packId}
                      onChange={(e) => setPackId(e.target.value)}
                      className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                    >
                      {product.packs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} ({qty(p.qtyBase)} {product.baseUom})
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                        Quantity ({pack?.label ?? 'pack'})
                      </span>
                      <input
                        required
                        type="number"
                        min="0.0001"
                        step="any"
                        autoFocus
                        value={qtyPacks}
                        onChange={(e) => setQtyPacks(e.target.value)}
                        className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                        Cost per {pack?.label ?? 'pack'} (optional)
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={costPerPack}
                        onChange={(e) => setCostPerPack(e.target.value)}
                        placeholder="0.00"
                        className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
                      />
                    </label>
                  </div>

                  {qtyBase !== null && (
                    <div className="text-ink-500 text-[12px]">
                      = <span className="tnum font-medium">{qty(qtyBase)}</span> {product.baseUom}
                      {unitCost !== null && (
                        <>
                          {' '}
                          at <span className="tnum font-medium">{money(unitCost)}</span> per{' '}
                          {product.baseUom}
                        </>
                      )}
                    </div>
                  )}

                  {error !== null && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
                      {error}
                    </div>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    disabled={busy || qtyBase === null || qtyBase <= 0}
                  >
                    {busy ? <Spinner /> : null}
                    Post receipt
                  </Button>
                </>
              )}
            </form>
          )}

          {lastReceipt !== null && (
            <div className="border-accent-200 bg-accent-50/60 mt-4 rounded-lg border px-3 py-2.5 text-[12.5px]">
              <span className="font-medium">Received.</span> {lastReceipt.productName}: +
              {qty(lastReceipt.qtyBase)} → on hand now {qty(lastReceipt.qtyAfter)}.
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Recent movements here</h2>
          </div>
          {branchId === '' ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12px]">
              Choose a branch to see recent activity.
            </p>
          ) : recent.data === undefined || recent.data.items.length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12px]">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {recent.data.items.map((m) => (
                <li key={m.seq} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                  <span
                    className={`tnum w-14 shrink-0 font-medium ${
                      m.qtyBase < 0 ? 'text-red-600' : 'text-accent-700'
                    }`}
                  >
                    {m.qtyBase > 0 ? '+' : ''}
                    {qty(m.qtyBase)}
                  </span>
                  <span className="text-ink-600 min-w-0 flex-1 truncate">{m.productName}</span>
                  <Badge tone="neutral">{stockReason(m.reason).short}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
