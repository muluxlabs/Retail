/** Shared presentation primitives and formatters. */

import { useEffect, useState } from 'react';

import type { ExceptionKind } from './api.js';

// -- formatting --------------------------------------------------------------

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : MONEY.format(n);

export const compactMoney = (n: number): string => `$${COMPACT.format(n)}`;

export const qty = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(n);

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Human labels for exception kinds.
 *
 * Written as what happened, not as a database enum. "Sold below zero" tells a
 * branch manager what to look at; "negative_stock_override" does not.
 */
export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  negative_stock_override: 'Sold below zero',
  unlisted_barcode_scan: 'Unlisted barcode scanned',
  backdated_entry: 'Backdated entry',
  count_variance: 'Count variance',
  transit_loss: 'Lost in transit',
  cash_variance: 'Cash variance',
  price_override: 'Price override',
  void_after_tender: 'Void after tender',
  unreviewed_product: 'Product added at the till',
  stock_reset: 'Branch stock set to zero',
};

/**
 * Why each kind matters, shown under the label.
 * Every line traces to a documented failure in the client's own data.
 */
export const EXCEPTION_WHY: Record<ExceptionKind, string> = {
  negative_stock_override: 'Stock was sold that the ledger says did not exist.',
  unlisted_barcode_scan: 'An item not in the master was scanned at the till.',
  backdated_entry: 'Recorded long after it happened, so stock was wrong in between.',
  count_variance: 'Physical count disagreed with the ledger.',
  transit_loss: 'Less arrived than was dispatched.',
  cash_variance: 'Declared cash did not match counted cash.',
  price_override: 'An item was sold away from its list price.',
  void_after_tender: 'A line was voided after payment was taken.',
  unreviewed_product: 'A cashier could not find this item and added it to finish the sale.',
  stock_reset: 'A manager zeroed every product at a branch. It cannot be undone - review the reason given.',
};

// -- primitives --------------------------------------------------------------

export function Card({
  children,
  className = '',
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`bg-white border border-ink-200/80 rounded-xl shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: 'neutral' | 'warn' | 'bad' | 'good' | undefined;
}) {
  const toneRing =
    tone === 'bad'
      ? 'text-red-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'good'
          ? 'text-accent-700'
          : 'text-ink-900';
  return (
    <Card className="px-4 py-3.5">
      <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">{label}</div>
      <div className={`tnum mt-1.5 text-2xl font-semibold tracking-tight ${toneRing}`}>{value}</div>
      {hint !== undefined && <div className="text-ink-400 mt-1 text-xs">{hint}</div>}
    </Card>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'bad' | 'good' | 'info';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-100 text-ink-600 ring-ink-200',
    warn: 'bg-amber-50 text-amber-800 ring-amber-200',
    bad: 'bg-red-50 text-red-700 ring-red-200',
    good: 'bg-accent-50 text-accent-700 ring-accent-300/60',
    info: 'bg-blue-50 text-blue-700 ring-blue-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const variants: Record<string, string> = {
    primary: 'bg-accent-600 text-white hover:bg-accent-700 shadow-sm',
    secondary: 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
    ghost: 'text-ink-500 hover:text-ink-800 hover:bg-ink-100',
    danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <div className="border-ink-300 border-t-accent-600 size-4 animate-spin rounded-full border-2" />
  );
}

/** Honest empty state: says what would appear here, not just "no data". */
export function Empty({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="text-ink-600 text-sm font-medium">{title}</div>
      {hint !== undefined && <div className="text-ink-400 mx-auto mt-1 max-w-md text-xs">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-800">
      <span className="font-medium">Could not load.</span> {message}
    </div>
  );
}

// -- data fetching -----------------------------------------------------------

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal fetch-on-mount hook.
 *
 * Deliberately not a data-fetching library: this app has a handful of screens
 * and adding one would be a dependency to maintain for no benefit yet.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    fn()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
