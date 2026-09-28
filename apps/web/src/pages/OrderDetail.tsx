/**
 * One purchase order: what was asked for, what has arrived, what is still to
 * come, and whether it has been paid - prepaid, paid on delivery, or paid after.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { PaymentDetailDialog, RecordPaymentDialog } from '../components/PaymentDialogs.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { packCost, PO_PAYMENT, PO_STATUS, shortDate, shortDateTime, termsText, TIMING } from '../lib/buying.js';
import { Badge, Button, Card, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

export function OrderDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const order = useAsync(() => api.order(id), [id]);
  const [paying, setPaying] = useState(false);
  const [openPayment, setOpenPayment] = useState<string | null>(null);
  const [ending, setEnding] = useState<'cancel' | 'close' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (order.error !== undefined) return <ErrorNote error={order.error} />;
  const o = order.data;
  if (o === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }

  const open = o.status === 'ordered' || o.status === 'part_received' || o.status === 'received';
  const stillOpen = o.status === 'ordered' || o.status === 'part_received';
  const outstandingValue = o.lines.reduce((t, l) => t + l.outstandingPacks * l.unitCost, 0);

  async function end() {
    if (ending === null) return;
    setBusy(true);
    setError(null);
    try {
      if (ending === 'cancel') await api.cancelOrder(id, reason.trim());
      else await api.closeOrder(id, reason.trim());
      setEnding(null);
      setReason('');
      order.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/orders" className="hover:text-ink-700 hover:underline">
          Orders
        </Link>{' '}
        / {o.poNo}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Purchase order <span className="font-mono" data-testid="po-no">{o.poNo}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px]">
            <Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge>
            {o.paymentStatus !== null && <Badge tone={PO_PAYMENT[o.paymentStatus].tone}>{PO_PAYMENT[o.paymentStatus].label}</Badge>}
            <span className="text-ink-500">
              <Link to={`/suppliers/${o.supplier.id}`} className="hover:text-accent-700 font-medium hover:underline">
                {o.supplier.name}
              </Link>{' '}
              · for {o.branch.name} · ordered {shortDate(o.orderedAt)} by {o.orderedByName}
              {o.expectedDate !== null && ` · expected ${shortDate(o.expectedDate)}`}
            </span>
          </div>
          <p className="text-ink-400 mt-0.5 text-[12px]">Terms: {termsText(o.terms, o.creditDays)}</p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {can('grn.post') && (o.status === 'ordered' || o.status === 'part_received') && (
            <Link to={`/receive?poId=${o.id}`} className="bg-accent-600 hover:bg-accent-700 inline-flex items-center rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm">
              Receive goods
            </Link>
          )}
          {can('supplier.pay') && !o.financeHidden && open && (
            <Button onClick={() => setPaying(true)}>Record payment</Button>
          )}
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      {o.cancelled !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-[12.5px] text-red-800">Cancelled {shortDateTime(o.cancelled.at)}: {o.cancelled.reason}</div>}
      {o.closed !== null && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900">Closed short {shortDateTime(o.closed.at)}: {o.closed.note}. The supplier is not expected to send the rest.</div>}
      {o.notes !== null && <p className="text-ink-500 text-[12.5px]">{o.notes}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Ordered</div>
          <div className="tnum mt-1 text-xl font-semibold" data-testid="ordered-total">{money(o.ordered)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Received</div>
          <div className="tnum mt-1 text-xl font-semibold" data-testid="received-total">{money(o.received)}</div>
          {stillOpen && <div className="text-ink-400 text-xs">{money(outstandingValue)} still to come</div>}
        </Card>
        {!o.financeHidden && (
          <>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Paid</div>
              <div className="tnum mt-1 text-xl font-semibold" data-testid="paid-total">{money(o.paid ?? 0)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Still to pay</div>
              <div className="tnum mt-1 text-xl font-semibold">
                {money(Math.max(0, (o.received > 0 ? o.received : o.ordered) - (o.paid ?? 0)))}
              </div>
              <div className="text-ink-400 text-xs">{o.received > 0 ? 'of what has been received' : 'of what was ordered'}</div>
            </Card>
          </>
        )}
      </div>

      <Card className="overflow-hidden">
        <div className="border-ink-100 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Items</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="order-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Pack</th>
                <th className="px-2 py-2 text-right font-medium">Ordered</th>
                <th className="px-2 py-2 text-right font-medium">Received</th>
                <th className="px-2 py-2 text-right font-medium">Still to come</th>
                <th className="px-2 py-2 text-right font-medium">Price per pack</th>
                <th className="px-4 py-2 text-right font-medium">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {o.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                  </td>
                  <td className="px-2 py-1.5">{l.packLabel}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyPacks)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.receivedPacks)}</td>
                  <td className={`tnum px-2 py-1.5 text-right ${l.outstandingPacks > 0 && (o.status === 'closed' || o.status === 'cancelled') ? 'text-ink-400' : l.outstandingPacks > 0 ? 'font-medium text-amber-700' : 'text-ink-400'}`}>
                    {l.outstandingPacks > 0 ? qty(l.outstandingPacks) : l.receivedPacks > l.qtyPacks ? `+${qty(l.receivedPacks - l.qtyPacks)} extra` : '—'}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right">{packCost(l.unitCost)}</td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t font-semibold">
                <td colSpan={6} className="px-4 py-2 text-right">
                  Order total
                </td>
                <td className="tnum px-4 py-2 text-right">{money(o.ordered)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Deliveries against this order</h2>
          </div>
          {o.receipts.length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12.5px]">Nothing has arrived yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {o.receipts.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px]">
                  <Link to={`/receive/${g.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                    {g.grnNo}
                  </Link>
                  <span className="text-ink-500">{shortDate(g.receivedAt)}</span>
                  {g.invoiceNo !== null && <span className="text-ink-500">invoice {g.invoiceNo}</span>}
                  <span className="text-ink-400">{g.receivedByName}</span>
                  <span className="tnum ml-auto font-medium">{money(g.totalCost)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {!o.financeHidden && (
          <Card className="overflow-hidden">
            <div className="border-ink-100 border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-tight">Payments for this order</h2>
            </div>
            {o.payments.length === 0 ? (
              <p className="text-ink-400 px-4 py-6 text-center text-[12.5px]">Nothing has been paid against this order.</p>
            ) : (
              <ul className="divide-ink-100 divide-y" data-testid="order-payments">
                {o.payments.map((p) => (
                  <li key={p.id} className={`hover:bg-ink-50/60 flex cursor-pointer flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px] ${p.voidedAt !== null ? 'text-ink-400 line-through' : ''}`} onClick={() => setOpenPayment(p.id)}>
                    <span className="font-mono font-medium">{p.paymentNo}</span>
                    <span className="text-ink-500">{shortDate(p.paidAt)}</span>
                    <span className="text-ink-500">
                      {p.method}
                      {p.reference !== null && ` · ${p.reference}`}
                    </span>
                    <Badge tone={TIMING[p.timing].tone}>{TIMING[p.timing].label}</Badge>
                    <span className="tnum ml-auto font-medium">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {can('po.write') && (o.status === 'ordered' || o.status === 'part_received') && (
        <Card className="no-print px-4 py-3">
          {ending === null ? (
            <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
              {o.status === 'ordered' && (
                <button onClick={() => setEnding('cancel')} className="text-red-700 hover:underline">
                  Cancel this order…
                </button>
              )}
              {o.status === 'part_received' && (
                <button onClick={() => setEnding('close')} className="text-amber-800 hover:underline">
                  Close this order - the supplier cannot send the rest…
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block">
                <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">{ending === 'cancel' ? 'Why is it being cancelled?' : 'Why is the rest not coming?'}</span>
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" className="border-ink-200 focus:border-accent-500 w-full max-w-lg rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none" />
              </label>
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => void end()} disabled={busy || reason.trim().length < 5}>
                  {ending === 'cancel' ? 'Cancel the order' : 'Close the order'}
                </Button>
                <Button variant="ghost" onClick={() => setEnding(null)}>
                  Keep it open
                </Button>
              </div>
            </div>
          )}
          {error !== null && <div className="mt-2 text-[12.5px] text-red-700">{error}</div>}
        </Card>
      )}

      {paying && (
        <RecordPaymentDialog
          supplierId={o.supplier.id}
          poId={o.id}
          defaultAmount={Math.max(0, (o.received > 0 ? o.received : o.ordered) - (o.paid ?? 0))}
          onClose={() => setPaying(false)}
          onDone={(pid) => {
            setPaying(false);
            order.reload();
            setOpenPayment(pid);
          }}
        />
      )}
      {openPayment !== null && <PaymentDetailDialog id={openPayment} onClose={() => setOpenPayment(null)} onChanged={order.reload} />}
    </div>
  );
}
