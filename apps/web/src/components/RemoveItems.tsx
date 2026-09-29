/**
 * Removing items, with the consequences shown first.
 *
 * The server sorts the chosen items: never used -> deleted for good; with
 * history -> archived (hidden from the till and lists, restorable, history
 * kept). Nothing happens until the person types how many items they chose.
 */

import { useEffect, useState } from 'react';

import { api, ApiError, type RemovalPreview } from '../lib/api.js';
import { Button, qty, Spinner } from '../lib/ui.js';

export function RemoveItemsDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (message: string) => void }) {
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .previewRemoval(ids)
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [ids]);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.removeItems({ ids, confirmCount: Number(typed), ...(note.trim() === '' ? {} : { note: note.trim() }) });
      const parts = [];
      if (r.deleted.length > 0) parts.push(`${r.deleted.length} deleted`);
      if (r.archived.length > 0) parts.push(`${r.archived.length} archived`);
      onDone(`${parts.join(' and ') || 'Nothing changed'}.${r.reviewRaised ? ' Sent to the exception queue for review.' : ''}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  const del = preview?.items.filter((i) => i.action === 'delete') ?? [];
  const arc = preview?.items.filter((i) => i.action === 'archive') ?? [];
  const already = preview?.items.filter((i) => i.action === 'already-archived') ?? [];
  const show = <T,>(list: T[]) => list.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Remove items" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-ink-100 border-b px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">
            Remove {ids.length} item{ids.length === 1 ? '' : 's'}
          </h2>
          <p className="text-ink-500 mt-0.5 text-[12px]">Items never used are deleted. Items with history are archived: the history stays, and they can be restored.</p>
        </div>

        {preview === null ? (
          <div className="grid place-items-center py-10">{error === null ? <Spinner /> : <p className="px-5 text-[12.5px] text-red-700">{error}</p>}</div>
        ) : (
          <div className="space-y-3 px-5 py-4 text-[12.5px]" data-testid="removal-preview">
            {del.length > 0 && (
              <section>
                <div className="font-semibold text-red-700">Delete for good: {del.length}</div>
                <p className="text-ink-500 text-[11.5px]">Never sold, received, ordered or counted - a typo or a test. A copy stays in the audit log.</p>
                <ul className="text-ink-700 mt-1 list-disc pl-5">
                  {show(del).map((i) => (
                    <li key={i.id}>
                      {i.name} <span className="text-ink-400 font-mono text-[11px]">{i.sku}</span>
                    </li>
                  ))}
                  {del.length > 8 && <li className="text-ink-400">and {del.length - 8} more</li>}
                </ul>
              </section>
            )}
            {arc.length > 0 && (
              <section>
                <div className="font-semibold text-amber-800">Archive: {arc.length}</div>
                <p className="text-ink-500 text-[11.5px]">
                  They have history, so they are hidden rather than erased: gone from the till, the item master and searches; every past receipt and
                  report stays as it was. Restore any of them later from “Show archived”.
                </p>
                <ul className="text-ink-700 mt-1 list-disc pl-5">
                  {show(arc).map((i) => (
                    <li key={i.id}>
                      {i.name} <span className="text-ink-400">- {i.reason}</span>
                      {i.onHand !== 0 && <span className="font-medium text-amber-800"> · {qty(i.onHand)} still in stock</span>}
                    </li>
                  ))}
                  {arc.length > 8 && <li className="text-ink-400">and {arc.length - 8} more</li>}
                </ul>
              </section>
            )}
            {already.length > 0 && <p className="text-ink-500">{already.length} already archived - left as they are.</p>}
            {preview.withStock > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                {preview.withStock} of the items to archive still show stock on hand. If it is really on the shelf, count it or transfer it before archiving;
                archived items cannot be sold.
              </p>
            )}
            {ids.length >= preview.reviewAt && (
              <p className="text-ink-600 rounded-lg bg-ink-50 px-3 py-2">Removing {preview.reviewAt} or more items at once is sent to the exception queue for a second person to review.</p>
            )}
            <label className="block">
              <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Why (optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. test items from the first import" className="border-ink-200 focus:border-accent-500 w-full rounded-lg border px-2.5 py-1.5 outline-none" aria-label="Why" />
            </label>
            <label className="block">
              <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Type {ids.length} to confirm</span>
              <input
                inputMode="numeric"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="border-ink-200 focus:border-accent-500 tnum w-28 rounded-lg border px-2.5 py-1.5 outline-none"
                aria-label="Type the number of items to confirm"
              />
            </label>
            {error !== null && <p className="text-red-700">{error}</p>}
          </div>
        )}

        <div className="border-ink-100 flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={preview === null || busy || typed.trim() !== String(ids.length) || del.length + arc.length === 0} onClick={() => void go()}>
            {busy ? <Spinner /> : null}
            {[del.length > 0 ? `Delete ${del.length}` : null, arc.length > 0 ? `archive ${arc.length}` : null].filter(Boolean).join(' and ') || 'Nothing to remove'}
          </Button>
        </div>
      </div>
    </div>
  );
}
