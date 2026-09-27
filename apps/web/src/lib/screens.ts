/**
 * Every screen in the system, once: where it lives, what it is for, the words
 * people search for it by, and who may open it. The top bar, the all-screens
 * panel, the side bar and search are all drawn from this list, so they can
 * never disagree about what exists or who sees it.
 */

export interface Screen {
  to: string;
  label: string;
  area: string;
  description: string;
  /** Any one of these opens it. */
  permission: string[];
  keywords?: string;
  /** Hidden from someone tied to one branch (group-wide finance). */
  groupWide?: boolean;
  /** Also counts as "here" for these paths (a screen's own sub-pages). */
  alsoActive?: string[];
}

export const AREAS = ['Home', 'Selling and cash', 'Customers', 'Stock', 'Items and prices', 'Buying', 'Reports and controls', 'Administration'];

export const SCREENS: Screen[] = [
  { to: '/', label: 'Overview', area: 'Home', description: 'Today at a glance: sales, stock value, what is owed, exceptions.', permission: ['dashboard.read'], keywords: 'dashboard home summary today' },

  { to: '/sell', label: 'Sell', area: 'Selling and cash', description: 'The till: scan, take payment, print the receipt.', permission: ['movement.post'], keywords: 'till pos checkout receipt basket cashier' },
  { to: '/shifts', label: 'Shifts', area: 'Selling and cash', description: 'Every cashier’s shift, and whether their till was over or short.', permission: ['shift.manage', 'sale.read'], keywords: 'cashier session float blind count short over' },
  { to: '/cash', label: 'Cash custody', area: 'Selling and cash', description: 'Tills, safes and bank: what each holds; move and count cash.', permission: ['cash.read', 'cash.count', 'cash.move'], keywords: 'safe till float bank deposit count money' },
  { to: '/day-close', label: 'End of day', area: 'Selling and cash', description: 'The X report, and closing the day with the Z report.', permission: ['day.close', 'sale.read'], keywords: 'z report x report close day cash up takings' },

  { to: '/customers', label: 'Customers', area: 'Customers', description: 'Customers, credit limits, statements and loyalty points.', permission: ['customer.read'], keywords: 'credit account loyalty points statement' },
  { to: '/customers/import', label: 'Import customers', area: 'Customers', description: 'Add many customers at once from an Excel or CSV file.', permission: ['customer.write'], keywords: 'excel csv spreadsheet upload bulk import customers template' },
  { to: '/debtors', label: 'Owed by customers', area: 'Customers', description: 'Aged debtors: who owes what, and how overdue.', permission: ['customer.read'], keywords: 'debtors receivables ageing overdue' },

  { to: '/stock', label: 'Stock on hand', area: 'Stock', description: 'What each branch holds and what it is worth.', permission: ['stock.read'], keywords: 'inventory quantity value below zero negative' },
  { to: '/ledger', label: 'Stock ledger', area: 'Stock', description: 'Every movement of every item, in accounting form.', permission: ['stock.read'], keywords: 'bin card reconciliation movements history' },
  { to: '/count', label: 'Stock take', area: 'Stock', description: 'Count what is on the shelf and post the differences.', permission: ['stock.adjust'], keywords: 'count stocktake adjustment variance' },
  { to: '/opening-stock', label: 'Opening stock', area: 'Stock', description: 'Bring the stock already on the shelves onto the books.', permission: ['stock.opening'], keywords: 'import spreadsheet new branch start' },
  { to: '/transfers', label: 'Transfers', area: 'Stock', description: 'Send stock between branches, and receive it.', permission: ['transfer.read'], keywords: 'dispatch receive branch warehouse transit' },

  { to: '/products', label: 'Item master', area: 'Items and prices', description: 'Items, pack sizes and barcodes.', permission: ['product.read'], keywords: 'products items barcode pack sku catalogue' },
  { to: '/products/import', label: 'Import items', area: 'Items and prices', description: 'Add many items at once from an Excel or CSV file.', permission: ['product.write'], keywords: 'excel csv spreadsheet upload bulk import products template' },
  { to: '/prices', label: 'Prices', area: 'Items and prices', description: 'Selling prices, costs and margins; change many at once.', permission: ['price.write'], keywords: 'price margin markup cost selling' },

  { to: '/suppliers', label: 'Suppliers', area: 'Buying', description: 'Suppliers, their terms and account statements.', permission: ['supplier.read'], keywords: 'vendor creditor statement' },
  { to: '/suppliers/import', label: 'Import suppliers', area: 'Buying', description: 'Add many suppliers at once from an Excel or CSV file.', permission: ['supplier.write'], keywords: 'excel csv spreadsheet upload bulk import suppliers vendors template' },
  { to: '/orders', label: 'Purchase orders', area: 'Buying', description: 'Order stock from suppliers and follow deliveries.', permission: ['supplier.read'], keywords: 'po order buy' },
  { to: '/receive', label: 'Goods received', area: 'Buying', description: 'Record a delivery against an order and invoice.', permission: ['grn.post'], keywords: 'grn delivery invoice receiving' },
  { to: '/returns', label: 'Returns to suppliers', area: 'Buying', description: 'Send goods back and reduce what you owe.', permission: ['supplier.read'], keywords: 'prn return credit note' },
  { to: '/price-lists', label: 'Supplier price lists', area: 'Buying', description: 'Import a supplier’s new prices and update yours.', permission: ['supplier.read'], keywords: 'price list import csv cost increase' },
  { to: '/payments', label: 'Supplier payments', area: 'Buying', description: 'Payments made to suppliers, with proof.', permission: ['supplier.read'], groupWide: true, keywords: 'pay proof transfer' },
  { to: '/owed', label: 'Owed to suppliers', area: 'Buying', description: 'Aged creditors: what is due and overdue.', permission: ['supplier.read'], groupWide: true, keywords: 'creditors payables ageing overdue' },

  { to: '/profit', label: 'Sales and profit', area: 'Reports and controls', description: 'Trading account, margins, trends, by branch and category.', permission: ['sale.read'], keywords: 'report revenue gross profit margin sales' },
  { to: '/sales', label: 'Sales receipts', area: 'Reports and controls', description: 'Every receipt; open or reprint any of them.', permission: ['sale.read'], keywords: 'receipt reprint transactions' },
  { to: '/items', label: 'Item analysis', area: 'Reports and controls', description: 'Fast and slow sellers, days of cover, out of stock.', permission: ['sale.read'], keywords: 'item performance slow fast sell through' },
  { to: '/reports', label: 'Stock movement', area: 'Reports and controls', description: 'Opening, purchases, sales and closing stock by period.', permission: ['stock.read'], keywords: 'report stock movement period' },
  { to: '/exceptions', label: 'Exceptions', area: 'Reports and controls', description: 'Unusual events waiting for someone to review them.', permission: ['exception.read'], keywords: 'alerts review override variance queue' },
  { to: '/audit', label: 'Audit log', area: 'Reports and controls', description: 'Every change and sign-in: who, when, before and after.', permission: ['audit.read'], keywords: 'history changes trail who changed log' },

  { to: '/users', label: 'Staff and access', area: 'Administration', description: 'People, their roles, and what each one may do.', permission: ['user.read'], keywords: 'users staff roles permissions access password', alsoActive: ['/users/'] },
  { to: '/branches', label: 'Branches', area: 'Administration', description: 'Shops and warehouses.', permission: ['branch.manage'], keywords: 'store shop warehouse location' },
  { to: '/settings', label: 'Settings', area: 'Administration', description: 'Business details, receipts, shifts, loyalty.', permission: ['settings.manage'], keywords: 'configuration receipt loyalty shifts time zone' },
  { to: '/docs', label: 'User guide', area: 'Administration', description: 'How everything works, with pictures.', permission: [], keywords: 'help documentation manual guide how to' },
];

/**
 * The short list for the top bar, in order of how often each is used. Each entry
 * opens its area at the first screen the person may use.
 */
export const MAIN: { label: string; paths: string[] }[] = [
  { label: 'Overview', paths: ['/'] },
  { label: 'Sell', paths: ['/sell'] },
  { label: 'Cash', paths: ['/cash', '/shifts', '/day-close'] },
  { label: 'Buying', paths: ['/suppliers', '/orders', '/receive', '/returns', '/price-lists', '/payments', '/owed'] },
  { label: 'Stock', paths: ['/stock', '/ledger', '/count', '/opening-stock', '/transfers'] },
  { label: 'Reports', paths: ['/profit', '/sales', '/items', '/reports'] },
  { label: 'Customers', paths: ['/customers', '/debtors', '/customers/import'] },
  { label: 'Exceptions', paths: ['/exceptions', '/audit'] },
  { label: 'Items', paths: ['/products', '/prices', '/products/import'] },
];

/** A path is "in" a screen when it is the screen or one of its sub-pages (/orders/new is in /orders). */
export function isIn(screenPath: string, pathname: string): boolean {
  if (screenPath === '/') return pathname === '/';
  return pathname === screenPath || pathname.startsWith(`${screenPath}/`);
}

/** Search: every word typed must appear in the label, area, description or keywords. */
export function searchScreens(list: Screen[], query: string): Screen[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return list;
  const scored = list
    .map((s) => {
      const hay = `${s.label} ${s.area} ${s.description} ${s.keywords ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const label = s.label.toLowerCase();
      const score = (label.startsWith(words[0]!) ? 0 : label.includes(words[0]!) ? 1 : 2) * 100 + list.indexOf(s);
      return { s, score };
    })
    .filter((x): x is { s: Screen; score: number } => x !== null);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.s);
}
