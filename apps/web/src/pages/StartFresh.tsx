/**
 * Start a branch fresh: set every product at a branch to zero.
 *
 * Nothing is deleted - each product gets one offsetting movement and the
 * history stays - but there is no undo, so this is built to be hard to do by
 * accident and impossible to do without having read what it will do:
 *
 *   - the button does not exist until the numbers are on screen
 *   - a written reason is required (it goes to the auditor)
 *   - the branch code has to be typed back
 *   - an "I understand" box
 *   - the server re-reads the stock at the instant of the reset and refuses
 *     if it differs from the figures shown here
 *
 * Gated on stock.reset. A person tied to one branch only ever sees their own;
 * the API enforces that regardless of what this screen offers.
 */

import { useState } from 'react';

import { api, ApiError, type ResetResult } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Card, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

export function StartFresh() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ResetResult | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const scoped = user?.branchIds ?? [];
  const choices = (branches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));

  const preview = useAsync(
    () => (open && branchId !== '' ? api.stockResetPreview(branchId) : Promise.resolve(null)),
    [open, branchId],
  );
  const p = preview.data ?? null;

  function close() {
    setOpen(false);
    setBranchId('');
    setReason('');
    setTyped('');
    setUnderstood(false);
    setError(null);
    setDone(null);
  }

  function pickBranch(id: string) {
    setBranchId(id);
    setTyped('');
    setUnderstood(false);
    setError(null);
  }

  const codeMatches = p !== null && typed.trim().toUpperCase() === p.branchCode.toUpperCase();
  const canSubmit = p !== null && p.resettable > 0 && reason.trim().length >= 10 && codeMatches && understood && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (p === null || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      setDone(
        await api.resetBranchStock(p.branchId, {
          confirmCode: typed.trim(),
          reason: reason.trim(),
          expectedPositions: p.resettable,
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      // Stock moved since it was shown: show the new figures, and make them re-confirm.
      if (e instanceof ApiError && e.code === 'STOCK_RESET_STALE') {
        preview.reload();
        setTyped('');
        setUnderstood(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Card className="border-red-200/80 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 max-w-xl">
            <h2 className="text-[13px] font-semibold tracking-tight">Start a branch fresh</h2>
            <p className="text-ink-500 mt-0.5 text-[12.5px]">
              Set every product at a branch to zero - for a branch opening new books. It cannot be
              undone.
            </p>
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Set a branch to zero…
          </Button>
        </div>
      </Card>
    );
  }

  if (done !== null) {
    return (
      <Card className="border-ink-200 px-4 py-4">
        {done.docId === null ? (
          <p className="text-[13px]">
            {done.branchName} was already at zero - nothing was changed.
          </p>
        ) : (
          <>
            <h2 className="text-[13px] font-semibold tracking-tight">
              {done.branchName} is now at zero
            </h2>
            <p className="text-ink-600 mt-1 text-[12.5px]">
              {qty(done.resettable)} products were set to zero ({money(done.valueAtCost)} of stock
              at cost). The reset is in the ledger as “stock reset” and has been raised in the
              Exceptions queue for review.
              {done.skippedMerged > 0 &&
                ` ${done.skippedMerged} merged product${done.skippedMerged === 1 ? '' : 's'} with stock could not be changed and ${done.skippedMerged === 1 ? 'was' : 'were'} left as they are.`}
            </p>
            <p className="text-ink-500 mt-1 text-[12.5px]">
              Receive stock or run a Count to enter the branch’s opening quantities.
            </p>
          </>
        )}
        <Button className="mt-3" onClick={close}>
          Close
        </Button>
      </Card>
    );
  }

  return (
    <Card className="border-red-300 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight text-red-800">
            Set every product at a branch to zero
          </h2>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">Read this through - it cannot be undone.</p>
        </div>
        <button onClick={close} className="text-ink-400 hover:text-ink-700 text-[12px]">
          Cancel
        </button>
      </div>

      <label className="mt-4 block max-w-xs">
        <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
          Branch
        </span>
        <select
          value={branchId}
          onChange={(e) => pickBranch(e.target.value)}
          className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">Select a branch…</option>
          {choices.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>

      {preview.error !== undefined && (
        <div className="mt-3">
          <ErrorNote error={preview.error} />
        </div>
      )}

      {branchId !== '' && preview.loading && p === null && (
        <div className="grid place-items-center py-8">
          <Spinner />
        </div>
      )}

      {p !== null && p.resettable === 0 && (
        <p className="text-ink-600 mt-4 text-[12.5px]">
          Every product at {p.branchName} is already at zero. There is nothing to reset.
          {p.skippedMerged > 0 &&
            ` (${p.skippedMerged} merged product${p.skippedMerged === 1 ? '' : 's'} still hold stock but cannot be changed.)`}
        </p>
      )}

      {p !== null && p.resettable > 0 && (
        <form onSubmit={submit} className="mt-4 space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Products to zero" value={qty(p.resettable)} />
            <Fact label="Units on the shelf" value={qty(p.unitsOnHand)} />
            <Fact label="Units below zero" value={qty(p.unitsBelowZero)} />
            <Fact label="Stock value at cost" value={money(p.valueAtCost)} />
          </dl>

          <ul className="text-ink-700 list-disc space-y-1 pl-5 text-[12.5px]">
            <li>
              Each product gets one movement that takes it to exactly zero, dated now. Nothing is
              deleted: the history stays in the ledger and reports show it as “stock reset”, not
              as loss.
            </li>
            <li>
              <span className="font-medium text-red-800">There is no undo.</span> To get quantities
              back, they have to be entered again with Receive or Count.
            </li>
            <li>It is raised as an exception naming you and your reason, for an auditor to review.</li>
            <li>
              Sales in progress at this branch finish first. After that, nothing sells there until
              it has been received again.
            </li>
            {p.withoutCost > 0 && (
              <li>
                {qty(p.withoutCost)} of these positions have no cost on record, so the value above
                leaves them out.
              </li>
            )}
            {p.skippedMerged > 0 && (
              <li>
                {qty(p.skippedMerged)} merged product{p.skippedMerged === 1 ? '' : 's'} still hold
                stock but accept no movements, so {p.skippedMerged === 1 ? 'it is' : 'they are'} left out.
              </li>
            )}
          </ul>

          <label className="block">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Why are you doing this?
            </span>
            <textarea
              required
              minLength={10}
              maxLength={500}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Branch opening fresh books for the new financial year."
              className="border-ink-200 focus:border-accent-500 w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>

          <label className="block max-w-xs">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Type <span className="font-mono text-red-800">{p.branchCode}</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed !== '' && !codeMatches}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 font-mono text-[13px] outline-none"
            />
          </label>

          <label className="flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="accent-accent-600 mt-0.5 size-3.5"
            />
            <span>
              I understand this sets {qty(p.resettable)} products at {p.branchName} to zero and
              cannot be undone.
            </span>
          </label>

          {error !== null && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="danger" disabled={!canSubmit}>
              {busy ? <Spinner /> : null}
              Set {qty(p.resettable)} products to zero
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-50 rounded-lg px-3 py-2">
      <dt className="text-ink-500 text-[10.5px] font-medium uppercase tracking-wider">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tracking-tight">{value}</dd>
    </div>
  );
}
