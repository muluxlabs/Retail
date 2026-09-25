/**
 * Goods received.
 *
 * Receiving is a document: a goods received note (GRN) that says which supplier
 * the goods came from, which order they were against (if any), what arrived and
 * what each pack cost. Posting it puts the stock on the books at that cost and
 * puts the amount on what is owed to the supplier - together, or not at all.
 *
 * Quantities are counted in the pack they arrive in (5 cases), and the server
 * converts to base units once, at the edge (AD-2). Cost is per PACK, because
 * that is how a supplier invoices; the ledger stores cost per base unit.
 *
 * Choosing an order fills in what is still outstanding at the price agreed, so
 * receiving a delivery against its order is a matter of checking the counts.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { newKey, parseLines, PurchaseLines, type PurchaseLine } from '../components/PurchaseLines.js';
import { api, ApiError, type OrderDetail } from '../lib/api.js';
import { parseCost, parseMoney, parseQty, fromCents } from '../lib/basketMath.js';
import { shortDate } from '../lib/buying.js';
import { Badge, Button, Card, Empty, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

/** What is still to come on an order, as delivery lines at the ordered price. */
function linesFromOrder(o: OrderDetail): PurchaseLine[] {
  return o.lines
    .filter((l) => l.outstandingPacks > 0)
    .map((l) => ({
      key: newKey(),
      productId: l.productId,
      packId: l.packId,
      name: l.name,
      sku: l.sku,
      packs: [{ id: l.packId, label: l.packLabel, qtyBase: l.qtyPacks > 0 ? l.qtyBase / l.qtyPacks : 1 }],
      qty: String(l.outstandingPacks),
      cost: String(l.unitCost),
      poLineId: l.id,
      orderedPacks: l.qtyPacks,
      orderedCost: l.unitCost,
      receivedPacks: l.receivedPacks,
    }));
}

export function Receive() {
  const [params] = useSearchParams();
  const branches = useAsync(() => api.branches(), []);
  const suppliers = useAsync(() => api.suppliers({}), []);

  const [branchId, setBranchId] = useState('');
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [poId, setPoId] = useState(params.get('poId') ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [invoiceTotal, setInvoiceTotal] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [grnId, setGrnId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; grnNo: string; totalCost: number; supplier: string } | null>(null);

  useEffect(() => {
    const list = branches.data ?? [];
    if (branchId === '' && list.length === 1 && list[0] !== undefined) setBranchId(list[0].id);
  }, [branches.data, branchId]);

  // An order named in the address (from its own page) sets the supplier and branch.
  const fromUrl = params.get('poId');
  const urlOrder = useAsync(() => (fromUrl === null ? Promise.resolve(undefined) : api.order(fromUrl)), [fromUrl]);
  useEffect(() => {
    const o = urlOrder.data;
    if (o !== undefined && poId === o.id && lines.length === 0) {
      setSupplierId(o.supplier.id);
      setBranchId(o.branch.id);
      setLines(linesFromOrder(o));
    }
  }, [urlOrder.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useAsync(
    () => (supplierId === '' || branchId === '' ? Promise.resolve(undefined) : api.orders({ supplierId, branchId, status: 'open', limit: 50 })),
    [supplierId, branchId, done],
  );
  const recent = useAsync(() => (branchId === '' ? Promise.resolve(undefined) : api.goodsReceived({ branchId, limit: 8 })), [branchId, done]);

  async function pickOrder(id: string) {
    setPoId(id);
    setError(null);
    if (id === '') {
      setLines((ls) => ls.filter((l) => l.poLineId === undefined || l.poLineId === null));
      return;
    }
    try {
      const o = await api.order(id);
      setLines(linesFromOrder(o));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const parsed = parseLines(lines);
  const invoiceCents = invoiceTotal.trim() === '' ? null : parseMoney(invoiceTotal);
  const variance = invoiceCents === null ? null : Math.round((invoiceCents - fromCents(parsed.totalCents)) * 100) / 100;
  const canPost = branchId !== '' && supplierId !== '' && parsed.ok && !busy && (invoiceTotal.trim() === '' || invoiceCents !== null);

  async function post() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.receiveGoods({
        id: grnId,
        branchId,
        supplierId,
        poId: poId === '' ? null : poId,
        supplierInvoiceNo: invoiceNo.trim() === '' ? null : invoiceNo.trim(),
        invoiceDate: invoiceDate === '' ? null : invoiceDate,
        invoiceTotal: invoiceCents,
        notes: notes.trim() === '' ? null : notes.trim(),
        lines: lines.map((l) => ({
          productId: l.productId,
          packId: l.packId,
          qtyPacks: parseQty(l.qty)!,
          unitCost: parseCost(l.cost)!,
          ...(l.poLineId === undefined || l.poLineId === null ? {} : { poLineId: l.poLineId }),
        })),
      });
      setDone({ id: r.id, grnNo: r.grnNo, totalCost: r.totalCost, supplier: (suppliers.data?.items ?? []).find((s) => s.id === supplierId)?.name ?? '' });
      // Ready for the next delivery: a new id, so it is a new note and not a replay of this one.
      setGrnId(crypto.randomUUID());
      setLines([]);
      setPoId('');
      setInvoiceNo('');
      setInvoiceDate('');
      setInvoiceTotal('');
      setNotes('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const openOrders = open.data?.items ?? [];
  const supplierOptions = useMemo(() => (suppliers.data?.items ?? []).filter((s) => s.isActive), [suppliers.data]);

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Goods received</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Record a delivery from a supplier: what arrived, in which pack, and what each pack cost. If it is against an order, choose the
          order and check the counts. Posting adds the stock and what is owed to the supplier.
        </p>
      </div>

      {done !== null && (
        <div className="rounded-lg border border-accent-300/60 bg-accent-50 px-4 py-3 text-[13px] text-accent-700" role="status" data-testid="grn-done">
          Goods received note <span className="font-mono font-semibold">{done.grnNo}</span> posted: {money(done.totalCost)} from {done.supplier}. The stock is on the books.{' '}
          <Link to={`/receive/${done.id}`} className="font-medium underline">
            View or print the note
          </Link>
        </div>
      )}

      <Card className="px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={label}>Branch receiving</span>
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setPoId(''); }} className={field} aria-label="Branch receiving">
              <option value="">Choose a branch…</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Supplier</span>
            <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(''); }} className={field} aria-label="Supplier">
              <option value="">Choose a supplier…</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>Against order (optional)</span>
            <select value={poId} onChange={(e) => void pickOrder(e.target.value)} disabled={supplierId === '' || branchId === ''} className={field} aria-label="Against order">
              <option value="">No order - goods that were not ordered through the system</option>
              {openOrders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.poNo} · {shortDate(o.orderedAt)} · {money(o.ordered)}
                  {o.status === 'part_received' ? ' · part received' : ''}
                </option>
              ))}
              {poId !== '' && !openOrders.some((o) => o.id === poId) && <option value={poId}>{urlOrder.data?.poNo ?? poId}</option>}
            </select>
          </label>
          <label className="block">
            <span className={label}>Supplier invoice no.</span>
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} aria-label="Supplier invoice number" className={field} />
          </label>
          <label className="block">
            <span className={label}>Invoice date</span>
            <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} aria-label="Invoice date" className={field} />
          </label>
          <label className="block">
            <span className={label}>Invoice total</span>
            <input inputMode="decimal" value={invoiceTotal} onChange={(e) => setInvoiceTotal(e.target.value)} placeholder="as printed" aria-label="Invoice total" className={`${field} tnum text-right`} />
          </label>
          <label className="block">
            <span className={label}>Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" className={field} />
          </label>
        </div>
      </Card>

      <Card className="px-4 py-4">
        <PurchaseLines lines={lines} onChange={setLines} showOrdered={poId !== ''} />
        {variance !== null && Math.abs(variance) >= 0.005 && parsed.ok && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900" data-testid="invoice-variance">
            The invoice total is {money(invoiceCents)}, but the goods add up to {money(fromCents(parsed.totalCents))} - a difference of {money(Math.abs(variance))}. What is owed
            follows the goods received; take the difference up with the supplier.
          </p>
        )}
      </Card>

      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void post()} disabled={!canPost}>
          {busy ? <Spinner /> : null}
          Post goods received{parsed.totalCents > 0 ? ` · ${money(fromCents(parsed.totalCents))}` : ''}
        </Button>
      </div>

      {branchId !== '' && (
        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Recently received at this branch</h2>
          </div>
          {(recent.data?.items ?? []).length === 0 ? (
            <Empty title="Nothing received here yet" />
          ) : (
            <ul className="divide-ink-100 divide-y" data-testid="recent-grns">
              {(recent.data?.items ?? []).map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px]">
                  <Link to={`/receive/${g.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                    {g.grnNo}
                  </Link>
                  <span className="text-ink-500">{shortDate(g.receivedAt)}</span>
                  <span>{g.supplierName}</span>
                  {g.poNo !== null && <Badge tone="info">{g.poNo}</Badge>}
                  {g.invoiceNo !== null && <span className="text-ink-500">invoice {g.invoiceNo}</span>}
                  <span className="text-ink-400">{g.receivedByName}</span>
                  <span className="tnum ml-auto font-medium">{money(g.totalCost)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
