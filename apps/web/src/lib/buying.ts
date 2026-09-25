/**
 * The words the buying screens use, in one place, so a supplier's terms, an
 * order's status and a payment's timing read the same on every screen and
 * in the vocabulary an accountant expects.
 */

import type { PaymentTiming, PoStatus, SupplierTerms } from './api.js';

export const TERMS_LABEL: Record<SupplierTerms, string> = {
  prepaid: 'Prepaid',
  cash_on_delivery: 'Cash on delivery',
  credit: 'On credit',
};

export const TERMS_HELP: Record<SupplierTerms, string> = {
  prepaid: 'Paid before the goods are sent',
  cash_on_delivery: 'Paid when the goods arrive',
  credit: 'Paid some days after the goods arrive',
};

export function termsText(terms: SupplierTerms, creditDays: number | null): string {
  return terms === 'credit' ? `On credit · ${creditDays ?? 0} days` : TERMS_LABEL[terms];
}

export const PO_STATUS: Record<PoStatus, { label: string; tone: 'neutral' | 'info' | 'good' | 'warn' | 'bad' }> = {
  ordered: { label: 'Ordered', tone: 'info' },
  part_received: { label: 'Part received', tone: 'warn' },
  received: { label: 'Received', tone: 'good' },
  closed: { label: 'Closed short', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

export const TIMING: Record<PaymentTiming, { label: string; tone: 'neutral' | 'info' | 'good' | 'warn' }> = {
  prepaid: { label: 'Prepaid', tone: 'info' },
  on_delivery: { label: 'Paid on delivery', tone: 'good' },
  after_delivery: { label: 'Paid after delivery', tone: 'neutral' },
  on_account: { label: 'On account', tone: 'neutral' },
};

export const PO_PAYMENT: Record<'unpaid' | 'part_paid' | 'paid', { label: string; tone: 'bad' | 'warn' | 'good' }> = {
  unpaid: { label: 'Unpaid', tone: 'bad' },
  part_paid: { label: 'Part paid', tone: 'warn' },
  paid: { label: 'Paid', tone: 'good' },
};

/** A calendar date from an ISO instant or a date string, as the shop reads it: 25 Sep 2026. */
export function shortDate(value: string | null | undefined, timeZone?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = value.length === 10 ? new Date(`${value}T00:00:00Z`) : new Date(value);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: value.length === 10 ? 'UTC' : timeZone });
}

export function shortDateTime(value: string): string {
  return new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** What a balance with a supplier means, in words. */
export function balanceWords(balance: number): string {
  if (balance > 0.004) return 'We owe the supplier';
  if (balance < -0.004) return 'The supplier holds our money (prepaid)';
  return 'Nothing owed';
}

/**
 * A price per pack, shown as agreed: at least two decimal places, up to four
 * ($13.50, $0.335). A supplier's price is not always whole cents, and rounding
 * one for display ($0.335 as $0.34) would contradict the figure it was typed as.
 */
export function packCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const fixed = n.toFixed(4).replace(/(\.\d\d)00$/, '$1').replace(/(\.\d\d\d)0$/, '$1');
  const [whole = '0', frac = '00'] = fixed.split('.');
  return `$${Number(whole).toLocaleString('en-US')}.${frac}`;
}
