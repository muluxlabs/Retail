/**
 * The vocabulary of the screens, in accounting terms.
 *
 * Every place that shows a stock or cash movement's reason, or a document type,
 * goes through here - never through a raw database value with the underscores
 * swapped for spaces. That habit is how "opening balance" ended up in front of
 * an auditor as an ordinary row in a list. In accounts an opening balance is
 * the balance at the START of a period; what the database calls
 * 'opening_balance' is the entry that introduced stock onto the system, and it
 * is named for what it is.
 *
 * `label` is the full name (ledger, tooltips); `short` fits a narrow column.
 */

export interface Term {
  label: string;
  short: string;
  /** One sentence an auditor or a new employee can read without asking. */
  meaning: string;
}

/** Stock movement reasons. Keys mirror the database enum. */
export const STOCK_REASON_TERMS: Record<string, Term> = {
  grn: {
    label: 'Goods received (purchase)',
    short: 'Purchase',
    meaning: 'Stock received from a supplier, at cost.',
  },
  grn_reversal: {
    label: 'Purchase return',
    short: 'Purchase return',
    meaning: 'A receipt cancelled, or goods sent back to the supplier.',
  },
  sale: {
    label: 'Sale',
    short: 'Sale',
    meaning: 'Stock issued to a customer at the till.',
  },
  sale_refund: {
    label: 'Sales return',
    short: 'Sales return',
    meaning: 'Stock returned to us by a customer.',
  },
  transfer_out: {
    label: 'Transfer out (inter-branch)',
    short: 'Transfer out',
    meaning: 'Stock leaving this branch for another.',
  },
  transfer_in: {
    label: 'Transfer in (inter-branch)',
    short: 'Transfer in',
    meaning: 'Stock arriving from another branch.',
  },
  transfer_loss: {
    label: 'Loss in transit',
    short: 'Loss in transit',
    meaning: 'The shortfall between what was dispatched and what arrived.',
  },
  count_adjustment: {
    label: 'Stock take adjustment',
    short: 'Stock take adj.',
    meaning:
      'The difference between the quantity counted and the quantity in the books, posted after a physical count. A surplus adds stock; a shortage removes it.',
  },
  write_off: {
    label: 'Stock write-off',
    short: 'Write-off',
    meaning: 'Stock removed because it was damaged, expired or lost.',
  },
  opening_balance: {
    label: 'Opening stock introduced',
    short: 'Opening stock',
    meaning:
      'Stock brought onto the system when trading began here. This is a transaction, not a balance: the opening BALANCE of any period is worked out from everything before it.',
  },
  stock_reset: {
    label: 'Stock cleared to nil (branch restart)',
    short: 'Cleared to nil',
    meaning: 'A manager set every product at the branch to zero to start afresh. The history before it is kept.',
  },
};

/** Cash movement reasons. Keys mirror the cash_reason enum. */
export const CASH_REASON_TERMS: Record<string, Term> = {
  opening_balance: {
    label: 'Opening cash introduced',
    short: 'Opening cash',
    meaning: 'Cash brought onto the system at a custody point when it was set up.',
  },
  float_issue: {
    label: 'Float issued to till',
    short: 'Float issued',
    meaning: 'Cash moved from the safe to a till at the start of a shift.',
  },
  float_return: {
    label: 'Float returned to safe',
    short: 'Float returned',
    meaning: 'Cash moved from a till back to the safe at the end of a shift.',
  },
  bank_deposit: {
    label: 'Banked',
    short: 'Banked',
    meaning: 'Cash taken from the safe to the bank.',
  },
  cash_variance: {
    label: 'Cash over / (short)',
    short: 'Over / (short)',
    meaning: 'The difference between the cash counted and the cash the books expected.',
  },
  petty_disbursement: {
    label: 'Petty cash paid out',
    short: 'Petty cash paid',
    meaning: 'Small expenses paid from petty cash.',
  },
  write_off: {
    label: 'Cash written off',
    short: 'Written off',
    meaning: 'Cash formally treated as lost.',
  },
};

/** What the source document of a movement is called on paper. */
export const DOC_TYPE_TERMS: Record<string, string> = {
  GRN: 'Goods received note',
  SALE: 'Sales receipt',
  TRANSFER: 'Inter-branch transfer',
  TRANSFER_CANCEL: 'Transfer cancelled',
  COUNT: 'Stock take',
  CASH_MOVE: 'Cash movement',
  CASH_COUNT: 'Cash count',
  RESET: 'Branch stock reset',
  OPENING: 'Opening stock',
};

/** Falls back to a readable version of an unknown value rather than showing it raw. */
function humanise(value: string): string {
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function stockReason(reason: string): Term {
  return (
    STOCK_REASON_TERMS[reason] ?? { label: humanise(reason), short: humanise(reason), meaning: '' }
  );
}

export function cashReason(reason: string): Term {
  return (
    CASH_REASON_TERMS[reason] ?? { label: humanise(reason), short: humanise(reason), meaning: '' }
  );
}

export function docType(type: string | null): string | null {
  if (type === null) return null;
  return DOC_TYPE_TERMS[type] ?? humanise(type);
}

/**
 * "How to read this" - defined once, shown wherever a ledger appears.
 * Written for someone who knows accounts, not the system.
 */
export const LEDGER_GLOSSARY: { term: string; meaning: string }[] = [
  {
    term: 'Opening balance b/f',
    meaning:
      'The quantity in stock at the start of the period, brought forward. It is worked out from every entry before that date - it is not itself an entry.',
  },
  {
    term: 'Receipts',
    meaning: 'Everything that increased stock in the period: purchases, transfers in, sales returns, stock take surpluses, opening stock introduced.',
  },
  {
    term: 'Issues',
    meaning: 'Everything that decreased stock: sales, transfers out, write-offs, losses in transit, stock take shortages, purchase returns.',
  },
  {
    term: 'Balance',
    meaning: 'The running quantity after each entry, in the order things happened (by date, then by posting order).',
  },
  {
    term: 'Closing balance c/f',
    meaning: 'Opening balance plus receipts less issues: the quantity carried forward. It becomes the next period’s opening balance.',
  },
  {
    term: 'Agrees to stock on hand',
    meaning: 'For a period ending today: the closing balance equals the quantity the system reports on hand. If it ever does not, something is wrong with the books.',
  },
  {
    term: 'Recorded late',
    meaning: 'An entry keeps the date the event happened, but is flagged when it was recorded more than two days afterwards.',
  },
];
