/**
 * Scan, say how many, next. For receiving a delivery and for counting stock:
 * scan a box (USB scanner, or the camera), type the total - 100 cases - and
 * press Enter; the scan box is ready for the next item straight away.
 *
 * A barcode belongs to one pack, so scanning a case's barcode counts cases:
 * the screen using this turns packs into units. "Each scan counts 1" skips the
 * quantity for scanning box after box. Undo takes back the last entry.
 */

import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api.js';
import { parseCountText } from '../lib/countText.js';
import { qty } from '../lib/ui.js';
import { ScanButton } from './ScanButton.js';

export interface ScanHit {
  code: string;
  productId: string;
  productName: string;
  sku: string;
  packId: string;
  packLabel: string;
  qtyBase: number;
}

interface Entry {
  key: number;
  hit: ScanHit;
  n: number;
}

let entryKey = 0;

function readOnePerScan(storeKey: string): boolean {
  try {
    return localStorage.getItem(`scanqty.onePerScan.${storeKey}`) === 'yes';
  } catch {
    return false;
  }
}

export function ScanQty({
  storeKey,
  title,
  onAdd,
  disabled = false,
}: {
  /** Remembers "each scan counts 1" per screen. */
  storeKey: string;
  title: string;
  /** n packs of hit's pack; negative to take back an entry. */
  onAdd: (hit: ScanHit, n: number) => void;
  disabled?: boolean;
}) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<ScanHit | null>(null);
  const [n, setN] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onePerScan, setOnePerScan] = useState(() => readOnePerScan(storeKey));
  const [history, setHistory] = useState<Entry[]>([]);
  const scanRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  /** Set when the scan box should take the cursor as soon as it is back on screen (after an entry or a cancel). */
  const backToScan = useRef(false);
  useEffect(() => {
    if (pending !== null) qtyRef.current?.focus();
    else if (backToScan.current) {
      backToScan.current = false;
      scanRef.current?.focus();
    }
  }, [pending]);

  function commit(hit: ScanHit, count: number, clearCode = true) {
    onAdd(hit, count);
    setHistory((h) => [{ key: entryKey++, hit, n: count }, ...h].slice(0, 8));
    backToScan.current = true;
    setPending(null);
    setN('');
    // Box after box: the scanner may already be typing the next code, so it is left alone.
    if (clearCode) setCode('');
    scanRef.current?.focus();
  }

  /** Every scan is looked up, even one that arrives while the last is still being looked up: none is dropped. */
  const inFlight = useRef(0);
  async function lookUp(raw?: string) {
    const c = (raw ?? code).trim();
    if (c === '') return;
    // Cleared at once, so a slow answer never wipes the next code a scanner is already typing.
    setCode('');
    inFlight.current += 1;
    setBusy(true);
    setError(null);
    try {
      const r = await api.resolveBarcode(c);
      const hit: ScanHit = { code: c, productId: r.productId, productName: r.productName, sku: r.sku, packId: r.packId, packLabel: r.packLabel, qtyBase: Number(r.qtyBase) };
      if (onePerScan) commit(hit, 1, false);
      else setPending(hit);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? `“${c}” is not in the item master. Add it there, or count it by name below.` : e instanceof ApiError ? e.message : String(e));
      scanRef.current?.focus();
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setBusy(false);
    }
  }

  function confirmQty() {
    if (pending === null) return;
    const text = n.trim() === '' ? '1' : n;
    const parsed = parseCountText(text);
    if (!parsed.ok || parsed.value <= 0) {
      setError(parsed.ok ? 'Enter how many, more than zero.' : parsed.reason);
      return;
    }
    setError(null);
    commit(pending, parsed.value);
  }

  function undo(entry: Entry) {
    onAdd(entry.hit, -entry.n);
    setHistory((h) => h.filter((e) => e.key !== entry.key));
  }

  const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-3 py-2 text-[13px] outline-none';

  return (
    <div className="border-accent-300/60 bg-accent-50/40 rounded-xl border px-3.5 py-3" data-testid="scan-qty">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12.5px] font-semibold">{title}</div>
        <label className="text-ink-600 flex items-center gap-1.5 text-[12px]">
          <input
            type="checkbox"
            checked={onePerScan}
            onChange={(e) => {
              setOnePerScan(e.target.checked);
              try {
                localStorage.setItem(`scanqty.onePerScan.${storeKey}`, e.target.checked ? 'yes' : 'no');
              } catch {
                /* a convenience only */
              }
            }}
            className="accent-accent-600 size-3.5"
          />
          Each scan counts 1 (scan box after box)
        </label>
      </div>

      {pending === null ? (
        <div className="mt-2 flex gap-2">
          <input
            ref={scanRef}
            value={code}
            disabled={disabled}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void lookUp();
              }
            }}
            placeholder="Scan or type a barcode, then Enter…"
            aria-label="Scan a barcode"
            className={`${field} min-w-0 flex-1 font-mono`}
          />
          <ScanButton onCode={(c) => void lookUp(c)} label="Scan with the camera" />
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="scan-pending">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{pending.productName}</div>
            <div className="text-ink-500 text-[11.5px]">
              {pending.packLabel}
              {pending.qtyBase !== 1 && ` (${qty(pending.qtyBase)} each)`} · {pending.sku}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <span className="text-ink-600">How many {pending.packLabel === 'single' ? '' : `${pending.packLabel}`}?</span>
            <input
              ref={qtyRef}
              inputMode="decimal"
              value={n}
              onChange={(e) => setN(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmQty();
                }
                if (e.key === 'Escape') {
                  backToScan.current = true;
                  setPending(null);
                }
              }}
              placeholder="1"
              aria-label="How many"
              className={`${field} tnum w-24 text-right`}
            />
          </label>
          <button type="button" onClick={confirmQty} className="bg-accent-600 hover:bg-accent-700 rounded-lg px-3 py-2 text-[12.5px] font-medium text-white">
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              backToScan.current = true;
              setPending(null);
            }}
            className="text-ink-500 hover:text-ink-800 text-[12px]"
          >
            Cancel
          </button>
        </div>
      )}

      {error !== null && <p className="mt-1.5 text-[12px] text-red-700">{error}</p>}

      {history.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="scan-history">
          {history.map((e) => (
            <li key={e.key} className="text-ink-600 flex items-center gap-2 text-[12px]">
              <span className="text-accent-700">✓</span>
              <span className="min-w-0 flex-1 truncate">
                {qty(e.n)} × {e.hit.packLabel} · {e.hit.productName}
                {e.hit.qtyBase !== 1 && <span className="text-ink-400"> = {qty(e.n * e.hit.qtyBase)} units</span>}
              </span>
              <button type="button" onClick={() => undo(e)} className="text-ink-400 hover:text-red-600 text-[11.5px]">
                undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
