/**
 * Recording a payment to a supplier, and looking at one afterwards.
 *
 * A payment says how much, by what method, with what reference (the bank
 * transfer number, the cheque number), on what date, and what it was for: an
 * order (a prepayment), a delivery, or simply the account. A screenshot or
 * photo of the transaction can be attached, and stays with the payment.
 *
 * Payments are never edited. One made in error is voided, with a reason, and
 * the void is on the supplier statement.
 */

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

import { api, ApiError, type PaymentDetail, type PaymentType } from '../lib/api.js';
import { parseMoney } from '../lib/basketMath.js';
import { shortDateTime } from '../lib/buying.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Spinner, money, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-label={title}>
      <div className={`bg-white my-6 w-full rounded-xl shadow-xl ${wide ? 'max-w-2xl' : 'max-w-lg'}`}>
        <div className="border-ink-100 flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-800 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function RecordPaymentDialog({
  supplierId,
  poId = null,
  grnId = null,
  defaultAmount,
  onClose,
  onDone,
}: {
  /** Fixed when opened from a supplier, an order or a delivery. */
  supplierId?: string;
  poId?: string | null;
  grnId?: string | null;
  defaultAmount?: number;
  onClose: () => void;
  onDone: (paymentId: string) => void;
}) {
  const suppliers = useAsync(() => api.suppliers({}), []);
  const methods = useAsync(() => api.paymentTypes(), []);
  const [supplier, setSupplier] = useState(supplierId ?? '');
  const [amount, setAmount] = useState(defaultAmount === undefined || defaultAmount <= 0 ? '' : defaultAmount.toFixed(2));
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [forWhat, setForWhat] = useState<string>(grnId !== null ? `grn:${grnId}` : poId !== null ? `po:${poId}` : '');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentId] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  const supplierMethods: PaymentType[] = (methods.data ?? []).filter((m) => m.forSuppliers);
  useEffect(() => {
    if (method === '' && supplierMethods[0] !== undefined) setMethod(supplierMethods[0].id);
  }, [supplierMethods, method]);

  const openOrders = useAsync(
    () => (supplier === '' ? Promise.resolve(undefined) : api.orders({ supplierId: supplier, status: 'open', limit: 50 })),
    [supplier],
  );
  const recent = useAsync(() => (supplier === '' ? Promise.resolve(undefined) : api.goodsReceived({ supplierId: supplier, limit: 30 })), [supplier]);

  const chosen = supplierMethods.find((m) => m.id === method);
  const cash = chosen?.isCash === true;
  const amountNum = parseMoney(amount);
  const referenceMissing = !cash && reference.trim() === '';
  const canSubmit = supplier !== '' && amountNum !== null && amountNum > 0 && method !== '' && !referenceMissing && !busy;

  async function submit() {
    if (!canSubmit || amountNum === null) return;
    setBusy(true);
    setError(null);
    try {
      const [kind, id] = forWhat.split(':');
      await api.paySupplier({
        id: paymentId,
        supplierId: supplier,
        amount: amountNum,
        paymentTypeId: method,
        ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
        // Today means "now"; another day is noon on that day, so no time zone can move it to a different date.
        ...(date !== todayLocal() ? { paidAt: new Date(`${date}T12:00:00`).toISOString() } : {}),
        ...(kind === 'po' ? { poId: id ?? null } : {}),
        ...(kind === 'grn' ? { grnId: id ?? null } : {}),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
      return;
    }
    // The money is recorded. Attaching the evidence is a second step: if it fails the payment must not be lost.
    const failed: string[] = [];
    for (const f of files) {
      try {
        await api.attachProof(paymentId, f);
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof ApiError ? e.message : String(e)}`);
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      setError(`The payment was recorded, but ${failed.length} file${failed.length === 1 ? '' : 's'} could not be attached. ${failed.join(' ')} You can attach it again from the payment.`);
      setFiles([]);
      onDone(paymentId);
      return;
    }
    onDone(paymentId);
  }

  return (
    <Modal title="Record a payment to a supplier" onClose={onClose}>
      <div className="space-y-3.5">
        <label className="block">
          <span className={label}>Supplier</span>
          <select value={supplier} disabled={supplierId !== undefined} onChange={(e) => { setSupplier(e.target.value); setForWhat(''); }} className={field} aria-label="Supplier">
            <option value="">Choose a supplier…</option>
            {(suppliers.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>Amount paid</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Amount paid" className={`${field} tnum text-right`} />
          </label>
          <label className="block">
            <span className={label}>Date paid</span>
            <input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} aria-label="Date paid" className={field} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>Paid by</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method" className={field}>
              {supplierMethods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>{cash ? 'Reference (optional)' : 'Reference'}</span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={cash ? '' : method === 'cheque' ? 'Cheque number' : 'Transaction or transfer number'}
              aria-label="Payment reference"
              className={field}
            />
          </label>
        </div>

        <label className="block">
          <span className={label}>What is it for?</span>
          <select value={forWhat} onChange={(e) => setForWhat(e.target.value)} disabled={supplier === ''} aria-label="What the payment is for" className={field}>
            <option value="">On account (no particular order or delivery)</option>
            {(openOrders.data?.items ?? []).length > 0 && (
              <optgroup label="An order not yet complete (a prepayment)">
                {(openOrders.data?.items ?? []).map((o) => (
                  <option key={o.id} value={`po:${o.id}`}>
                    {o.poNo} · {money(o.ordered)}
                  </option>
                ))}
              </optgroup>
            )}
            {(recent.data?.items ?? []).length > 0 && (
              <optgroup label="A delivery already received">
                {(recent.data?.items ?? []).map((g) => (
                  <option key={g.id} value={`grn:${g.id}`}>
                    {g.grnNo} · {money(g.totalCost)}
                    {g.invoiceNo === null ? '' : ` · invoice ${g.invoiceNo}`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="block">
          <span className={label}>Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={field} aria-label="Note" />
        </label>

        <div>
          <span className={label}>Proof of payment (optional)</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,application/pdf"
            aria-label="Proof of payment files"
            onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 5))}
            className="text-ink-600 block w-full text-[12.5px] file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium"
          />
          <p className="text-ink-400 mt-1 text-[11.5px]">A screenshot of the transfer, a photo of the receipt or a PDF. Up to 5 files, 3 MB each.</p>
        </div>

        {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Spinner /> : null}
            Record payment{amountNum !== null && amountNum > 0 ? ` · ${money(amountNum)}` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function PaymentDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const detail = useAsync<PaymentDetail>(() => api.supplierPayment(id), [id]);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = detail.data;

  async function attach(files: FileList | null) {
    if (files === null || p === undefined) return;
    setBusy(true);
    setError(null);
    for (const f of [...files]) {
      try {
        await api.attachProof(p.id, f);
      } catch (e) {
        setError(`${f.name}: ${e instanceof ApiError ? e.message : String(e)}`);
      }
    }
    setBusy(false);
    detail.reload();
    onChanged();
  }

  async function doVoid() {
    if (p === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api.voidPayment(p.id, reason.trim());
      setVoiding(false);
      detail.reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={p === undefined ? 'Payment' : `Payment ${p.paymentNo}`} onClose={onClose} wide>
      {p === undefined ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4" data-testid="payment-detail">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="tnum text-2xl font-semibold">{money(p.amount)}</div>
            {p.voidedAt !== null ? <Badge tone="bad">Voided</Badge> : <Badge tone="good">Paid</Badge>}
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            <dt className="text-ink-500">Supplier</dt>
            <dd className="font-medium">{p.supplierName}</dd>
            <dt className="text-ink-500">Paid by</dt>
            <dd>
              {p.method}
              {p.reference !== null && <span className="text-ink-500"> · reference {p.reference}</span>}
            </dd>
            <dt className="text-ink-500">Date paid</dt>
            <dd>{shortDateTime(p.paidAt)}</dd>
            <dt className="text-ink-500">For</dt>
            <dd>{p.grnNo !== null ? `Delivery ${p.grnNo}` : p.poNo !== null ? `Order ${p.poNo}` : 'On account'}</dd>
            {p.note !== null && (
              <>
                <dt className="text-ink-500">Note</dt>
                <dd>{p.note}</dd>
              </>
            )}
            <dt className="text-ink-500">Recorded by</dt>
            <dd>
              {p.recordedByName} · {shortDateTime(p.recordedAt)}
            </dd>
            {p.voidedAt !== null && (
              <>
                <dt className="text-red-700">Voided</dt>
                <dd className="text-red-700">
                  {p.voidedByName} · {shortDateTime(p.voidedAt)} · {p.voidReason}
                </dd>
              </>
            )}
          </dl>

          <div>
            <h3 className="text-ink-500 mb-2 text-[11px] font-medium uppercase tracking-wider">Proof of payment</h3>
            {p.proofs.length === 0 ? (
              <p className="text-ink-400 rounded-lg border border-dashed px-3 py-4 text-center text-[12.5px]">No proof attached yet.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2" data-testid="proofs">
                {p.proofs.map((f) => (
                  <li key={f.id} className="border-ink-200 overflow-hidden rounded-lg border">
                    {f.contentType.startsWith('image/') ? (
                      <a href={api.proofUrl(f.id)} target="_blank" rel="noreferrer" className="bg-ink-50 block">
                        <img src={api.proofUrl(f.id)} alt={f.fileName} className="mx-auto max-h-44 object-contain" />
                      </a>
                    ) : (
                      <a href={api.proofUrl(f.id)} target="_blank" rel="noreferrer" className="bg-ink-50 text-accent-700 grid h-24 place-items-center text-[13px] font-medium hover:underline">
                        Open PDF
                      </a>
                    )}
                    <div className="px-2.5 py-1.5 text-[11.5px]">
                      <div className="truncate font-medium">{f.fileName}</div>
                      <div className="text-ink-400">
                        {(f.sizeBytes / 1024).toFixed(0)} KB · {p.recordedByName === f.uploadedByName ? '' : `${f.uploadedByName} · `}
                        {shortDateTime(f.uploadedAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {can('supplier.pay') && p.voidedAt === null && p.proofs.length < 5 && (
              <label className="mt-2 block">
                <span className="text-accent-700 cursor-pointer text-[12.5px] font-medium hover:underline">+ Attach a file</span>
                <input type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf" aria-label="Attach proof" className="sr-only" onChange={(e) => void attach(e.target.files)} />
              </label>
            )}
          </div>

          {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}

          {can('supplier.pay') && p.voidedAt === null && (
            <div className="border-ink-100 border-t pt-3">
              {voiding ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className={label}>Why is it being voided?</span>
                    <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for voiding" placeholder="e.g. Entered against the wrong supplier" className={field} />
                  </label>
                  <div className="flex gap-2">
                    <Button variant="danger" onClick={() => void doVoid()} disabled={busy || reason.trim().length < 5}>
                      {busy ? <Spinner /> : null}
                      Void this payment
                    </Button>
                    <Button variant="ghost" onClick={() => setVoiding(false)}>
                      Keep it
                    </Button>
                  </div>
                  <p className="text-ink-400 text-[11.5px]">The amount goes back on what is owed to the supplier. The payment stays on record, marked voided.</p>
                </div>
              ) : (
                <button onClick={() => setVoiding(true)} className="text-[12.5px] text-red-700 hover:underline">
                  Void this payment…
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
