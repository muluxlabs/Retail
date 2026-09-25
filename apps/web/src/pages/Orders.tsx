/**
 * Purchase orders: the requests for supplies sent to suppliers, and where each
 * stands - waiting, part delivered, delivered, and whether it has been paid.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { parseLines, PurchaseLines, type PurchaseLine } from '../components/PurchaseLines.js';
import { api, ApiError, type SupplierTerms } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { PO_PAYMENT, PO_STATUS, shortDate, TERMS_HELP, TERMS_LABEL, termsText } from '../lib/buying.js';
import { parseCost, parseQty } from '../lib/basketMath.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function Orders() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const suppliers = useAsync(() => api.suppliers({ includeInactive: true }), []);
  const branches = useAsync(() => api.branches(), []);
  const list = useAsync(
    () =>
      api.orders({
        ...(supplierId === '' ? {} : { supplierId }),
        ...(branchId === '' ? {} : { branchId }),
        ...(status === '' ? {} : { status }),
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        limit: 100,
      }),
    [supplierId, branchId, status, q],
  );
  const items = list.data?.items ?? [];
  const hidden = list.data?.financeHidden ?? false;

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Purchase orders</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Requests for supplies. An order is placed with a supplier for a branch; when the goods arrive they are received against
            it, and it shows what is still to come.
          </p>
        </div>
        {can('po.write') && (
          <Link to="/orders/new" className="bg-accent-600 hover:bg-accent-700 inline-flex items-center rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm">
            New order
          </Link>
        )}
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>Show</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={field} aria-label="Status">
              <option value="open">Awaiting delivery</option>
              <option value="">All orders</option>
              <option value="ordered">Ordered, nothing yet</option>
              <option value="part_received">Part received</option>
              <option value="received">Received in full</option>
              <option value="closed">Closed short</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="block">
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
          <label className="block">
            <span className={label}>Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field} aria-label="Branch">
              <option value="">All branches</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Order number</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. HRE-PO-000012" aria-label="Order number" className={`${field} w-44 font-mono`} />
          </label>
        </div>
      </Card>

      {list.error !== undefined && <ErrorNote error={list.error} />}

      <Card className="overflow-hidden">
        {list.loading && list.data === undefined ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No orders match" hint={can('po.write') ? 'Place an order with New order.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="orders">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Order</th>
                  <th className="px-2 py-2 font-medium">Supplier</th>
                  <th className="px-2 py-2 font-medium">For branch</th>
                  <th className="px-2 py-2 font-medium">Expected</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 text-right font-medium">Ordered</th>
                  <th className="px-2 py-2 text-right font-medium">Received</th>
                  {!hidden && <th className="px-4 py-2 font-medium">Payment</th>}
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-ink-50/60" data-testid="order-row">
                    <td className="px-4 py-2">
                      <Link to={`/orders/${o.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                        {o.poNo}
                      </Link>
                      <div className="text-ink-400 text-[11px]">{shortDate(o.orderedAt)} · {o.orderedByName}</div>
                    </td>
                    <td className="px-2 py-2">
                      <Link to={`/suppliers/${o.supplier.id}`} className="hover:text-accent-700 hover:underline">
                        {o.supplier.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{o.branch.name}</td>
                    <td className="text-ink-600 px-2 py-2 whitespace-nowrap">{shortDate(o.expectedDate)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge>
                    </td>
                    <td className="tnum px-2 py-2 text-right">{money(o.ordered)}</td>
                    <td className="tnum px-2 py-2 text-right">{money(o.received)}</td>
                    {!hidden && (
                      <td className="px-4 py-2">
                        {o.paymentStatus !== null && <Badge tone={PO_PAYMENT[o.paymentStatus].tone}>{PO_PAYMENT[o.paymentStatus].label}</Badge>}
                        {o.paid !== null && o.paid > 0 && <span className="text-ink-400 ml-1.5 text-[11px]">{money(o.paid)}</span>}
                      </td>
                    )}
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

export function NewOrder() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const suppliers = useAsync(() => api.suppliers({}), []);
  const branches = useAsync(() => api.branches(), []);
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [branchId, setBranchId] = useState('');
  const [expected, setExpected] = useState('');
  const [terms, setTerms] = useState<SupplierTerms>('credit');
  const [days, setDays] = useState('30');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supplier = (suppliers.data?.items ?? []).find((s) => s.id === supplierId);
  // Terms follow the supplier until someone changes them for this order.
  useEffect(() => {
    if (supplier !== undefined) {
      setTerms(supplier.terms);
      setDays(String(supplier.creditDays ?? 30));
    }
  }, [supplier?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const list = branches.data ?? [];
    if (branchId === '' && list.length === 1 && list[0] !== undefined) setBranchId(list[0].id);
  }, [branches.data, branchId]);

  const parsed = parseLines(lines);
  const canSubmit = supplierId !== '' && branchId !== '' && parsed.ok && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createOrder({
        supplierId,
        branchId,
        expectedDate: expected === '' ? null : expected,
        terms,
        ...(terms === 'credit' ? { creditDays: Number(days) || 0 } : {}),
        notes: notes.trim() === '' ? null : notes.trim(),
        lines: lines.map((l) => ({ productId: l.productId, packId: l.packId, qtyPacks: parseQty(l.qty)!, unitCost: parseCost(l.cost)! })),
      });
      nav(`/orders/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 text-[12px]">
        <Link to="/orders" className="hover:text-ink-700 hover:underline">
          Orders
        </Link>{' '}
        / New order
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">New purchase order</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">Choose the supplier and the branch the goods are for, then list what you are asking for and the price agreed per pack.</p>
      </div>

      <Card className="px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={label}>Supplier</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={`${field} w-full`} aria-label="Supplier">
              <option value="">Choose a supplier…</option>
              {(suppliers.data?.items ?? []).filter((s) => s.isActive).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Deliver to</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={`${field} w-full`} aria-label="Deliver to branch">
              <option value="">Choose a branch…</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Expected on</span>
            <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={`${field} w-full`} aria-label="Expected date" />
          </label>
          <label className="block">
            <span className={label}>Payment terms</span>
            <select value={terms} onChange={(e) => setTerms(e.target.value as SupplierTerms)} className={`${field} w-full`} aria-label="Payment terms">
              {(Object.keys(TERMS_LABEL) as SupplierTerms[]).map((t) => (
                <option key={t} value={t}>
                  {TERMS_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          {terms === 'credit' && (
            <label className="block">
              <span className={label}>Days to pay</span>
              <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className={`${field} tnum w-full`} aria-label="Days of credit" />
            </label>
          )}
          <label className="block sm:col-span-2">
            <span className={label}>Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${field} w-full`} aria-label="Notes" />
          </label>
        </div>
        {supplier !== undefined && (
          <p className="text-ink-400 mt-2 text-[11.5px]">
            {supplier.name} is normally paid: {termsText(supplier.terms, supplier.creditDays).toLowerCase()} - {TERMS_HELP[supplier.terms].toLowerCase()}.
          </p>
        )}
      </Card>

      <Card className="px-4 py-4">
        <PurchaseLines lines={lines} onChange={setLines} />
      </Card>

      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? <Spinner /> : null}
          Place order
        </Button>
        <Link to="/orders" className="text-ink-500 hover:text-ink-800 hover:bg-ink-100 inline-flex items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium">
          Cancel
        </Link>
      </div>
    </div>
  );
}
