/**
 * Branch-to-branch transfers.
 *
 * Dispatch and receipt are separate actions on this screen because they are
 * separate capabilities at the API - transfer.dispatch and transfer.receive
 * - so the person who sends stock out is never, by construction, the only
 * person who can confirm it arrived (migration 004).
 *
 * The receive form pre-fills "received" with what was dispatched, because
 * that is the common case, but every field is editable: the destination is
 * only ever credited for what this form actually says arrived. A shortfall
 * or an overage raises a costed exception the moment you submit - that is
 * the receiving-variance control HANDOFF asked for, not an afterthought.
 */

import { useState } from 'react';

import { api, ApiError, type Branch, type Product, type TransferDetail, type TransferSummary } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

const STATE_TONE: Record<string, 'neutral' | 'warn' | 'good' | 'bad'> = {
  dispatched: 'warn',
  received: 'good',
  cancelled: 'neutral',
};

export function Transfers() {
  const { can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [state, setState] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const branches = useAsync(() => api.branches(), []);
  const transfers = useAsync(
    () => api.transfers({ ...(branchId === '' ? {} : { branchId }), ...(state === '' ? {} : { state: state as never }) }),
    [branchId, state],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Transfers</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Stock leaves the origin at dispatch. The destination is only ever credited for what is
            confirmed on receipt.
          </p>
        </div>
        {can('transfer.dispatch') && (
          <Button variant="primary" onClick={() => setDispatching((v) => !v)}>
            {dispatching ? 'Cancel' : 'Dispatch stock'}
          </Button>
        )}
      </div>

      {dispatching && (
        <DispatchForm
          branches={branches.data ?? []}
          onDispatched={() => {
            setDispatching(false);
            transfers.reload();
          }}
          onCancel={() => setDispatching(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">All branches</option>
          {(branches.data ?? []).map((b: Branch) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {[
            { value: '', label: 'All' },
            { value: 'dispatched', label: 'In transit' },
            { value: 'received', label: 'Received' },
            { value: 'cancelled', label: 'Cancelled' },
          ].map((tab) => (
            <button
              key={tab.value}
              onClick={() => setState(tab.value)}
              className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition ${
                state === tab.value
                  ? 'bg-ink-900 text-white'
                  : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {transfers.error !== undefined && <ErrorNote error={transfers.error} />}

      <Card className="overflow-hidden">
        {transfers.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : (transfers.data?.items.length ?? 0) === 0 ? (
          <Empty title="No transfers match" />
        ) : (
          <ul className="divide-ink-100 divide-y">
            {(transfers.data?.items ?? []).map((t: TransferSummary) => (
              <li key={t.id}>
                <button
                  onClick={() => setOpenId(openId === t.id ? null : t.id)}
                  className="hover:bg-ink-50/60 flex w-full items-center gap-3 px-4 py-2.5 text-left transition"
                >
                  <svg
                    viewBox="0 0 20 20"
                    className={`text-ink-300 size-3.5 shrink-0 transition-transform ${openId === t.id ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    <path fill="currentColor" d="M7 4l6 6-6 6z" />
                  </svg>
                  <span className="text-ink-400 w-24 shrink-0 font-mono text-[11.5px]">{t.reference}</span>
                  <span className="flex-1 text-[12.5px]">
                    <span className="font-medium">{t.originBranchCode}</span>
                    <span className="text-ink-300 mx-1.5">→</span>
                    <span className="font-medium">{t.destinationBranchCode}</span>
                  </span>
                  <span className="text-ink-400 text-[11.5px]">
                    {t.lineCount} line{t.lineCount === 1 ? '' : 's'}
                  </span>
                  <Badge tone={STATE_TONE[t.state] ?? 'neutral'}>{t.state}</Badge>
                </button>
                {openId === t.id && <Detail id={t.id} onChanged={() => transfers.reload()} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// -- dispatch ------------------------------------------------------------------

interface DraftLine {
  key: number;
  productId: string;
  productName: string;
  sku: string;
  baseUom: string;
  packId: string;
  packs: { id: string; label: string; qtyBase: number }[];
  qtyPacks: string;
}

let draftKey = 0;

function DispatchForm({
  branches,
  onDispatched,
  onCancel,
}: {
  branches: Branch[];
  onDispatched: () => void;
  onCancel: () => void;
}) {
  const [originBranchId, setOriginBranchId] = useState('');
  const [destinationBranchId, setDestinationBranchId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );

  function addLine(p: Product) {
    if (lines.some((l) => l.productId === p.id)) {
      setSearch('');
      return;
    }
    const defaultPack = p.packs.find((pk) => pk.isDefaultSell) ?? p.packs[0];
    setLines((rows) => [
      ...rows,
      {
        key: draftKey++,
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        baseUom: p.baseUom,
        packId: defaultPack?.id ?? '',
        packs: p.packs.map((pk) => ({ id: pk.id, label: pk.label, qtyBase: pk.qtyBase })),
        qtyPacks: '',
      },
    ]);
    setSearch('');
  }

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeLine(key: number) {
    setLines((rows) => rows.filter((r) => r.key !== key));
  }

  const sameBranch = originBranchId !== '' && originBranchId === destinationBranchId;
  const readyLines = lines.filter((l) => {
    const pack = l.packs.find((p) => p.id === l.packId);
    return pack !== undefined && Number(l.qtyPacks) > 0;
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.dispatchTransfer({
        originBranchId,
        destinationBranchId,
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
        lines: readyLines.map((l) => {
          const pack = l.packs.find((p) => p.id === l.packId)!;
          return { productId: l.productId, qtyDispatched: Number(l.qtyPacks) * pack.qtyBase };
        }),
      });
      onDispatched();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <select
              required
              value={originBranchId}
              onChange={(e) => setOriginBranchId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To">
            <select
              required
              value={destinationBranchId}
              onChange={(e) => setDestinationBranchId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {sameBranch && (
          <div className="text-[12px] text-red-600">Origin and destination must be different branches.</div>
        )}

        <div>
          <div className="text-ink-600 mb-1.5 text-[11px] font-medium uppercase tracking-wider">Lines</div>

          {lines.length > 0 && (
            <div className="mb-2 space-y-2">
              {lines.map((line) => {
                const pack = line.packs.find((p) => p.id === line.packId);
                const qtyBase = pack !== undefined && line.qtyPacks !== '' ? Number(line.qtyPacks) * pack.qtyBase : null;
                return (
                  <div
                    key={line.key}
                    className="border-ink-200 grid grid-cols-[1fr_140px_90px_auto_auto] items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5"
                  >
                    <div className="min-w-0 truncate text-[12.5px]">
                      <span className="font-medium">{line.productName}</span>
                      <span className="text-ink-400 ml-1.5 font-mono text-[11px]">{line.sku}</span>
                    </div>
                    <select
                      value={line.packId}
                      onChange={(e) => updateLine(line.key, { packId: e.target.value })}
                      className="text-[12px] outline-none"
                    >
                      {line.packs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0.0001"
                      step="any"
                      placeholder="Qty"
                      value={line.qtyPacks}
                      onChange={(e) => updateLine(line.key, { qtyPacks: e.target.value })}
                      className="tnum text-[12.5px] outline-none"
                    />
                    <span className="text-ink-400 text-[11px]">{qtyBase !== null ? `= ${qty(qtyBase)} ${line.baseUom}` : ''}</span>
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      className="text-ink-300 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="relative max-w-sm">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="+ Add a product…"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
            />
            {results.data !== undefined && results.data.items.length > 0 && (
              <ul className="border-ink-200 absolute left-0 top-full z-10 mt-1 w-full divide-y divide-ink-100 overflow-hidden rounded-lg border bg-white shadow-lg">
                {results.data.items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => addLine(p)}
                      className="hover:bg-ink-50 flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px]"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="text-ink-400 font-mono text-[11px]">{p.sku}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <Field label="Notes (optional)">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Dispatch note, vehicle, driver…"
            className="border-ink-200 focus:border-accent-500 w-full max-w-md rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
          />
        </Field>

        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || sameBranch || readyLines.length === 0 || originBranchId === '' || destinationBranchId === ''}
          >
            {busy ? <Spinner /> : null}
            Dispatch {readyLines.length > 0 ? `(${readyLines.length} line${readyLines.length === 1 ? '' : 's'})` : ''}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}

// -- detail / receive -----------------------------------------------------------

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const detail = useAsync(() => api.transfer(id), [id]);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.loading) {
    return (
      <div className="bg-ink-50/60 grid place-items-center py-8">
        <Spinner />
      </div>
    );
  }
  if (detail.data === undefined) return null;
  const d: TransferDetail = detail.data;

  function receivedValue(line: TransferDetail['lines'][number]): string {
    return received[line.productId] ?? String(line.qtyDispatched);
  }

  async function confirmReceipt() {
    setBusy(true);
    setError(null);
    try {
      await api.receiveTransfer(
        id,
        d.lines.map((l) => ({ productId: l.productId, qtyReceived: Number(receivedValue(l)) })),
      );
      onChanged();
      detail.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelTransfer(id);
      onChanged();
      detail.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canReceive = can('transfer.receive') && d.state === 'dispatched';

  return (
    <div className="bg-ink-50/60 border-ink-100 border-t px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span>
          <span className="text-ink-400">Dispatched by</span> {d.dispatchedByName ?? '—'}
        </span>
        {d.receivedByName !== null && (
          <span>
            <span className="text-ink-400">Received by</span> {d.receivedByName}
          </span>
        )}
        {d.notes !== null && (
          <span>
            <span className="text-ink-400">Notes</span> {d.notes}
          </span>
        )}
      </div>

      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
            <th className="px-2 py-1.5 text-left font-medium">Product</th>
            <th className="px-2 py-1.5 text-right font-medium">Dispatched</th>
            <th className="px-2 py-1.5 text-right font-medium">Received</th>
            <th className="px-2 py-1.5 text-right font-medium">Variance</th>
            <th className="px-2 py-1.5 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-ink-100 divide-y">
          {d.lines.map((line) => (
            <tr key={line.id}>
              <td className="px-2 py-1.5">
                <div className="font-medium">{line.productName}</div>
                <div className="text-ink-400 font-mono text-[11px]">{line.sku}</div>
              </td>
              <td className="tnum px-2 py-1.5 text-right">{qty(line.qtyDispatched)}</td>
              <td className="px-2 py-1.5 text-right">
                {canReceive ? (
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={receivedValue(line)}
                    onChange={(e) => setReceived((r) => ({ ...r, [line.productId]: e.target.value }))}
                    className="tnum border-ink-200 focus:border-accent-500 w-20 rounded border bg-white px-1.5 py-0.5 text-right outline-none"
                  />
                ) : (
                  <span className="tnum">{line.qtyReceived === null ? '—' : qty(line.qtyReceived)}</span>
                )}
              </td>
              <td
                className={`tnum px-2 py-1.5 text-right font-medium ${
                  line.variance === null ? '' : line.variance < 0 ? 'text-red-600' : line.variance > 0 ? 'text-amber-700' : ''
                }`}
              >
                {line.variance === null ? '—' : `${line.variance > 0 ? '+' : ''}${qty(line.variance)}`}
              </td>
              <td className="tnum px-2 py-1.5 text-right">{line.valueImpact === null ? '—' : money(line.valueImpact)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error !== null && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
          {error}
        </div>
      )}

      {d.state === 'dispatched' && can('transfer.receive') && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={() => void confirmReceipt()} disabled={busy}>
            {busy ? <Spinner /> : null}
            Confirm receipt
          </Button>
          <Button variant="danger" onClick={() => void cancel()} disabled={busy}>
            Cancel transfer
          </Button>
        </div>
      )}
    </div>
  );
}
