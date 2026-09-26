/**
 * One supplier: their details, the account with them, and every order,
 * delivery and payment behind it.
 *
 * The account is a statement in the usual accounting form - goods received add
 * to what is owed, payments take it down, and the balance runs down the page -
 * with the same figures aged by how overdue they are. A supplier statement
 * can be printed to send to (or reconcile with) the supplier.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { PaymentDetailDialog, RecordPaymentDialog } from '../components/PaymentDialogs.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { downloadCsv } from '../lib/csv.js';
import { balanceWords, PO_PAYMENT, PO_STATUS, shortDate, shortDateTime, termsText, TIMING } from '../lib/buying.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';
import { SupplierForm } from './Suppliers.js';

export function SupplierDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const detail = useAsync(() => api.supplier(id), [id]);
  const orders = useAsync(() => api.orders({ supplierId: id, limit: 100 }), [id]);
  const receipts = useAsync(() => api.goodsReceived({ supplierId: id, limit: 100 }), [id]);
  const payments = useAsync(() => (detail.data?.financeHidden === false ? api.supplierPayments({ supplierId: id, includeVoided: true, limit: 100 }) : Promise.resolve(undefined)), [id, detail.data?.financeHidden]);

  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [openPayment, setOpenPayment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (detail.error !== undefined) return <ErrorNote error={detail.error} />;
  if (detail.data === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }

  const { supplier: s, account, financeHidden } = detail.data;
  const reloadAll = () => {
    detail.reload();
    orders.reload();
    receipts.reload();
    payments.reload();
  };

  async function setActive(active: boolean) {
    setError(null);
    try {
      await api.updateSupplier(id, { isActive: active });
      detail.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const overdue = account === null ? 0 : account.ageing.buckets.d1_30 + account.ageing.buckets.d31_60 + account.ageing.buckets.d61_90 + account.ageing.buckets.over90;

  function exportStatement() {
    if (account === null) return;
    downloadCsv(
      `statement-${s.code}.csv`,
      ['Date', 'Reference', 'Description', 'Goods received (debit)', 'Payments (credit)', 'Balance'],
      account.statement.map((e) => [e.at.slice(0, 10), e.ref, e.description, e.debit, e.credit, e.balance]),
    );
  }

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 text-[12px] no-print">
        <Link to="/suppliers" className="hover:text-ink-700 hover:underline">
          Suppliers
        </Link>{' '}
        / {s.name}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight" data-testid="supplier-name">
            {s.name}
            {!s.isActive && (
              <span className="ml-2 align-middle">
                <Badge tone="neutral">inactive</Badge>
              </span>
            )}
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            <span className="font-mono">{s.code}</span> · {termsText(s.terms, s.creditDays)}
            {s.contactPerson !== null && ` · ${s.contactPerson}`}
            {s.phone !== null && ` · ${s.phone}`}
            {s.email !== null && ` · ${s.email}`}
          </p>
          {(s.address !== null || s.tin !== null) && (
            <p className="text-ink-400 text-[12px]">
              {s.address}
              {s.address !== null && s.tin !== null && ' · '}
              {s.tin !== null && `TIN ${s.tin}`}
            </p>
          )}
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {can('po.write') && s.isActive && (
            <Link to={`/orders/new?supplierId=${s.id}`} className="bg-white text-ink-700 ring-ink-200 hover:bg-ink-50 inline-flex items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset">
              New order
            </Link>
          )}
          {can('grn.post') && s.isActive && (
            <Link to={`/receive?supplierId=${s.id}`} className="bg-white text-ink-700 ring-ink-200 hover:bg-ink-50 inline-flex items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset">
              Receive goods
            </Link>
          )}
          {can('supplier.pay') && !financeHidden && (
            <Button variant="primary" onClick={() => setPaying(true)}>
              Record payment
            </Button>
          )}
          {can('supplier.write') && <Button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit details'}</Button>}
        </div>
      </div>

      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}

      {editing && (
        <SupplierForm
          supplierId={s.id}
          initial={{ name: s.name, contactPerson: s.contactPerson, phone: s.phone, email: s.email, address: s.address, tin: s.tin, terms: s.terms, creditDays: s.creditDays, notes: s.notes }}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            detail.reload();
          }}
        />
      )}
      {editing && can('supplier.write') && (
        <div>
          {s.isActive ? (
            <button onClick={() => void setActive(false)} className="text-[12.5px] text-red-700 hover:underline">
              Make this supplier inactive
            </button>
          ) : (
            <button onClick={() => void setActive(true)} className="text-accent-700 text-[12.5px] hover:underline">
              Make this supplier active again
            </button>
          )}
        </div>
      )}
      {s.notes !== null && !editing && <p className="text-ink-500 text-[12.5px]">{s.notes}</p>}

      {account !== null && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="account-kpis">
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">{account.balance < -0.004 ? 'Prepaid with supplier' : 'Owed to supplier'}</div>
              <div className="tnum mt-1 text-2xl font-semibold" data-testid="balance">{money(Math.abs(account.balance))}</div>
              <div className="text-ink-400 text-xs">{balanceWords(account.balance)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Overdue</div>
              <div className={`tnum mt-1 text-2xl font-semibold ${overdue > 0 ? 'text-red-700' : ''}`} data-testid="overdue">{money(overdue)}</div>
              <div className="text-ink-400 text-xs">past the payment terms</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Goods received</div>
              <div className="tnum mt-1 text-2xl font-semibold">{money(account.receivedCost)}</div>
              <div className="text-ink-400 text-xs">at cost, all time</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Paid</div>
              <div className="tnum mt-1 text-2xl font-semibold">{money(account.paid)}</div>
              <div className="text-ink-400 text-xs">payments not voided</div>
            </Card>
          </div>

          {account.ageing.total > 0 && (
            <Card className="px-4 py-3" data-testid="ageing">
              <div className="mb-2 text-[13px] font-semibold tracking-tight">How overdue it is</div>
              <div className="grid grid-cols-2 gap-3 text-[12.5px] sm:grid-cols-5">
                {(
                  [
                    ['notDue', 'Not yet due'],
                    ['d1_30', '1-30 days late'],
                    ['d31_60', '31-60 days late'],
                    ['d61_90', '61-90 days late'],
                    ['over90', 'Over 90 days late'],
                  ] as const
                ).map(([k, l]) => (
                  <div key={k}>
                    <div className="text-ink-500 text-[11px]">{l}</div>
                    <div className={`tnum font-semibold ${k !== 'notDue' && account.ageing.buckets[k] > 0 ? 'text-red-700' : ''}`}>{money(account.ageing.buckets[k])}</div>
                  </div>
                ))}
              </div>
              {account.ageing.items.length > 0 && (
                <ul className="border-ink-100 mt-3 divide-y border-t text-[12.5px]">
                  {account.ageing.items.map((i) => (
                    <li key={i.grnId} className="flex flex-wrap items-center gap-x-3 py-1.5">
                      <Link to={`/receive/${i.grnId}`} className="hover:text-accent-700 font-mono hover:underline">
                        {i.grnNo}
                      </Link>
                      <span className="text-ink-500">received {shortDate(i.day)}</span>
                      <span className="text-ink-500">due {shortDate(i.dueDay)}</span>
                      <span className="tnum ml-auto font-medium">{money(i.outstanding)}</span>
                      {i.daysOverdue > 0 ? <Badge tone="bad">{i.daysOverdue} days late</Badge> : <Badge tone="neutral">due in {-i.daysOverdue} days</Badge>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-ink-400 mt-2 text-[11.5px]">Payments are applied to the oldest delivery first.</p>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="border-ink-100 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">Account statement</h2>
                <p className="text-ink-400 text-[11.5px]">Goods received add to what is owed; payments and goods returned take it down.</p>
              </div>
              <div className="no-print flex gap-2">
                <Button onClick={exportStatement} disabled={account.statement.length === 0}>
                  Export CSV
                </Button>
                <Button onClick={() => window.print()}>Print</Button>
              </div>
            </div>
            {account.statement.length === 0 ? (
              <Empty title="Nothing on the account yet" hint="Goods received and payments appear here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]" data-testid="statement">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-2 py-2 font-medium">Reference</th>
                      <th className="px-2 py-2 font-medium">Description</th>
                      <th className="px-2 py-2 text-right font-medium">Goods received</th>
                      <th className="px-2 py-2 text-right font-medium">Payments and returns</th>
                      <th className="px-4 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {account.statement.map((e, i) => (
                      <tr key={`${e.kind}-${e.id}-${i}`} className={e.kind === 'void' ? 'text-ink-400' : ''} data-testid="statement-row">
                        <td className="px-4 py-1.5 whitespace-nowrap">{shortDate(e.at)}</td>
                        <td className="px-2 py-1.5 font-mono text-[12px]">
                          {e.kind === 'received' ? (
                            <Link to={`/receive/${e.id}`} className="hover:text-accent-700 hover:underline">
                              {e.ref}
                            </Link>
                          ) : e.kind === 'return' ? (
                            <Link to={`/returns/${e.id}`} className="hover:text-accent-700 hover:underline">
                              {e.ref}
                            </Link>
                          ) : (
                            <button onClick={() => setOpenPayment(e.id)} className="hover:text-accent-700 hover:underline">
                              {e.ref}
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {e.description}
                          {e.timing !== undefined && (
                            <span className="ml-2">
                              <Badge tone={TIMING[e.timing].tone}>{TIMING[e.timing].label}</Badge>
                            </span>
                          )}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right">{e.debit > 0 ? money(e.debit) : ''}</td>
                        <td className="tnum px-2 py-1.5 text-right">{e.credit > 0 ? money(e.credit) : ''}</td>
                        <td className={`tnum px-4 py-1.5 text-right font-medium ${e.balance < -0.004 ? 'text-accent-700' : ''}`}>{money(e.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-ink-200 border-t font-semibold">
                      <td className="px-4 py-2" colSpan={3}>
                        Closing balance · {balanceWords(account.balance)}
                      </td>
                      <td className="tnum px-2 py-2 text-right">{money(account.receivedCost)}</td>
                      <td className="tnum px-2 py-2 text-right">{money(account.paid + account.returnedCost)}</td>
                      <td className="tnum px-4 py-2 text-right">{money(account.balance)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {financeHidden && <p className="text-ink-400 text-[12px]">The account with this supplier is group-wide finance and is shown to group-level roles only.</p>}

      <div className="grid gap-4 xl:grid-cols-2 no-print">
        <Card className="overflow-hidden">
          <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Orders</h2>
            <Link to={`/orders?supplierId=${s.id}`} className="text-accent-700 text-[12px] hover:underline">
              All orders →
            </Link>
          </div>
          {(orders.data?.items ?? []).length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12.5px]">No orders placed with this supplier yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {(orders.data?.items ?? []).slice(0, 8).map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px]">
                  <Link to={`/orders/${o.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                    {o.poNo}
                  </Link>
                  <span className="text-ink-500">{shortDate(o.orderedAt)}</span>
                  <span className="text-ink-500">{o.branch.name}</span>
                  <span className="tnum ml-auto font-medium">{money(o.ordered)}</span>
                  <Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge>
                  {o.paymentStatus !== null && <Badge tone={PO_PAYMENT[o.paymentStatus].tone}>{PO_PAYMENT[o.paymentStatus].label}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Goods received</h2>
          </div>
          {(receipts.data?.items ?? []).length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12.5px]">Nothing received from this supplier yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {(receipts.data?.items ?? []).slice(0, 8).map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[12.5px]">
                  <Link to={`/receive/${g.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                    {g.grnNo}
                  </Link>
                  <span className="text-ink-500">{shortDate(g.receivedAt)}</span>
                  <span className="text-ink-500">{g.branchName}</span>
                  {g.invoiceNo !== null && <span className="text-ink-500">invoice {g.invoiceNo}</span>}
                  <span className="tnum ml-auto font-medium">{money(g.totalCost)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {!financeHidden && (
        <Card className="overflow-hidden no-print">
          <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">Payments to {s.name}</h2>
          </div>
          {(payments.data?.items ?? []).length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12.5px]">No payments recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" data-testid="supplier-payments">
                <thead>
                  <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                    <th className="px-4 py-2 font-medium">Payment</th>
                    <th className="px-2 py-2 font-medium">Date</th>
                    <th className="px-2 py-2 font-medium">Method</th>
                    <th className="px-2 py-2 font-medium">Reference</th>
                    <th className="px-2 py-2 font-medium">When</th>
                    <th className="px-2 py-2 text-right font-medium">Proof</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-ink-100 divide-y">
                  {(payments.data?.items ?? []).map((p) => (
                    <tr key={p.id} className={`hover:bg-ink-50/60 cursor-pointer ${p.voidedAt !== null ? 'text-ink-400 line-through' : ''}`} onClick={() => setOpenPayment(p.id)}>
                      <td className="px-4 py-1.5 font-mono">{p.paymentNo}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{shortDate(p.paidAt)}</td>
                      <td className="px-2 py-1.5">{p.method}</td>
                      <td className="px-2 py-1.5">{p.reference ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={TIMING[p.timing].tone}>{TIMING[p.timing].label}</Badge>
                      </td>
                      <td className="tnum px-2 py-1.5 text-right">{p.proofs > 0 ? `${p.proofs} file${p.proofs === 1 ? '' : 's'}` : <span className="text-amber-700">none</span>}</td>
                      <td className="tnum px-4 py-1.5 text-right font-medium">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {paying && (
        <RecordPaymentDialog
          supplierId={s.id}
          {...(account !== null && account.balance > 0 ? { defaultAmount: account.balance } : {})}
          onClose={() => setPaying(false)}
          onDone={(paymentId) => {
            setPaying(false);
            reloadAll();
            setOpenPayment(paymentId);
          }}
        />
      )}
      {openPayment !== null && <PaymentDetailDialog id={openPayment} onClose={() => setOpenPayment(null)} onChanged={reloadAll} />}
      <p className="text-ink-300 hidden text-[11px] print:block">Printed {shortDateTime(new Date().toISOString())}</p>
    </div>
  );
}
