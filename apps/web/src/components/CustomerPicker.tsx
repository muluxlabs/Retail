/**
 * Name the customer on a sale, or pick whose account a payment is for: search
 * by name, code or phone, and see how much credit they have left.
 */

import { useEffect, useState } from 'react';

import { api, type CustomerLookup } from '../lib/api.js';
import { Spinner, money } from '../lib/ui.js';

export function CustomerPicker({
  value,
  onChange,
  label = 'Customer (optional)',
}: {
  value: CustomerLookup | null;
  onChange: (c: CustomerLookup | null) => void;
  label?: string;
}) {
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

  if (value !== null) {
    return (
      <div className="border-ink-200 flex items-center justify-between gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px]" data-testid="customer-chosen">
        <div className="min-w-0">
          <div className="truncate font-medium">{value.name}</div>
          <div className="text-ink-500 text-[11px]">
            {value.code}
            {value.creditLimit > 0 ? ` · owes ${money(value.balance)} · ${money(value.available)} credit left` : ' · cash customer, no credit'}
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
            <p className="text-ink-400 px-3 py-2 text-[12px]">No customer matches.</p>
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
                <span className="text-ink-500 shrink-0 text-[11px]">{c.creditLimit > 0 ? `${money(c.available)} left` : 'no credit'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
