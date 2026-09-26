/**
 * Take a payment from a customer towards what they owe on account. Cash goes
 * into a named till or safe at the branch; anything else needs its reference.
 */

import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

import { CustomerPicker } from './CustomerPicker.js';
import { api, ApiError, type CustomerLookup } from '../lib/api.js';
import { parseMoney } from '../lib/basketMath.js';
import { Button, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function ReceiveDialog({
  branchId,
  customer: fixed,
  defaultCashPointId,
  onClose,
  onDone,
}: {
  branchId: string;
  customer?: CustomerLookup;
  defaultCashPointId?: string;
  onClose: () => void;
  onDone: (receiptNo: string) => void;
}) {
  const [customer, setCustomer] = useState<CustomerLookup | null>(fixed ?? null);
  const methods = useAsync(() => api.paymentTypes(), []);
  const points = useAsync(() => api.customerCashPoints(branchId), [branchId]);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(fixed !== undefined && fixed.balance > 0 ? fixed.balance.toFixed(2) : '');
  const [reference, setReference] = useState('');
  const [cashPointId, setCashPointId] = useState(defaultCashPointId ?? '');
  const [note, setNote] = useState('');
  const [id] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (customer !== null && amount === '' && customer.balance > 0) setAmount(customer.balance.toFixed(2));
  }, [customer]); // eslint-disable-line react-hooks/exhaustive-deps

  const usable = (methods.data ?? []).filter((m) => m.atTill && m.id !== 'account');
  const isCash = usable.find((m) => m.id === method)?.isCash === true;
  const amt = parseMoney(amount);
  const canSave =
    customer !== null && amt !== null && amt > 0 && !busy &&
    (isCash ? (points.data?.items ?? []).length === 0 || cashPointId !== '' : reference.trim() !== '');

  async function save() {
    if (customer === null || amt === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.receiveFromCustomer({
        id,
        customerId: customer.id,
        branchId,
        amount: amt,
        paymentTypeId: method,
        ...(isCash ? { cashPointId: cashPointId === '' ? null : cashPointId } : { reference: reference.trim() }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      onDone(r.receiptNo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-label="Take a payment on account">
      <div className="my-6 w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="border-ink-100 flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[14px] font-semibold tracking-tight">Take a payment on account</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-800 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          {fixed === undefined ? (
            <CustomerPicker value={customer} onChange={setCustomer} label="Customer" />
          ) : (
            <div className="text-[13px]">
              <span className="font-medium">{fixed.name}</span> <span className="text-ink-500">owes {money(fixed.balance)}</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>Amount received</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount received" className={`${field} tnum text-right`} />
            </label>
            <label className="block">
              <span className={label}>Paid by</span>
              <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Paid by" className={field}>
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {isCash ? (
            (points.data?.items ?? []).length > 0 && (
              <label className="block">
                <span className={label}>Cash put into</span>
                <select value={cashPointId} onChange={(e) => setCashPointId(e.target.value)} aria-label="Cash put into" className={field}>
                  <option value="">Choose the till or safe…</option>
                  {(points.data?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )
          ) : (
            <label className="block">
              <span className={label}>Reference</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction number" aria-label="Payment reference" className={field} />
            </label>
          )}
          <label className="block">
            <span className={label}>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" className={field} />
          </label>
          {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
              {busy ? <Spinner /> : null}
              Record payment{amt !== null && amt > 0 ? ` · ${money(amt)}` : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
