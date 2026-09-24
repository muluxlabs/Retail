/**
 * Sell / stock out.
 *
 * Three controls from HANDOFF and the client's own feedback live directly on
 * this screen, not as an afterthought:
 *
 *   - scanning something not in the master used to pass silently, which is
 *     how under-the-counter selling stayed invisible (section 2.7). Here an
 *     unresolved barcode is a dead end that turns into a work item with one
 *     click, not a shrug.
 *   - a cashier should not have to know or type a barcode at all: the same
 *     searchable list used on Receive is here too, so picking a product by
 *     name and checking out is a first-class path, not a fallback.
 *   - when neither a scan nor a search finds anything, the cashier can add
 *     the item themselves and keep selling - but it lands as a work item in
 *     review, not silently in the trusted master (see quick-add below).
 *   - overriding a sale that would take stock negative is the "override to
 *     their own benefit" problem, verbatim. A cashier cannot grant it to
 *     themselves: the button only exists for someone who already holds
 *     stock.override, matching what the API enforces server-side regardless.
 */

import { useEffect, useRef, useState } from 'react';

import { api, ApiError, type Branch, type Product } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Spinner, qty, useAsync } from '../lib/ui.js';

interface Resolved {
  /** null when this came from the searchable list or a quick-add with no code, not a scan. */
  code: string | null;
  productId: string;
  productName: string;
  packId: string;
  qtyBase: number;
  pending?: boolean;
}

interface SoldLine {
  productName: string;
  qtyPacks: number;
  qtyAfter: number;
  overridden: boolean;
}

export function Sell() {
  const { user, can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [qtyPacks, setQtyPacks] = useState('1');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ available: number; requested: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sold, setSold] = useState<SoldLine[]>([]);
  const [loggedScan, setLoggedScan] = useState(false);
  const [quickAdding, setQuickAdding] = useState<{ name: string; barcode: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const branches = useAsync(() => api.branches(), []);
  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, [resolved]);

  function resetPickers() {
    setResolved(null);
    setNotFound(null);
    setBlocked(null);
    setError(null);
    setLoggedScan(false);
    setQuickAdding(null);
  }

  async function lookUp() {
    const trimmed = code.trim();
    if (trimmed === '') return;
    resetPickers();
    try {
      const r = await api.resolveBarcode(trimmed);
      setResolved({
        code: r.code,
        productId: r.productId,
        productName: r.productName,
        packId: r.packId,
        qtyBase: r.qtyBase,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(trimmed);
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    }
  }

  function pickProduct(p: Product) {
    const pack = p.packs.find((pk) => pk.isDefaultSell) ?? p.packs[0];
    if (pack === undefined) {
      setError(`${p.name} has no sellable pack yet.`);
      return;
    }
    resetPickers();
    setResolved({
      code: pack.barcode,
      productId: p.id,
      productName: p.name,
      packId: pack.id,
      qtyBase: pack.qtyBase,
      pending: p.reviewState === 'pending',
    });
    setSearch('');
  }

  async function logScan() {
    if (notFound === null || user === null) return;
    setBusy(true);
    try {
      await api.logUnlistedScan({ code: notFound, branchId, actorId: user.personId });
      setLoggedScan(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function quickAdd(name: string, barcode: string | null) {
    if (user === null || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.quickAddProduct({
        name: name.trim(),
        ...(barcode !== null ? { barcode } : {}),
        branchId,
      });
      setResolved({
        code: r.barcode,
        productId: r.id,
        productName: r.name,
        packId: r.packId,
        qtyBase: r.qtyBase,
        pending: true,
      });
      setNotFound(null);
      setSearch('');
      setQuickAdding(null);
      setCode('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitSale(override: boolean) {
    if (resolved === null || user === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.sell({
        ...(resolved.code !== null
          ? { barcode: resolved.code }
          : { productId: resolved.productId, packId: resolved.packId }),
        qtyPacks: Number(qtyPacks),
        branchId,
        actorId: user.personId,
        ...(override ? { overrideNegative: true, overrideBy: user.personId } : {}),
      });
      setSold((rows) => [
        { productName: resolved.productName, qtyPacks: Number(qtyPacks), qtyAfter: result.qtyAfter, overridden: override },
        ...rows,
      ]);
      setBlocked(null);
      setResolved(null);
      setCode('');
      setQtyPacks('1');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NEGATIVE_STOCK_BLOCKED') {
        setBlocked({
          available: Number(e.detail['available'] ?? 0),
          requested: Number(e.detail['requested'] ?? 0),
        });
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const searchItems = results.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sell / stock out</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Scan or type a barcode, or search the item master by name. Nothing found either way? Add
          it and keep selling - a manager reviews it afterwards.
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
            <p className="text-ink-400 text-[12.5px]">Choose a branch to start selling.</p>
          ) : resolved !== null ? (
            <div className="space-y-3.5">
              <div className="flex items-end gap-3">
                <label className="block w-24">
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Qty
                  </span>
                  <input
                    type="number"
                    min="0.0001"
                    step="any"
                    value={qtyPacks}
                    onChange={(e) => setQtyPacks(e.target.value)}
                    className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-2 text-[14px] outline-none"
                  />
                </label>
              </div>

              <div className="border-accent-200 bg-accent-50/60 rounded-lg border px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <div className="text-[13px] font-medium">{resolved.productName}</div>
                  {resolved.pending === true && <Badge tone="warn">pending review</Badge>}
                </div>
                <div className="text-ink-500 mt-0.5 text-[11.5px]">
                  {qty(resolved.qtyBase)} base units per unit sold
                  {resolved.code !== null && <> · {resolved.code}</>}
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <Button variant="primary" onClick={() => void submitSale(false)} disabled={busy}>
                    {busy ? <Spinner /> : null}
                    Sell {qtyPacks || '1'}
                  </Button>
                  <button
                    onClick={resetPickers}
                    className="text-ink-400 hover:text-ink-700 text-[12px]"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              {blocked !== null && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-red-800">
                    Insufficient stock: {qty(blocked.available)} on hand, {qty(blocked.requested)}{' '}
                    requested.
                  </div>
                  {can('stock.override') ? (
                    <>
                      <p className="mt-0.5 text-red-700/80">
                        You hold override authority. This will be logged as an open exception.
                      </p>
                      <Button
                        variant="danger"
                        onClick={() => void submitSale(true)}
                        disabled={busy}
                        className="mt-2"
                      >
                        Authorise and sell anyway
                      </Button>
                    </>
                  ) : (
                    <p className="mt-0.5 text-red-700/80">
                      Overriding this requires manager authorisation. Ask a branch manager to sign
                      in and complete this sale.
                    </p>
                  )}
                </div>
              )}

              {error !== null && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
                  {error}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="flex items-end gap-3">
                <label className="block flex-1">
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Barcode
                  </span>
                  <input
                    ref={inputRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void lookUp();
                      }
                    }}
                    placeholder="Scan or type…"
                    className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 font-mono text-[14px] outline-none"
                  />
                </label>
                <Button onClick={() => void lookUp()} disabled={code.trim() === ''}>
                  Look up
                </Button>
              </div>

              {notFound !== null && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-amber-900">
                    “{notFound}” is not in the item master.
                  </div>
                  <p className="mt-0.5 text-amber-800/80">
                    The old system let this pass silently. Logging it turns the scan into evidence
                    a controller can act on - or add it below and sell it now.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {loggedScan ? (
                      <Badge tone="good">Logged</Badge>
                    ) : (
                      <Button onClick={() => void logScan()} disabled={busy}>
                        Log as unlisted scan
                      </Button>
                    )}
                    {can('product.quickadd') && quickAdding === null && (
                      <Button
                        variant="secondary"
                        onClick={() => setQuickAdding({ name: '', barcode: notFound })}
                      >
                        Add as a new item
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div>
                <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                  Or search by name
                </span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Start typing a product name or SKU…"
                  className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
                />
                {search.trim() !== '' && (
                  <div className="border-ink-100 mt-1.5 max-h-64 divide-y overflow-y-auto rounded-lg border">
                    {results.loading ? (
                      <div className="grid place-items-center py-4">
                        <Spinner />
                      </div>
                    ) : searchItems.length === 0 ? (
                      <div className="px-3 py-3 text-[12.5px]">
                        <p className="text-ink-400">No match for “{search}”.</p>
                        {can('product.quickadd') && quickAdding === null && (
                          <Button
                            variant="secondary"
                            className="mt-2"
                            onClick={() => setQuickAdding({ name: search, barcode: null })}
                          >
                            Add “{search}” as a new item
                          </Button>
                        )}
                      </div>
                    ) : (
                      searchItems.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => pickProduct(p)}
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

              {quickAdding !== null && (
                <QuickAddPanel
                  initialName={quickAdding.name}
                  barcode={quickAdding.barcode}
                  busy={busy}
                  onCancel={() => setQuickAdding(null)}
                  onSubmit={(name) => void quickAdd(name, quickAdding.barcode)}
                />
              )}

              {error !== null && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
                  {error}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">This session</h2>
          </div>
          {sold.length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12px]">Nothing sold yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {sold.map((line, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                  <span className="text-red-600 tnum w-10 shrink-0 font-medium">
                    -{qty(line.qtyPacks)}
                  </span>
                  <span className="text-ink-600 min-w-0 flex-1 truncate">{line.productName}</span>
                  {line.overridden && <Badge tone="warn">override</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Add-on-the-fly. Name only - category, proper SKU and everything else is
 * for whoever reviews it afterwards, not for a cashier mid-sale.
 */
function QuickAddPanel({
  initialName,
  barcode,
  busy,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  barcode: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);

  return (
    <div className="border-ink-200 rounded-lg border border-dashed px-3.5 py-3">
      <div className="text-[12.5px] font-medium">Add a new item</div>
      <p className="text-ink-500 mt-0.5 text-[11.5px]">
        This sells immediately. It also lands with a branch manager to map it onto an existing
        product, or accept it into the right category.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <label className="block flex-1">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What is it called?"
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <Button variant="primary" onClick={() => onSubmit(name)} disabled={busy || name.trim() === ''}>
          {busy ? <Spinner /> : null}
          Add and sell
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {barcode !== null && (
        <p className="text-ink-400 mt-1.5 text-[11px]">
          Scanned code {barcode} will be attached to it.
        </p>
      )}
    </div>
  );
}
