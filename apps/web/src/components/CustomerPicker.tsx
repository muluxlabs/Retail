/**
 * Name the customer on a sale, or pick whose account a payment is for: search
 * by name, code or phone, and see how much credit they have left and their
 * points. At the till, someone new can be signed up on the spot.
 */

import { useEffect, useState } from 'react';

import { api, ApiError, type CustomerLookup } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Spinner, money } from '../lib/ui.js';

const small = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';

export function CustomerPicker({
  value,
  onChange,
  label = 'Customer (optional)',
  showPoints = false,
  allowEnrol = false,
}: {
  value: CustomerLookup | null;
  onChange: (c: CustomerLookup | null) => void;
  label?: string;
  showPoints?: boolean;
  /** Offer to sign up someone who is not found (for those allowed). */
  allowEnrol?: boolean;
}) {
  const { can } = useAuth();
  const mayEnrol = allowEnrol && can('customer.enrol');
  const [enrolling, setEnrolling] = useState<{ name: string; phone: string } | null>(null);
  const [enrolError, setEnrolError] = useState<string | null>(null);
  const [enrolBusy, setEnrolBusy] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CustomerLookup[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term === '') {
      setItems([]);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .customerLookup(term)
        .then((r) => live && setItems(r.items))
        .catch(() => live && setItems([]))
        .finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  async function enrol() {
    if (enrolling === null) return;
    setEnrolBusy(true);
    setEnrolError(null);
    try {
      const c = await api.enrolCustomer({ name: enrolling.name.trim(), phone: enrolling.phone.trim() });
      setEnrolling(null);
      setQ('');
      onChange(c);
    } catch (e) {
      setEnrolError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setEnrolBusy(false);
    }
  }

  if (enrolling !== null) {
    return (
      <div className="space-y-2" data-testid="enrol-form">
        <span className="text-ink-600 block text-[11px] font-medium uppercase tracking-wider">Sign up a new customer</span>
        <input value={enrolling.name} onChange={(e) => setEnrolling({ ...enrolling, name: e.target.value })} placeholder="Full name" aria-label="New customer name" className={small} />
        <input value={enrolling.phone} onChange={(e) => setEnrolling({ ...enrolling, phone: e.target.value })} placeholder="Phone number" inputMode="tel" aria-label="New customer phone" className={small} />
        {enrolError !== null && <p className="text-[12px] text-red-700">{enrolError}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEnrolling(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void enrol()} disabled={enrolBusy || enrolling.name.trim().length < 2 || enrolling.phone.trim().length < 5}>
            {enrolBusy ? <Spinner /> : null}
            Sign up
          </Button>
        </div>
      </div>
    );
  }

  if (value !== null) {
    return (
      <div className="border-ink-200 flex items-center justify-between gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px]" data-testid="customer-chosen">
        <div className="min-w-0">
          <div className="truncate font-medium">{value.name}</div>
          <div className="text-ink-500 text-[11px]">
            {value.code}
            {value.creditLimit > 0 ? ` · owes ${money(value.balance)} · ${money(value.available)} credit left` : ' · cash customer, no credit'}
            {showPoints && <span data-testid="customer-points"> · {value.points.toLocaleString()} points</span>}
          </div>
        </div>
        <button onClick={() => onChange(null)} aria-label="Remove customer" className="text-ink-400 text-[15px] hover:text-red-600">
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">{label}</span>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name, code or phone…"
        aria-label="Find a customer"
        className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
      />
      {q.trim() !== '' && (
        <div className="border-ink-100 absolute z-10 mt-1 max-h-60 w-full divide-y overflow-y-auto rounded-lg border bg-white shadow-md">
          {loading && items.length === 0 ? (
            <div className="grid place-items-center py-3">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2">
              <p className="text-ink-400 text-[12px]">No customer matches.</p>
              {mayEnrol && (
                <button
                  onClick={() => {
                    const t = q.trim();
                    setEnrolError(null);
                    setEnrolling(/^[+\d][\d\s-]*$/.test(t) ? { name: '', phone: t } : { name: t, phone: '' });
                  }}
                  className="text-accent-700 mt-1 text-[12px] font-medium hover:underline"
                >
                  + Sign up a new customer
                </button>
              )}
            </div>
          ) : (
            items.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  onChange(c);
                  setQ('');
                }}
                className="hover:bg-ink-50 flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px]"
              >
                <span className="min-w-0 truncate">
                  {c.name} <span className="text-ink-400 font-mono text-[11px]">{c.code}</span>
                </span>
                <span className="text-ink-500 shrink-0 text-[11px]">
                  {showPoints && c.points > 0 ? `${c.points.toLocaleString()} pts · ` : ''}
                  {c.creditLimit > 0 ? `${money(c.available)} left` : 'no credit'}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
