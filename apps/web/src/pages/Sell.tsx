/**
 * Point of sale: a basket of many items, one total, one receipt.
 *
 * Scan or search adds a line (scanning the same item again adds one to the
 * quantity). The total is worked out as the cashier builds the basket, then
 * they take payment - cash with change, card / mobile money / transfer, or a
 * split - and the whole basket is posted as ONE document: every stock movement,
 * the receipt, its payments and the cash in the till commit together or not at
 * all. What comes back is the receipt, ready to print.
 *
 * Controls carried over from the single-item screen, which still matter:
 *   - a scan that finds nothing is a dead end that becomes a work item, never
 *     a shrug (section 2.7 of HANDOFF: under-the-counter selling);
 *   - an item nobody has priced cannot be sold. Someone who may price (price.write)
 *     can set the price right here; everyone else has to ask them;
 *   - quick-add lets a cashier keep selling something the master lacks, but it
 *     needs the price being charged and lands in review;
 *   - selling more than is on the shelf is refused; only someone holding
 *     stock.override can authorise it, and it is logged as an exception. The
 *     server enforces all of this whatever is rendered here.
 *   - changing a line's price or giving a discount is for price.override holders
 *     only, and is logged as an exception.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { ReceiptDialog } from '../components/Receipt.js';
import {
  api,
  ApiError,
  type Branch,
  type PaymentType,
  type Product,
  type Receipt,
  type Till,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { basketCents, fromCents, lineCents, parseMoney, settleRows } from '../lib/basketMath.js';
import { Badge, Button, Card, Spinner, money, qty, useAsync } from '../lib/ui.js';

interface CartLine {
  packId: string;
  productId: string;
  name: string;
  sku: string;
  packLabel: string;
  /** null = nobody has priced this yet. */
  listPrice: number | null;
  qty: string;
  /** Typed override of the price; '' = charge the list price. */
  price: string;
  discount: string;
  pending: boolean;
}

interface PayRow {
  key: string;
  typeId: string;
  /** What the customer hands over; '' = the rest of the bill. */
  received: string;
  reference: string;
}

interface Blocked {
  productName: string;
  available: number;
  requested: number;
}

const store = {
  get: (k: string): string => {
    try {
      return window.localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string): void => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* private window: the choice just is not remembered */
    }
  },
};

const newKey = (): string => crypto.randomUUID();

export function Sell() {
  const { user, can } = useAuth();
  const mayOverridePrice = can('price.override');
  const mayPrice = can('price.write');

  const [branchId, setBranchId] = useState(() => store.get('sell.branch'));
  const [tillId, setTillId] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [saleId, setSaleId] = useState(newKey);
  const [pay, setPay] = useState<PayRow[]>([]);
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [notFound, setNotFound] = useState<string | null>(null);
  const [loggedScan, setLoggedScan] = useState(false);
  const [quickAdding, setQuickAdding] = useState<{ name: string; barcode: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ data: Receipt; fresh: boolean } | null>(null);
  const [recent, setRecent] = useState<{ id: string; receiptNo: string; net: number; items: number }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const branches = useAsync(() => api.branches(), []);
  const paymentTypes = useAsync(() => api.paymentTypes(), []);
  const tills = useAsync<Till[]>(() => (branchId === '' ? Promise.resolve([]) : api.tills(branchId)), [branchId]);
  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [] as Product[], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );

  const tillTypes: PaymentType[] = useMemo(
    () => (paymentTypes.data ?? []).filter((t) => t.atTill),
    [paymentTypes.data],
  );
  const typeById = useMemo(() => new Map(tillTypes.map((t) => [t.id, t])), [tillTypes]);

  // A single branch (a branch manager, a cashier) needs no choosing.
  useEffect(() => {
    const list = branches.data ?? [];
    if (branchId === '' && list.length === 1 && list[0] !== undefined) setBranchId(list[0].id);
  }, [branches.data, branchId]);

  // Remember the till per branch; with a single till there is nothing to pick.
  useEffect(() => {
    const list = tills.data ?? [];
    const remembered = store.get(`sell.till.${branchId}`);
    if (list.some((t) => t.id === remembered)) setTillId(remembered);
    else setTillId(list.length === 1 && list[0] !== undefined ? list[0].id : '');
  }, [tills.data, branchId]);

  // Start with one cash line, the common case.
  useEffect(() => {
    if (pay.length === 0 && tillTypes.length > 0) {
      const cash = tillTypes.find((t) => t.isCash) ?? tillTypes[0];
      if (cash !== undefined) setPay([{ key: newKey(), typeId: cash.id, received: '', reference: '' }]);
    }
  }, [tillTypes, pay.length]);

  useEffect(() => {
    if (receipt === null) inputRef.current?.focus();
  }, [receipt, branchId]);

  // -- the basket ---------------------------------------------------------------

  const parsed = cart.map((l) => {
    const q = Number(l.qty);
    const price = l.price.trim() === '' ? l.listPrice : parseMoney(l.price);
    const discount = l.discount.trim() === '' ? 0 : parseMoney(l.discount);
    const qtyOk = Number.isFinite(q) && q > 0;
    const problem =
      price === null
        ? l.price.trim() === ''
          ? 'No price set'
          : 'Not a valid price'
        : !qtyOk
          ? 'Quantity must be above zero'
          : discount === null
            ? 'Not a valid discount'
            : lineCents({ qtyPacks: q, unitPrice: price, discount }).totalCents < 0
              ? 'Discount is more than the line'
              : null;
    return { q, price, discount: discount ?? 0, problem };
  });

  const cartOk = cart.length > 0 && parsed.every((p) => p.problem === null);
  const totals = basketCents(
    parsed.map((p) => ({ qtyPacks: p.problem === null ? p.q : 0, unitPrice: p.price ?? 0, discount: p.problem === null ? p.discount : 0 })),
  );
  const netCents = totals.netCents;

  const tender = settleRows(
    netCents,
    pay.map((p) => ({ isCash: typeById.get(p.typeId)?.isCash ?? false, received: parseMoney(p.received) })),
  );
  const badReceived = pay.some((p) => p.received.trim() !== '' && parseMoney(p.received) === null);
  const needsTill = (tills.data ?? []).length > 0 && tillId === '';
  const canComplete = cartOk && netCents > 0 && tender.problem === null && !badReceived && !needsTill && !busy;

  function reset() {
    setCart([]);
    setSaleId(newKey());
    setPay([]);
    setBlocked(null);
    setError(null);
    setNotFound(null);
    setLoggedScan(false);
    setQuickAdding(null);
    setCode('');
    setSearch('');
  }

  function addToCart(item: Omit<CartLine, 'qty' | 'price' | 'discount'>) {
    setError(null);
    setBlocked(null);
    setCart((lines) => {
      const at = lines.findIndex((l) => l.packId === item.packId);
      if (at >= 0) {
        return lines.map((l, i) => (i === at ? { ...l, qty: String(Number(l.qty || '0') + 1) } : l));
      }
      return [...lines, { ...item, qty: '1', price: '', discount: '' }];
    });
  }

  function patchLine(packId: string, patch: Partial<CartLine>) {
    setBlocked(null);
    setCart((lines) => lines.map((l) => (l.packId === packId ? { ...l, ...patch } : l)));
  }

  async function lookUp() {
    const trimmed = code.trim();
    if (trimmed === '') return;
    setNotFound(null);
    setLoggedScan(false);
    setError(null);
    try {
      const r = await api.resolveBarcode(trimmed);
      addToCart({
        packId: r.packId,
        productId: r.productId,
        name: r.productName,
        sku: r.sku,
        packLabel: r.packLabel,
        listPrice: r.sellPrice,
        pending: false,
      });
      setCode('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(trimmed);
      else setError(e instanceof ApiError ? e.message : String(e));
    }
    inputRef.current?.focus();
  }

  function pickPack(p: Product, packId: string) {
    const pack = p.packs.find((pk) => pk.id === packId);
    if (pack === undefined) return;
    addToCart({
      packId: pack.id,
      productId: p.id,
      name: p.name,
      sku: p.sku,
      packLabel: pack.label,
      listPrice: pack.sellPrice,
      pending: p.reviewState === 'pending',
    });
    setSearch('');
    inputRef.current?.focus();
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

  async function quickAdd(name: string, barcode: string | null, price: number) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.quickAddProduct({
        name: name.trim(),
        sellPrice: price,
        ...(barcode !== null ? { barcode } : {}),
        branchId,
      });
      addToCart({
        packId: r.packId,
        productId: r.id,
        name: r.name,
        sku: r.sku,
        packLabel: 'single',
        listPrice: price,
        pending: true,
      });
      setNotFound(null);
      setQuickAdding(null);
      setCode('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setListPrice(line: CartLine, text: string) {
    const price = parseMoney(text);
    if (price === null) {
      setError('Enter a price like 2.50.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updatePack(line.productId, line.packId, { sellPrice: price });
      patchLine(line.packId, { listPrice: price });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function complete(overrideNegative: boolean) {
    if (!canComplete) return;
    setBusy(true);
    setError(null);
    try {
      const till = (tills.data ?? []).find((t) => t.id === tillId);
      const result = await api.checkout({
        saleId,
        branchId,
        cashPointId: tillId === '' ? null : tillId,
        terminalId: till?.terminalId ?? null,
        lines: cart.map((l, i) => {
          const p = parsed[i]!;
          const changedPrice = p.price !== null && p.price !== l.listPrice;
          return {
            productId: l.productId,
            packId: l.packId,
            qtyPacks: p.q,
            ...(changedPrice ? { unitPrice: p.price! } : {}),
            ...(p.discount > 0 ? { discount: p.discount } : {}),
          };
        }),
        payments: pay.map((p, i) => {
          const r = tender.rows[i]!;
          const isCash = typeById.get(p.typeId)?.isCash ?? false;
          return {
            paymentTypeId: p.typeId,
            amount: fromCents(r.appliedCents),
            ...(isCash && r.receivedCents > r.appliedCents ? { tendered: fromCents(r.receivedCents) } : {}),
            ...(!isCash && p.reference.trim() !== '' ? { reference: p.reference.trim() } : {}),
          };
        }),
        overrideNegative,
      });
      // The till is free for the next customer the moment the sale is on the books.
      reset();
      setReceipt({ data: result.receipt, fresh: true });
      setRecent((r) => [
        { id: result.receipt.id, receiptNo: result.receipt.receiptNo, net: result.receipt.net, items: result.receipt.lines.length },
        ...r,
      ].slice(0, 8));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NEGATIVE_STOCK_BLOCKED') {
        setBlocked({
          productName: String(e.detail['productName'] ?? 'An item'),
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

  async function reprint(id: string) {
    try {
      setReceipt({ data: await api.receipt(id), fresh: false });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const items = results.data?.items ?? [];
  const changeDue = tender.changeCents;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Sell</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Scan or search to build the basket, take payment, print the receipt.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Branch</span>
            <select
              value={branchId}
              disabled={cart.length > 0}
              onChange={(e) => {
                setBranchId(e.target.value);
                store.set('sell.branch', e.target.value);
              }}
              className="border-ink-200 focus:border-accent-500 min-w-40 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none disabled:opacity-60"
            >
              <option value="">Select a branch…</option>
              {(branches.data ?? []).map((b: Branch) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {(tills.data ?? []).length > 0 && (
            <label className="block">
              <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Till</span>
              <select
                value={tillId}
                disabled={cart.length > 0}
                onChange={(e) => {
                  setTillId(e.target.value);
                  store.set(`sell.till.${branchId}`, e.target.value);
                }}
                className="border-ink-200 focus:border-accent-500 min-w-32 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none disabled:opacity-60"
              >
                <option value="">Select a till…</option>
                {(tills.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {branchId === '' ? (
        <Card className="px-4 py-6">
          <p className="text-ink-400 text-[12.5px]">Choose a branch to start selling.</p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <Card className="px-4 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Scan or type a barcode
                  </span>
                  <div className="flex gap-2">
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
                      aria-label="Barcode"
                      className="border-ink-200 focus:border-accent-500 min-w-0 flex-1 rounded-lg border bg-white px-3 py-2 font-mono text-[14px] outline-none"
                    />
                    <Button onClick={() => void lookUp()} disabled={code.trim() === ''}>
                      Add
                    </Button>
                  </div>
                </div>
                <div className="relative">
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Or search by name
                  </span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Start typing a product name or SKU…"
                    aria-label="Search products"
                    className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
                  />
                </div>
              </div>

              {search.trim() !== '' && (
                <div className="border-ink-100 mt-2 max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {results.loading ? (
                    <div className="grid place-items-center py-4">
                      <Spinner />
                    </div>
                  ) : items.length === 0 ? (
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
                    items.flatMap((p) =>
                      p.packs.map((pk) => (
                        <button
                          key={pk.id}
                          onClick={() => pickPack(p, pk.id)}
                          className="hover:bg-ink-50 flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12.5px]"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {p.name}
                            {p.packs.length > 1 && <span className="text-ink-400"> · {pk.label}</span>}
                          </span>
                          <span className="text-ink-400 shrink-0 font-mono text-[11px]">{p.sku}</span>
                          <span className="tnum w-16 shrink-0 text-right font-medium">
                            {pk.sellPrice === null ? <span className="text-amber-700">no price</span> : money(pk.sellPrice)}
                          </span>
                        </button>
                      )),
                    )
                  )}
                </div>
              )}

              {notFound !== null && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-amber-900">“{notFound}” is not in the item master.</div>
                  <p className="mt-0.5 text-amber-800/80">
                    Log it so a controller can act on it, or add it as a new item and keep selling.
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
                      <Button variant="secondary" onClick={() => setQuickAdding({ name: '', barcode: notFound })}>
                        Add as a new item
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {quickAdding !== null && (
                <QuickAddPanel
                  initialName={quickAdding.name}
                  barcode={quickAdding.barcode}
                  busy={busy}
                  onCancel={() => setQuickAdding(null)}
                  onSubmit={(name, price) => void quickAdd(name, quickAdding.barcode, price)}
                />
              )}
            </Card>

            <Card className="overflow-hidden">
              <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight">
                  Basket{' '}
                  <span className="text-ink-400 font-normal">
                    ({cart.length} {cart.length === 1 ? 'item' : 'items'})
                  </span>
                </h2>
                {cart.length > 0 && (
                  <button onClick={reset} className="text-ink-400 hover:text-ink-700 text-[12px]">
                    Clear basket
                  </button>
                )}
              </div>

              {cart.length === 0 ? (
                <p className="text-ink-400 px-4 py-8 text-center text-[12.5px]">
                  The basket is empty. Scan an item or search for one above.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                        <th className="px-4 py-2 font-medium">Item</th>
                        <th className="px-2 py-2 font-medium">Qty</th>
                        <th className="px-2 py-2 text-right font-medium">Price</th>
                        {mayOverridePrice && <th className="px-2 py-2 text-right font-medium">Discount</th>}
                        <th className="px-2 py-2 text-right font-medium">Total</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-ink-100 divide-y">
                      {cart.map((l, i) => {
                        const p = parsed[i]!;
                        const total = p.problem === null ? lineCents({ qtyPacks: p.q, unitPrice: p.price ?? 0, discount: p.discount }).totalCents : null;
                        return (
                          <tr key={l.packId} className="align-top" data-testid="cart-line">
                            <td className="px-4 py-2">
                              <div className="font-medium">{l.name}</div>
                              <div className="text-ink-400 text-[11px]">
                                {l.sku} · {l.packLabel}
                                {l.pending && <> · <Badge tone="warn">pending review</Badge></>}
                              </div>
                              {l.listPrice === null && l.price.trim() === '' && (
                                <UnpricedFix
                                  canSet={mayPrice}
                                  canOverride={mayOverridePrice}
                                  busy={busy}
                                  onSave={(text) => void setListPrice(l, text)}
                                />
                              )}
                              {p.problem !== null && l.listPrice !== null && (
                                <div className="mt-0.5 text-[11px] text-red-700">{p.problem}</div>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={l.qty}
                                aria-label={`Quantity of ${l.name}`}
                                onChange={(e) => patchLine(l.packId, { qty: e.target.value })}
                                className="tnum border-ink-200 focus:border-accent-500 w-20 rounded-lg border bg-white px-2 py-1.5 text-[13px] outline-none"
                              />
                            </td>
                            <td className="px-2 py-2 text-right">
                              {mayOverridePrice ? (
                                <input
                                  inputMode="decimal"
                                  value={l.price}
                                  placeholder={l.listPrice === null ? '' : l.listPrice.toFixed(2)}
                                  aria-label={`Price of ${l.name}`}
                                  onChange={(e) => patchLine(l.packId, { price: e.target.value })}
                                  className="tnum border-ink-200 focus:border-accent-500 w-20 rounded-lg border bg-white px-2 py-1.5 text-right text-[13px] outline-none"
                                />
                              ) : (
                                <span className="tnum">{money(l.listPrice)}</span>
                              )}
                            </td>
                            {mayOverridePrice && (
                              <td className="px-2 py-2 text-right">
                                <input
                                  inputMode="decimal"
                                  value={l.discount}
                                  placeholder="0.00"
                                  aria-label={`Discount on ${l.name}`}
                                  onChange={(e) => patchLine(l.packId, { discount: e.target.value })}
                                  className="tnum border-ink-200 focus:border-accent-500 w-20 rounded-lg border bg-white px-2 py-1.5 text-right text-[13px] outline-none"
                                />
                              </td>
                            )}
                            <td className="tnum px-2 py-2 text-right font-medium">
                              {total === null ? '—' : money(fromCents(total))}
                            </td>
                            <td className="pr-3 text-right">
                              <button
                                onClick={() => setCart((lines) => lines.filter((x) => x.packId !== l.packId))}
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
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="px-4 py-4">
              <dl className="space-y-1 text-[12.5px]">
                {totals.discountCents > 0 && (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-ink-500">Subtotal</dt>
                      <dd className="tnum">{money(fromCents(totals.grossCents))}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-500">Discount</dt>
                      <dd className="tnum">-{money(fromCents(totals.discountCents))}</dd>
                    </div>
                  </>
                )}
                <div className="flex items-baseline justify-between pt-1">
                  <dt className="text-ink-600 text-[11px] font-medium uppercase tracking-wider">Total to pay</dt>
                  <dd className="tnum text-3xl font-semibold tracking-tight" data-testid="total">
                    {money(fromCents(netCents))}
                  </dd>
                </div>
              </dl>

              <div className="border-ink-100 mt-4 border-t pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-ink-600 text-[11px] font-medium uppercase tracking-wider">Payment</span>
                  {pay.length < 4 && (
                    <button
                      className="text-accent-700 text-[12px] hover:underline"
                      onClick={() => {
                        const used = new Set(pay.map((p) => p.typeId));
                        const next = tillTypes.find((t) => !used.has(t.id) && !t.isCash) ?? tillTypes.find((t) => !used.has(t.id));
                        if (next !== undefined) {
                          setPay((rows) => [...rows, { key: newKey(), typeId: next.id, received: '', reference: '' }]);
                        }
                      }}
                    >
                      + Split payment
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {pay.map((row, i) => {
                    const type = typeById.get(row.typeId);
                    const r = tender.rows[i];
                    return (
                      <div key={row.key} className="space-y-1.5" data-testid="pay-row">
                        <div className="flex gap-2">
                          <select
                            value={row.typeId}
                            aria-label="Payment method"
                            onChange={(e) =>
                              setPay((rows) => rows.map((x) => (x.key === row.key ? { ...x, typeId: e.target.value } : x)))
                            }
                            className="border-ink-200 focus:border-accent-500 min-w-0 flex-1 rounded-lg border bg-white px-2 py-1.5 text-[12.5px] outline-none"
                          >
                            {tillTypes.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          <input
                            inputMode="decimal"
                            value={row.received}
                            placeholder={type?.isCash === true ? 'Amount given' : 'Amount'}
                            aria-label={type?.isCash === true ? 'Cash tendered' : 'Payment amount'}
                            onChange={(e) =>
                              setPay((rows) => rows.map((x) => (x.key === row.key ? { ...x, received: e.target.value } : x)))
                            }
                            className="tnum border-ink-200 focus:border-accent-500 w-28 rounded-lg border bg-white px-2 py-1.5 text-right text-[13px] outline-none"
                          />
                          {pay.length > 1 && (
                            <button
                              onClick={() => setPay((rows) => rows.filter((x) => x.key !== row.key))}
                              aria-label="Remove payment line"
                              className="text-ink-400 px-1 hover:text-red-600"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        {type !== undefined && !type.isCash && (
                          <input
                            value={row.reference}
                            placeholder="Reference (optional)"
                            aria-label="Payment reference"
                            onChange={(e) =>
                              setPay((rows) => rows.map((x) => (x.key === row.key ? { ...x, reference: e.target.value } : x)))
                            }
                            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2 py-1 text-[12px] outline-none"
                          />
                        )}
                        {type?.isCash === true && r !== undefined && r.receivedCents > r.appliedCents && (
                          <div className="text-ink-500 text-[11.5px]">Applied {money(fromCents(r.appliedCents))}</div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {netCents > 0 && (
                  <div className="mt-3 flex items-baseline justify-between text-[13px]">
                    {changeDue > 0 ? (
                      <>
                        <span className="text-ink-600 font-medium">Change to give</span>
                        <span className="tnum text-accent-700 text-xl font-semibold" data-testid="change">
                          {money(fromCents(changeDue))}
                        </span>
                      </>
                    ) : tender.remainingCents > 0 && pay.some((p) => p.received.trim() !== '') ? (
                      <>
                        <span className="text-ink-600 font-medium">Still owed</span>
                        <span className="tnum text-xl font-semibold text-amber-700">
                          {money(fromCents(tender.remainingCents))}
                        </span>
                      </>
                    ) : null}
                  </div>
                )}
              </div>

              {blocked !== null && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-red-800">
                    {blocked.productName}: {qty(blocked.available)} on hand, {qty(blocked.requested)} requested.
                  </div>
                  {can('stock.override') ? (
                    <>
                      <p className="mt-0.5 text-red-700/80">
                        You hold override authority. This will be logged as an open exception.
                      </p>
                      <Button variant="danger" onClick={() => void complete(true)} disabled={busy} className="mt-2">
                        Authorise and sell anyway
                      </Button>
                    </>
                  ) : (
                    <p className="mt-0.5 text-red-700/80">
                      Overriding this needs manager authorisation. Reduce the quantity, or ask a branch manager to
                      sign in and complete the sale.
                    </p>
                  )}
                </div>
              )}

              {error !== null && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
                  {error}
                </div>
              )}
              {needsTill && cart.length > 0 && (
                <p className="mt-3 text-[12px] text-amber-800">Choose which till is taking this sale.</p>
              )}
              {tender.problem !== null && netCents > 0 && pay.some((p) => p.received.trim() !== '') && (
                <p className="mt-3 text-[12px] text-amber-800">{tender.problem}</p>
              )}

              <Button
                variant="primary"
                className="mt-4 w-full py-2.5 text-[14px]"
                disabled={!canComplete}
                onClick={() => void complete(false)}
              >
                {busy ? <Spinner /> : null}
                Complete sale{netCents > 0 ? ` · ${money(fromCents(netCents))}` : ''}
              </Button>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-ink-100 border-b px-4 py-2.5">
                <h2 className="text-[13px] font-semibold tracking-tight">This session</h2>
              </div>
              {recent.length === 0 ? (
                <p className="text-ink-400 px-4 py-6 text-center text-[12px]">Nothing sold yet.</p>
              ) : (
                <ul className="divide-ink-100 divide-y">
                  {recent.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-mono">{r.receiptNo}</span>
                      <span className="text-ink-400">
                        {r.items} {r.items === 1 ? 'item' : 'items'}
                      </span>
                      <span className="tnum w-16 text-right font-medium">{money(r.net)}</span>
                      <button className="text-accent-700 hover:underline" onClick={() => void reprint(r.id)}>
                        Reprint
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {receipt !== null && (
        <ReceiptDialog
          receipt={receipt.data}
          closeLabel={receipt.fresh ? 'New sale' : 'Close'}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  );
}

/** An item with no price: someone who may price it can do it here; everyone else is told who to ask. */
function UnpricedFix({
  canSet,
  canOverride,
  busy,
  onSave,
}: {
  canSet: boolean;
  canOverride: boolean;
  busy: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="mt-1 text-[11.5px]">
      <span className="text-red-700">No selling price yet, so this cannot be sold.</span>
      {canSet ? (
        <span className="ml-2 inline-flex items-center gap-1.5">
          <input
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Set price"
            aria-label="Set selling price"
            className="tnum border-ink-200 focus:border-accent-500 w-20 rounded-lg border bg-white px-2 py-1 text-right outline-none"
          />
          <Button variant="secondary" disabled={busy || parseMoney(text) === null} onClick={() => onSave(text)}>
            Save price
          </Button>
        </span>
      ) : canOverride ? (
        <span className="text-ink-500"> Type a price in the Price column.</span>
      ) : (
        <span className="text-ink-500"> Ask a stock controller or manager to price it, or remove it.</span>
      )}
    </div>
  );
}

/**
 * Add-on-the-fly. Name and the price being charged - category, proper SKU and
 * the rest are for whoever reviews it afterwards, not a cashier mid-sale.
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
  onSubmit: (name: string, price: number) => void;
}) {
  const [name, setName] = useState(initialName);
  const [priceText, setPriceText] = useState('');
  const price = parseMoney(priceText);

  return (
    <div className="border-ink-200 mt-3 rounded-lg border border-dashed px-3.5 py-3">
      <div className="text-[12.5px] font-medium">Add a new item</div>
      <p className="text-ink-500 mt-0.5 text-[11.5px]">
        It goes into the basket now. It also lands with a branch manager to confirm the price and map it onto
        the right product and category.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block min-w-48 flex-1">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What is it called?"
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <label className="block w-28">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Price</span>
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            placeholder="0.00"
            aria-label="Price of the new item"
            className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-right text-[12.5px] outline-none"
          />
        </label>
        <Button
          variant="primary"
          onClick={() => price !== null && onSubmit(name, price)}
          disabled={busy || name.trim() === '' || price === null || price <= 0}
        >
          {busy ? <Spinner /> : null}
          Add to basket
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {barcode !== null && <p className="text-ink-400 mt-1.5 text-[11px]">Scanned code {barcode} will be attached to it.</p>}
    </div>
  );
}
