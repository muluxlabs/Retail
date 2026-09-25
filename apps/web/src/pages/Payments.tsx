/**
 * Payments to suppliers: every payment made, by which method, whether it was
 * paid before the goods came (prepaid), on the day, or after, and the evidence
 * that goes with it.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { PaymentDetailDialog, RecordPaymentDialog } from '../components/PaymentDialogs.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { shortDate, TIMING } from '../lib/buying.js';
import { downloadCsv } from '../lib/csv.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function Payments() {
  const { can } = useAuth();
  const [supplierId, setSupplierId] = useState('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [paying, setPaying] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const suppliers = useAsync(() => api.suppliers({ includeInactive: true }), []);
  const methods = useAsync(() => api.paymentTypes(), []);
  const list = useAsync(
    () =>
      api.supplierPayments({
        ...(supplierId === '' ? {} : { supplierId }),
        ...(method === '' ? {} : { paymentTypeId: method }),
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
        includeVoided,
        limit: 200,
      }),
    [supplierId, method, from, to, includeVoided],
  );
  const items = list.data?.items ?? [];

  const byMethod = new Map<string, number>();
  for (const p of items) if (p.voidedAt === null) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
  const noProof = items.filter((p) => p.voidedAt === null && p.proofs === 0 && p.methodId !== 'cash').length;

  function exportCsv() {
    downloadCsv(
      'supplier-payments.csv',
      ['Payment', 'Date paid', 'Supplier', 'Method', 'Reference', 'For', 'Timing', 'Amount', 'Proof files', 'Recorded by', 'Voided'],
      items.map((p) => [p.paymentNo, p.paidAt.slice(0, 10), p.supplierName, p.method, p.reference ?? '', p.grnNo ?? p.poNo ?? 'On account', TIMING[p.timing].label, p.amount, p.proofs, p.recordedByName, p.voidedAt === null ? '' : `voided: ${p.voidReason ?? ''}`]),
    );
  }

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Payments to suppliers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Every payment, how it was made, and the proof. A payment is never edited: one made in error is voided, with a reason, and stays on record.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={exportCsv} disabled={items.length === 0}>
            Export CSV
          </Button>
          {can('supplier.pay') && (
            <Button variant="primary" onClick={() => setPaying(true)}>
              Record payment
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Paid in this view</div>
          <div className="tnum mt-1 text-xl font-semibold" data-testid="paid-total">{money(list.data?.total ?? 0)}</div>
          <div className="text-ink-400 text-xs">{list.data?.count ?? 0} payments</div>
        </Card>
        {[...byMethod.entries()].slice(0, 2).map(([m, v]) => (
          <Card key={m} className="px-4 py-3">
            <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">By {m.toLowerCase()}</div>
            <div className="tnum mt-1 text-xl font-semibold">{money(v)}</div>
          </Card>
        ))}
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Without proof</div>
          <div className={`tnum mt-1 text-xl font-semibold ${noProof > 0 ? 'text-amber-700' : ''}`}>{noProof}</div>
          <div className="text-ink-400 text-xs">non-cash payments with no file</div>
        </Card>
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
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
            <span className={label}>Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={field} aria-label="Method">
              <option value="">Any method</option>
              {(methods.data ?? []).filter((m) => m.forSuppliers).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} aria-label="From" />
          </label>
          <label className="block">
            <span className={label}>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} aria-label="To" />
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-[12.5px]">
            <input type="checkbox" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} className="accent-accent-600 size-3.5" />
            Include voided
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
          <Empty title="No payments match" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="payments">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Payment</th>
                  <th className="px-2 py-2 font-medium">Paid</th>
                  <th className="px-2 py-2 font-medium">Supplier</th>
                  <th className="px-2 py-2 font-medium">Method</th>
                  <th className="px-2 py-2 font-medium">For</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 text-right font-medium">Proof</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((p) => (
                  <tr key={p.id} className={`hover:bg-ink-50/60 cursor-pointer ${p.voidedAt !== null ? 'text-ink-400 line-through' : ''}`} onClick={() => setOpen(p.id)} data-testid="payment-row">
                    <td className="px-4 py-2 font-mono font-medium">{p.paymentNo}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{shortDate(p.paidAt)}</td>
                    <td className="px-2 py-2">
                      <Link to={`/suppliers/${p.supplierId}`} onClick={(e) => e.stopPropagation()} className="hover:text-accent-700 hover:underline">
                        {p.supplierName}
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      {p.method}
                      {p.reference !== null && <div className="text-ink-400 text-[11px]">{p.reference}</div>}
                    </td>
                    <td className="text-ink-600 px-2 py-2">{p.grnNo ?? p.poNo ?? 'On account'}</td>
                    <td className="px-2 py-2">
                      <Badge tone={TIMING[p.timing].tone}>{TIMING[p.timing].label}</Badge>
                    </td>
                    <td className="tnum px-2 py-2 text-right">{p.proofs > 0 ? `${p.proofs} file${p.proofs === 1 ? '' : 's'}` : <span className="text-amber-700">none</span>}</td>
                    <td className="tnum px-4 py-2 text-right font-medium">{money(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {paying && (
        <RecordPaymentDialog
          {...(supplierId === '' ? {} : { supplierId })}
          onClose={() => setPaying(false)}
          onDone={(id) => {
            setPaying(false);
            list.reload();
            setOpen(id);
          }}
        />
      )}
      {open !== null && <PaymentDetailDialog id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </div>
  );
}
