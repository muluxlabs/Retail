/**
 * Customers on credit: who may buy on account, how much they may owe, what
 * they owe now, and how late. Aged debtors shows every customer's balance
 * by how overdue it is.
 */

import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';

import { LoyaltyCard } from '../components/LoyaltyCard.js';
import { ReceiveDialog } from '../components/ReceiveDialog.js';
import { api, ApiError, type CustomerInput } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { parseMoney } from '../lib/basketMath.js';
import { shortDate, shortDateTime } from '../lib/buying.js';
import { downloadCsv } from '../lib/csv.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

const BUCKETS = [
  ['notDue', 'Not yet due'],
  ['d1_30', '1-30 days late'],
  ['d31_60', '31-60 days late'],
  ['d61_90', '61-90 days late'],
  ['over90', 'Over 90 days late'],
] as const;

export function CustomerTabs() {
  return (
    <nav aria-label="Customers" className="no-print -mt-1 flex flex-wrap gap-1">
      {[
        ['/customers', 'Customers'],
        ['/debtors', 'Owed by customers'],
      ].map(([to, text]) => (
        <NavLink
          key={to}
          to={to!}
          className={({ isActive }) =>
            `rounded-lg px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition ${isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`
          }
        >
          {text}
        </NavLink>
      ))}
    </nav>
  );
}

function CustomerForm({ initial, id, onCancel, onSaved }: { initial?: Partial<CustomerInput>; id?: string; onCancel: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [idNumber, setIdNumber] = useState(initial?.idNumber ?? '');
  const [limit, setLimit] = useState(initial?.creditLimit === undefined ? '0' : String(initial.creditLimit));
  const [days, setDays] = useState(String(initial?.creditDays ?? 30));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lim = parseMoney(limit);

  async function save() {
    if (lim === null) return;
    setBusy(true);
    setError(null);
    const body: CustomerInput = {
      name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, address: address.trim() || null,
      idNumber: idNumber.trim() || null, creditLimit: lim, creditDays: Number(days) || 0, notes: notes.trim() || null,
    };
    try {
      if (id === undefined) onSaved((await api.createCustomer(body)).id);
      else {
        await api.updateCustomer(id, body);
        onSaved(id);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4" data-testid="customer-form">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className={label}>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Customer name" className={field} />
        </label>
        <label className="block">
          <span className={label}>Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone" className={field} />
        </label>
        <label className="block">
          <span className={label}>ID number</span>
          <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} aria-label="ID number" className={field} />
        </label>
        <label className="block">
          <span className={label}>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" className={field} />
        </label>
        <label className="block">
          <span className={label}>Address</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address" className={field} />
        </label>
        <label className="block">
          <span className={label}>Credit limit</span>
          <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Credit limit" className={`${field} tnum text-right`} />
        </label>
        <label className="block">
          <span className={label}>Days to pay</span>
          <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days to pay" className={`${field} tnum`} />
        </label>
        <label className="block sm:col-span-2 lg:col-span-4">
          <span className={label}>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" className={field} />
        </label>
      </div>
      <p className="text-ink-400 mt-2 text-[11.5px]">A credit limit of 0 means cash only. Raising a limit is sent to an auditor to review.</p>
      {error !== null && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy || name.trim().length < 2 || lim === null}>
          {busy ? <Spinner /> : null}
          {id === undefined ? 'Add customer' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function Customers() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [owingOnly, setOwingOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useAsync(() => api.customers({ ...(q.trim() === '' ? {} : { q: q.trim() }), owingOnly }), [q, owingOnly]);
  const items = list.data?.items ?? [];
  const owed = items.reduce((t, c) => t + Math.max(0, c.balance), 0);
  return (
    <div className="space-y-4">
      <CustomerTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Customers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Customers who may buy on account, their credit limits and what they owe. A sale is charged to an account at the till by
            choosing the customer and paying "On account".
          </p>
        </div>
        {can('customer.write') && (
          <div className="flex gap-2">
            <Link
              to="/customers/import"
              className="bg-white text-ink-700 ring-ink-200 hover:bg-ink-50 inline-flex items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset"
            >
              Import from Excel / CSV
            </Link>
            <Button variant="primary" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'Add customer'}
            </Button>
          </div>
        )}
      </div>
      {adding && (
        <CustomerForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code or phone…" aria-label="Search customers" className={`${field} max-w-sm`} />
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={owingOnly} onChange={(e) => setOwingOnly(e.target.checked)} className="accent-accent-600 size-3.5" />
            Only those who owe
          </label>
          <span className="text-ink-500 ml-auto text-[12.5px]">
            Owed in this list: <span className="tnum text-ink-900 font-semibold" data-testid="owed-total">{money(owed)}</span>
          </span>
        </div>
      </Card>
      {list.error !== undefined && <ErrorNote error={list.error} />}
      <Card className="overflow-hidden">
        {list.loading && list.data === undefined ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No customers" hint={can('customer.write') ? 'Add a customer to sell to them on account.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="customers">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-2 py-2 text-right font-medium">Credit limit</th>
                  <th className="px-2 py-2 text-right font-medium">Owes</th>
                  <th className="px-2 py-2 text-right font-medium">Credit left</th>
                  <th className="px-4 py-2 font-medium">Last bought</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-ink-50/60" data-testid="customer-row">
                    <td className="px-4 py-2">
                      <Link to={`/customers/${c.id}`} className="hover:text-accent-700 font-medium hover:underline">
                        {c.name}
                      </Link>
                      {!c.isActive && (
                        <span className="ml-2">
                          <Badge tone="neutral">inactive</Badge>
                        </span>
                      )}
                      <div className="text-ink-400 text-[11px]">
                        <span className="font-mono">{c.code}</span>
                        {c.phone !== null && ` · ${c.phone}`}
                      </div>
                    </td>
                    <td className="tnum px-2 py-2 text-right">{c.creditLimit === 0 ? <span className="text-ink-400">cash only</span> : money(c.creditLimit)}</td>
                    <td className={`tnum px-2 py-2 text-right ${c.balance > 0 ? 'font-semibold' : 'text-ink-400'}`}>{money(c.balance)}</td>
                    <td className="tnum px-2 py-2 text-right">{c.creditLimit === 0 ? '—' : money(c.available)}</td>
                    <td className="text-ink-600 px-4 py-2">{shortDate(c.lastSale)}</td>
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

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { user, can } = useAuth();
  const d = useAsync(() => api.customer(id), [id]);
  const branches = useAsync(() => api.branches(), []);
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (d.error !== undefined) return <ErrorNote error={d.error} />;
  const data = d.data;
  if (data === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const c = data.customer;
  const a = data.account;
  const scoped = user?.branchIds ?? [];
  const myBranches = (branches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));
  const overdue = a.ageing.buckets.d1_30 + a.ageing.buckets.d31_60 + a.ageing.buckets.d61_90 + a.ageing.buckets.over90;

  async function doVoid() {
    if (voiding === null) return;
    try {
      await api.voidCustomerPayment(voiding, reason.trim());
      setVoiding(null);
      setReason('');
      d.reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <CustomerTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/customers" className="hover:text-ink-700 hover:underline">
          Customers
        </Link>{' '}
        / {c.name}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight" data-testid="customer-name">
            {c.name}
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            <span className="font-mono">{c.code}</span>
            {c.phone !== null && ` · ${c.phone}`}
            {c.email !== null && ` · ${c.email}`}
            {c.idNumber !== null && ` · ID ${c.idNumber}`}
            {' · '}
            {c.creditLimit === 0 ? 'cash only' : `credit limit ${money(c.creditLimit)}, ${c.creditDays} days to pay`}
          </p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {can('customer.receive') && myBranches.length > 0 && (
            <Button variant="primary" onClick={() => setReceiving(myBranches[0]!.id)}>
              Take a payment
            </Button>
          )}
          {can('customer.write') && <Button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit'}</Button>}
          <Button onClick={() => window.print()}>Print statement</Button>
        </div>
      </div>
      {editing && (
        <CustomerForm
          id={c.id}
          initial={{ name: c.name, phone: c.phone, email: c.email, address: c.address, idNumber: c.idNumber, creditLimit: c.creditLimit, creditDays: c.creditDays, notes: c.notes }}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            d.reload();
          }}
        />
      )}
      {message !== null && <div className="rounded-lg border border-accent-300/60 bg-accent-50 px-3 py-2 text-[12.5px] text-accent-700" role="status">{message}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Owes</div>
          <div className="tnum mt-1 text-2xl font-semibold" data-testid="customer-balance">{money(a.balance)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Overdue</div>
          <div className={`tnum mt-1 text-2xl font-semibold ${overdue > 0 ? 'text-red-700' : ''}`}>{money(overdue)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Credit left</div>
          <div className="tnum mt-1 text-2xl font-semibold">{c.creditLimit === 0 ? '—' : money(data.available)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Charged / paid</div>
          <div className="tnum mt-1 text-[15px] font-semibold">
            {money(a.charged)} / {money(a.paid)}
          </div>
        </Card>
      </div>

      <LoyaltyCard customerId={c.id} />

      <Card className="overflow-hidden">
        <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold tracking-tight">Statement of account</h2>
            <p className="text-ink-400 text-[11.5px]">Sales on account add to what is owed; payments take it down.</p>
          </div>
          <Button
            className="no-print"
            onClick={() =>
              downloadCsv(`statement-${c.code}.csv`, ['Date', 'Reference', 'Description', 'Charged', 'Paid', 'Balance'], a.statement.map((e) => [e.at.slice(0, 10), e.ref, e.description, e.debit, e.credit, e.balance]))
            }
            disabled={a.statement.length === 0}
          >
            Export CSV
          </Button>
        </div>
        {a.statement.length === 0 ? (
          <Empty title="Nothing on the account yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="customer-statement">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Reference</th>
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 text-right font-medium">Charged</th>
                  <th className="px-2 py-2 text-right font-medium">Paid</th>
                  <th className="px-2 py-2 text-right font-medium">Balance</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {a.statement.map((e, i) => {
                  const voided = e.kind === 'payment' && a.statement.some((x) => x.kind === 'void' && x.id === e.id);
                  return (
                    <tr key={`${e.kind}-${e.id}-${i}`} className={e.kind === 'void' ? 'text-ink-400' : ''} data-testid="statement-row">
                      <td className="px-4 py-1.5 whitespace-nowrap">{shortDateTime(e.at)}</td>
                      <td className="px-2 py-1.5 font-mono text-[12px]">{e.ref}</td>
                      <td className="px-2 py-1.5">{e.description}</td>
                      <td className="tnum px-2 py-1.5 text-right">{e.debit > 0 ? money(e.debit) : ''}</td>
                      <td className="tnum px-2 py-1.5 text-right">{e.credit > 0 ? money(e.credit) : ''}</td>
                      <td className="tnum px-2 py-1.5 text-right font-medium">{money(e.balance)}</td>
                      <td className="no-print px-2 text-right">
                        {e.kind === 'payment' && !voided && can('customer.write') && (
                          <button onClick={() => setVoiding(e.id)} className="text-[11.5px] text-red-700 hover:underline">
                            void
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {voiding !== null && (
          <div className="border-ink-100 flex flex-wrap items-end gap-2 border-t px-4 py-3">
            <label className="block min-w-64 flex-1">
              <span className={label}>Why is this payment being voided?</span>
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for voiding" className={field} />
            </label>
            <Button variant="danger" onClick={() => void doVoid()} disabled={reason.trim().length < 5}>
              Void payment
            </Button>
            <Button variant="ghost" onClick={() => setVoiding(null)}>
              Keep it
            </Button>
          </div>
        )}
      </Card>

      {a.ageing.items.length > 0 && (
        <Card className="px-4 py-3">
          <div className="mb-2 text-[13px] font-semibold tracking-tight">Unpaid sales</div>
          <ul className="divide-ink-100 divide-y text-[12.5px]">
            {a.ageing.items.map((i) => (
              <li key={i.saleId} className="flex flex-wrap items-center gap-x-3 py-1.5">
                <span className="font-mono">{i.receiptNo}</span>
                <span className="text-ink-500">bought {shortDate(i.day)}</span>
                <span className="text-ink-500">due {shortDate(i.dueDay)}</span>
                <span className="tnum ml-auto font-medium">{money(i.outstanding)}</span>
                {i.daysOverdue > 0 ? <Badge tone="bad">{i.daysOverdue} days late</Badge> : <Badge tone="neutral">due in {-i.daysOverdue} days</Badge>}
              </li>
            ))}
          </ul>
          <p className="text-ink-400 mt-2 text-[11.5px]">Payments are applied to the oldest sale first.</p>
        </Card>
      )}

      {receiving !== null && (
        <ReceiveDialog
          branchId={receiving}
          customer={{ id: c.id, code: c.code, name: c.name, phone: c.phone, creditLimit: c.creditLimit, balance: a.balance, available: data.available, points: 0 }}
          onClose={() => setReceiving(null)}
          onDone={(no) => {
            setReceiving(null);
            setMessage(`Payment ${no} recorded.`);
            d.reload();
          }}
        />
      )}
    </div>
  );
}

export function DebtorsPage() {
  const data = useAsync(() => api.debtors(), []);
  if (data.error !== undefined) return <ErrorNote error={data.error} />;
  const d = data.data;
  return (
    <div className="space-y-4">
      <CustomerTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Owed by customers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            What each customer owes on account and how late it is{d !== undefined && <> - as at {shortDate(d.asOf)}</>}. Each sale is due its
            customer's days to pay after it was made; payments settle the oldest first.
          </p>
        </div>
        <div className="no-print flex gap-2">
          <Button
            onClick={() =>
              d !== undefined &&
              downloadCsv(
                `owed-by-customers-${d.asOf}.csv`,
                ['Customer', 'Code', 'Phone', 'Not yet due', '1-30 days late', '31-60 days late', '61-90 days late', 'Over 90 days late', 'Total owed', 'In credit'],
                d.customers.map((c) => [c.name, c.code, c.phone ?? '', c.buckets.notDue, c.buckets.d1_30, c.buckets.d31_60, c.buckets.d61_90, c.buckets.over90, c.owed, c.credit]),
              )
            }
            disabled={d === undefined || d.customers.length === 0}
          >
            Export CSV
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>
      {d === undefined ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Total owed</div>
              <div className="tnum mt-1 text-2xl font-semibold" data-testid="debtors-total">{money(d.totals.total)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Overdue</div>
              <div className={`tnum mt-1 text-2xl font-semibold ${d.totals.total - d.totals.notDue > 0 ? 'text-red-700' : ''}`}>{money(d.totals.total - d.totals.notDue)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">Customers in credit</div>
              <div className="tnum mt-1 text-2xl font-semibold">{money(d.totals.credit)}</div>
              <div className="text-ink-400 text-xs">paid more than they owe</div>
            </Card>
          </div>
          <Card className="overflow-hidden">
            {d.customers.length === 0 ? (
              <Empty title="No customer owes anything" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]" data-testid="debtors">
                  <thead>
                    <tr className="text-ink-500 border-ink-100 border-b text-[11px] uppercase tracking-wider">
                      <th className="px-4 py-2 text-left font-medium">Customer</th>
                      {BUCKETS.map(([k, l]) => (
                        <th key={k} className="px-2 py-2 text-right font-medium">
                          {l}
                        </th>
                      ))}
                      <th className="px-4 py-2 text-right font-medium">Total owed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-ink-100 divide-y">
                    {d.customers.map((c) => (
                      <tr key={c.customerId} className="hover:bg-ink-50/60" data-testid="debtor-row">
                        <td className="px-4 py-2">
                          <Link to={`/customers/${c.customerId}`} className="hover:text-accent-700 font-medium hover:underline">
                            {c.name}
                          </Link>
                          {c.phone !== null && <div className="text-ink-400 text-[11px]">{c.phone}</div>}
                        </td>
                        {BUCKETS.map(([k]) => (
                          <td key={k} className={`tnum px-2 py-2 text-right ${k !== 'notDue' && c.buckets[k] > 0 ? 'font-medium text-red-700' : c.buckets[k] === 0 ? 'text-ink-300' : ''}`}>
                            {c.buckets[k] === 0 ? '—' : money(c.buckets[k])}
                          </td>
                        ))}
                        <td className="tnum px-4 py-2 text-right font-semibold">{money(c.owed)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-ink-200 border-t font-semibold">
                      <td className="px-4 py-2">Total</td>
                      {BUCKETS.map(([k]) => (
                        <td key={k} className="tnum px-2 py-2 text-right">
                          {money(d.totals[k])}
                        </td>
                      ))}
                      <td className="tnum px-4 py-2 text-right">{money(d.totals.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
