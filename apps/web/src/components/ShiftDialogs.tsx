/**
 * Opening and closing a cashier's shift. Both are blind counts: the screen asks
 * what is in the till and never says what the books expect, so the count is
 * honest. Any difference is posted to the till and raised as an exception.
 */

import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api.js';
import { parseMoney } from '../lib/basketMath.js';
import { Button, Spinner, money } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-label={title}>
      <div className="my-6 w-full max-w-sm rounded-xl bg-white shadow-xl">
        <div className="border-ink-100 flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-800 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function CountForm({
  prompt,
  action,
  onClose,
  submit,
}: {
  prompt: string;
  action: string;
  onClose: () => void;
  submit: (counted: number, note: string | null) => Promise<void>;
}) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amt = parseMoney(counted);
  const ok = counted.trim() !== '' && amt !== null && amt >= 0 && !busy;

  async function go() {
    if (amt === null) return;
    setBusy(true);
    setError(null);
    try {
      await submit(amt, note.trim() === '' ? null : note.trim());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-ink-600 text-[12.5px]">{prompt}</p>
      <label className="block">
        <span className={label}>Cash counted</span>
        <input
          autoFocus
          inputMode="decimal"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ok && void go()}
          aria-label="Cash counted"
          placeholder="0.00"
          className={`${field} tnum text-right text-[15px]`}
        />
      </label>
      <label className="block">
        <span className={label}>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" className={field} />
      </label>
      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void go()} disabled={!ok}>
          {busy ? <Spinner /> : null}
          {action}
          {amt !== null && counted.trim() !== '' ? ` · ${money(amt)}` : ''}
        </Button>
      </div>
    </>
  );
}

export function OpenShiftDialog({
  branchId,
  tillId,
  tillName,
  onClose,
  onDone,
}: {
  branchId: string;
  tillId: string;
  tillName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  return (
    <Shell title={`Open your shift on ${tillName}`} onClose={onClose}>
      <CountForm
        prompt={`Count the cash in ${tillName} before you start. From now until you close, the till is yours: nobody else can sell on it.`}
        action="Open shift"
        onClose={onClose}
        submit={async (counted, note) => {
          await api.openShift({ id, branchId, cashPointId: tillId, counted, note });
          onDone();
        }}
      />
    </Shell>
  );
}

export function CloseShiftDialog({
  shiftId,
  shiftNo,
  tillName,
  cashierName,
  onClose,
  onDone,
}: {
  shiftId: string;
  shiftNo: string;
  tillName: string;
  cashierName?: string;
  onClose: () => void;
  onDone: (r: { id: string; variance: number }) => void;
}) {
  return (
    <Shell title={`Close shift ${shiftNo}`} onClose={onClose}>
      <CountForm
        prompt={`Count all the cash in ${tillName}${cashierName === undefined ? '' : ` (${cashierName}'s shift)`}. You will see whether it matches once the count is in.`}
        action="Close shift"
        onClose={onClose}
        submit={async (counted, note) => {
          const r = await api.closeShift(shiftId, { counted, note });
          onDone(r);
        }}
      />
    </Shell>
  );
}
