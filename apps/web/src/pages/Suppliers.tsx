/**
 * Suppliers: who the business buys from, on what terms, and what is owed to them.
 *
 * "Owed" is never typed in. It is goods received at cost less payments made,
 * worked out from the documents; the supplier's own page shows exactly which.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { api, ApiError, type SupplierInput, type SupplierTerms } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { balanceWords, shortDate, termsText, TERMS_HELP, TERMS_LABEL } from '../lib/buying.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function Suppliers() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useAsync(() => api.suppliers({ ...(search.trim() === '' ? {} : { q: search.trim() }), includeInactive }), [search, includeInactive]);
  const items = list.data?.items ?? [];
  const hidden = list.data?.financeHidden ?? false;

  const owing = items.filter((s) => (s.balance ?? 0) > 0.004);
  const totalOwed = owing.reduce((t, s) => t + (s.balance ?? 0), 0);
  const prepaid = items.filter((s) => (s.balance ?? 0) < -0.004).reduce((t, s) => t + -(s.balance ?? 0), 0);

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Suppliers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Everyone the business buys from, the terms they sell on, and what is owed to them. Order stock from a supplier, receive
            it against the order, and record what has been paid.
          </p>
        </div>
        {can('supplier.write') && (
          <Button variant="primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add supplier'}
          </Button>
        )}
      </div>

      {adding && (
        <SupplierForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}

      {!hidden && list.data !== undefined && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="px-4 py-3">
            <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Owed to suppliers</div>
            <div className="tnum mt-1 text-xl font-semibold" data-testid="total-owed">{money(totalOwed)}</div>
            <div className="text-ink-400 text-xs">{owing.length} {owing.length === 1 ? 'supplier' : 'suppliers'} to pay</div>
          </Card>
          <Card className="px-4 py-3">
            <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Prepaid with suppliers</div>
            <div className="tnum mt-1 text-xl font-semibold">{money(prepaid)}</div>
            <div className="text-ink-400 text-xs">paid for goods not yet received</div>
          </Card>
          <Card className="px-4 py-3">
            <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Suppliers</div>
            <div className="tnum mt-1 text-xl font-semibold">{items.length}</div>
          </Card>
          <Card className="px-4 py-3">
            <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Orders awaiting delivery</div>
            <div className="tnum mt-1 text-xl font-semibold">{items.reduce((t, s) => t + s.openOrders, 0)}</div>
          </Card>
        </div>
      )}

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, code or contact…" aria-label="Search suppliers" className={`${field} max-w-sm`} />
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} className="accent-accent-600 size-3.5" />
            Show inactive
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
          <Empty title="No suppliers yet" hint={can('supplier.write') ? 'Add the first supplier to start ordering stock.' : 'A stock controller or manager adds suppliers.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="suppliers">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Supplier</th>
                  <th className="px-2 py-2 font-medium">Terms</th>
                  <th className="px-2 py-2 text-right font-medium">Orders open</th>
                  <th className="px-2 py-2 font-medium">Last delivery</th>
                  {!hidden && <th className="px-4 py-2 text-right font-medium">Balance</th>}
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((s) => (
                  <tr key={s.id} className="hover:bg-ink-50/60" data-testid="supplier-row">
                    <td className="px-4 py-2">
                      <Link to={`/suppliers/${s.id}`} className="hover:text-accent-700 font-medium hover:underline">
                        {s.name}
                      </Link>
                      {!s.isActive && (
                        <span className="ml-2">
                          <Badge tone="neutral">inactive</Badge>
                        </span>
                      )}
                      <div className="text-ink-400 text-[11px]">
                        <span className="font-mono">{s.code}</span>
                        {s.contactPerson !== null && ` · ${s.contactPerson}`}
                        {s.phone !== null && ` · ${s.phone}`}
                      </div>
                    </td>
                    <td className="text-ink-600 px-2 py-2">{termsText(s.terms, s.creditDays)}</td>
                    <td className="tnum px-2 py-2 text-right">{s.openOrders}</td>
                    <td className="text-ink-600 px-2 py-2 whitespace-nowrap">{shortDate(s.lastDelivery)}</td>
                    {!hidden && (
                      <td className="tnum px-4 py-2 text-right">
                        <span className={(s.balance ?? 0) > 0.004 ? 'font-semibold' : (s.balance ?? 0) < -0.004 ? 'text-accent-700 font-medium' : 'text-ink-400'} title={balanceWords(s.balance ?? 0)}>
                          {money(Math.abs(s.balance ?? 0))}
                        </span>
                        {(s.balance ?? 0) < -0.004 && <span className="text-ink-400 ml-1 text-[11px]">prepaid</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {hidden && <p className="text-ink-400 text-[12px]">What is owed to each supplier is group-wide finance and is shown to group-level roles only.</p>}
    </div>
  );
}

export function SupplierForm({
  initial,
  supplierId,
  onCancel,
  onSaved,
}: {
  initial?: Partial<SupplierInput>;
  /** Set to edit an existing supplier instead of adding one. */
  supplierId?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [contact, setContact] = useState(initial?.contactPerson ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [tin, setTin] = useState(initial?.tin ?? '');
  const [terms, setTerms] = useState<SupplierTerms>(initial?.terms ?? 'credit');
  const [days, setDays] = useState(String(initial?.creditDays ?? 30));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const body: SupplierInput = {
      name: name.trim(),
      contactPerson: contact.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      tin: tin.trim() || null,
      terms,
      ...(terms === 'credit' ? { creditDays: Number(days) || 0 } : { creditDays: null }),
      notes: notes.trim() || null,
    };
    try {
      if (supplierId === undefined) await api.createSupplier(body);
      else await api.updateSupplier(supplierId, body);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4" data-testid="supplier-form">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block sm:col-span-2 lg:col-span-1">
          <span className={label}>Supplier name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Supplier name" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={label}>Contact person</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} aria-label="Contact person" className={field} />
        </label>
        <label className="block">
          <span className={label}>Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone" className={field} />
        </label>
        <label className="block">
          <span className={label}>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" className={field} />
        </label>
        <label className="block">
          <span className={label}>TIN / VAT number</span>
          <input value={tin} onChange={(e) => setTin(e.target.value)} aria-label="TIN" className={field} />
        </label>
        <label className="block">
          <span className={label}>Address</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address" className={field} />
        </label>
        <label className="block">
          <span className={label}>They are paid</span>
          <select value={terms} onChange={(e) => setTerms(e.target.value as SupplierTerms)} aria-label="Payment terms" className={field}>
            {(Object.keys(TERMS_LABEL) as SupplierTerms[]).map((t) => (
              <option key={t} value={t}>
                {TERMS_LABEL[t]} - {TERMS_HELP[t].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        {terms === 'credit' && (
          <label className="block">
            <span className={label}>Days to pay</span>
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days of credit" className={`${field} tnum`} />
          </label>
        )}
        <label className="block sm:col-span-2 lg:col-span-3">
          <span className={label}>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" className={field} />
        </label>
      </div>
      {error !== null && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy || name.trim().length < 2}>
          {busy ? <Spinner /> : null}
          {supplierId === undefined ? 'Add supplier' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
