/**
 * Sell / stock out.
 *
 * Two controls from HANDOFF live directly on this screen, not as an
 * afterthought:
 *
 *   - scanning something not in the master used to pass silently, which is
 *     how under-the-counter selling stayed invisible (section 2.7). Here an
 *     unresolved barcode is a dead end that turns into a work item with one
 *     click, not a shrug.
 *   - overriding a sale that would take stock negative is the "override to
 *     their own benefit" problem, verbatim. A cashier cannot grant it to
 *     themselves: the button only exists for someone who already holds
 *     stock.override, matching what the API enforces server-side regardless.
 */

import { useEffect, useRef, useState } from 'react';

import { api, ApiError, type Branch } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Spinner, qty, useAsync } from '../lib/ui.js';

interface Resolved {
  code: string;
  productId: string;
  productName: string;
  packId: string;
  qtyBase: number;
}

interface SoldLine {
  productName: string;
  qtyPacks: number;
  qtyAfter: number;
  overridden: boolean;
}

export function Sell() {
  const { user, can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [code, setCode] = useState('');
  const [qtyPacks, setQtyPacks] = useState('1');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ available: number; requested: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sold, setSold] = useState<SoldLine[]>([]);
  const [loggedScan, setLoggedScan] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const branches = useAsync(() => api.branches(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [resolved]);

  async function lookUp() {
    const trimmed = code.trim();
    if (trimmed === '') return;
    setResolved(null);
    setNotFound(null);
    setBlocked(null);
    setError(null);
    setLoggedScan(false);
    try {
      const r = await api.resolveBarcode(trimmed);
      setResolved({
        code: r.code,
        productId: r.productId,
        productName: r.productName,
        packId: r.packId,
        qtyBase: r.qtyBase,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(trimmed);
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    }
  }

  async function logScan() {
    if (notFound === null || user === null) return;
    setBusy(true);
    try {
      await api.logUnlistedScan({ code: notFound, branchId, actorId: user.personId });
      setLoggedScan(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitSale(override: boolean) {
    if (resolved === null || user === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.sell({
        barcode: resolved.code,
        qtyPacks: Number(qtyPacks),
        branchId,
        actorId: user.personId,
        ...(override ? { overrideNegative: true, overrideBy: user.personId } : {}),
      });
      setSold((rows) => [
        { productName: resolved.productName, qtyPacks: Number(qtyPacks), qtyAfter: result.qtyAfter, overridden: override },
        ...rows,
      ]);
      setBlocked(null);
      setResolved(null);
      setCode('');
      setQtyPacks('1');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NEGATIVE_STOCK_BLOCKED') {
        setBlocked({
          available: Number(e.detail['available'] ?? 0),
          requested: Number(e.detail['requested'] ?? 0),
        });
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sell / stock out</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Scan or type a barcode. An unresolved code is logged, not ignored.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="px-4 py-4">
          <label className="mb-4 block max-w-xs">
            <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Branch
            </span>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select a branch…</option>
              {(branches.data ?? []).map((b: Branch) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          {branchId === '' ? (
            <p className="text-ink-400 text-[12.5px]">Choose a branch to start selling.</p>
          ) : (
            <div className="space-y-3.5">
              <div className="flex items-end gap-3">
                <label className="block flex-1">
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Barcode
                  </span>
                  <input
                    ref={inputRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void lookUp();
                      }
                    }}
                    placeholder="Scan or type…"
                    className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 font-mono text-[14px] outline-none"
                  />
                </label>
                <label className="block w-24">
                  <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
                    Qty
                  </span>
                  <input
                    type="number"
                    min="0.0001"
                    step="any"
                    value={qtyPacks}
                    onChange={(e) => setQtyPacks(e.target.value)}
                    className="tnum border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-2 text-[14px] outline-none"
                  />
                </label>
                <Button onClick={() => void lookUp()} disabled={code.trim() === ''}>
                  Look up
                </Button>
              </div>

              {notFound !== null && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-amber-900">
                    “{notFound}” is not in the item master.
                  </div>
                  <p className="mt-0.5 text-amber-800/80">
                    The old system let this pass silently. Logging it turns the scan into evidence
                    a controller can act on.
                  </p>
                  {loggedScan ? (
                    <Badge tone="good">Logged</Badge>
                  ) : (
                    <Button onClick={() => void logScan()} disabled={busy} className="mt-2">
                      Log as unlisted scan
                    </Button>
                  )}
                </div>
              )}

              {resolved !== null && (
                <div className="border-accent-200 bg-accent-50/60 rounded-lg border px-3.5 py-3">
                  <div className="text-[13px] font-medium">{resolved.productName}</div>
                  <div className="text-ink-500 mt-0.5 text-[11.5px]">
                    {qty(resolved.qtyBase)} base units per unit scanned · {resolved.code}
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <Button variant="primary" onClick={() => void submitSale(false)} disabled={busy}>
                      {busy ? <Spinner /> : null}
                      Sell {qtyPacks || '1'}
                    </Button>
                    <button
                      onClick={() => setResolved(null)}
                      className="text-ink-400 hover:text-ink-700 text-[12px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {blocked !== null && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-[12.5px]">
                  <div className="font-medium text-red-800">
                    Insufficient stock: {qty(blocked.available)} on hand, {qty(blocked.requested)}{' '}
                    requested.
                  </div>
                  {can('stock.override') ? (
                    <>
                      <p className="mt-0.5 text-red-700/80">
                        You hold override authority. This will be logged as an open exception.
                      </p>
                      <Button
                        variant="danger"
                        onClick={() => void submitSale(true)}
                        disabled={busy}
                        className="mt-2"
                      >
                        Authorise and sell anyway
                      </Button>
                    </>
                  ) : (
                    <p className="mt-0.5 text-red-700/80">
                      Overriding this requires manager authorisation. Ask a branch manager to sign
                      in and complete this sale.
                    </p>
                  )}
                </div>
              )}

              {error !== null && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
                  {error}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-ink-100 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-tight">This session</h2>
          </div>
          {sold.length === 0 ? (
            <p className="text-ink-400 px-4 py-6 text-center text-[12px]">Nothing sold yet.</p>
          ) : (
            <ul className="divide-ink-100 divide-y">
              {sold.map((line, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                  <span className="text-red-600 tnum w-10 shrink-0 font-medium">
                    -{qty(line.qtyPacks)}
                  </span>
                  <span className="text-ink-600 min-w-0 flex-1 truncate">{line.productName}</span>
                  {line.overridden && <Badge tone="warn">override</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
