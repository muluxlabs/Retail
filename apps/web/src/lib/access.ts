/**
 * Permissions in the words an administrator uses: grouped by area of the
 * business, with the screen each one opens, and a warning on the ones that
 * move money, stock or other people's access.
 */

export interface PermissionInfo {
  label: string;
  /** The screen this opens, when it opens one. */
  opens?: string;
  /** Handle with care: it can move money or stock, or change access or settings. */
  sensitive?: boolean;
}

export const AREAS: { name: string; permissions: string[] }[] = [
  { name: 'Selling at the till', permissions: ['movement.post', 'product.quickadd', 'price.override', 'stock.override', 'shift.open', 'customer.enrol', 'customer.receive'] },
  { name: 'Supervising the tills', permissions: ['shift.manage', 'day.close', 'cash.count', 'cash.move', 'cash.read'] },
  { name: 'Items and prices', permissions: ['product.read', 'product.write', 'price.write'] },
  { name: 'Stock', permissions: ['stock.read', 'stock.adjust', 'stock.opening', 'stock.reset', 'transfer.read', 'transfer.dispatch', 'transfer.receive'] },
  { name: 'Buying', permissions: ['supplier.read', 'supplier.write', 'po.write', 'grn.post', 'purchase.return', 'supplier.pay'] },
  { name: 'Customers', permissions: ['customer.read', 'customer.write', 'loyalty.adjust'] },
  { name: 'Reports and oversight', permissions: ['dashboard.read', 'sale.read', 'exception.read', 'exception.clear', 'audit.read'] },
  { name: 'Administration', permissions: ['user.read', 'user.manage', 'branch.manage', 'settings.manage', 'data.export'] },
];

export const PERMISSION_INFO: Record<string, PermissionInfo> = {
  'movement.post': { label: 'Sell at the till', opens: 'Sell' },
  'product.quickadd': { label: 'Add a missing item at the till (goes for review)' },
  'price.override': { label: 'Change a price or give a discount on a sale', sensitive: true },
  'stock.override': { label: 'Sell below zero stock', sensitive: true },
  'shift.open': { label: 'Open and close their own shift' },
  'customer.enrol': { label: 'Sign up a customer at the till' },
  'customer.receive': { label: 'Take payments from customers on account' },
  'shift.manage': { label: 'See every shift, close someone else’s', opens: 'Cash › Shifts' },
  'day.close': { label: 'Close the day (Z report)', opens: 'Cash › End of day' },
  'cash.count': { label: 'Count cash in a till or safe', opens: 'Cash' },
  'cash.move': { label: 'Move cash between tills, safe and bank', opens: 'Cash', sensitive: true },
  'cash.read': { label: 'See cash positions and the cash ledger', opens: 'Cash' },
  'product.read': { label: 'See the item master', opens: 'Item master' },
  'product.write': { label: 'Add and change items, packs and barcodes', opens: 'Item master' },
  'price.write': { label: 'Set selling prices, import supplier price lists', opens: 'Prices', sensitive: true },
  'stock.read': { label: 'See stock on hand and the stock ledger', opens: 'Stock on hand, Stock ledger, Reports' },
  'stock.adjust': { label: 'Stock take and adjustments', opens: 'Stock entry', sensitive: true },
  'stock.opening': { label: 'Bring in opening stock', opens: 'Stock entry › Opening stock', sensitive: true },
  'stock.reset': { label: 'Zero a whole branch’s stock (cannot be undone)', sensitive: true },
  'transfer.read': { label: 'See transfers between branches', opens: 'Transfers' },
  'transfer.dispatch': { label: 'Send stock to another branch' },
  'transfer.receive': { label: 'Receive (or cancel) a transfer' },
  'supplier.read': { label: 'See suppliers, orders, deliveries and costs', opens: 'Buying' },
  'supplier.write': { label: 'Add and change suppliers' },
  'po.write': { label: 'Place purchase orders' },
  'grn.post': { label: 'Receive goods from suppliers', opens: 'Buying › Goods received' },
  'purchase.return': { label: 'Return goods to a supplier' },
  'supplier.pay': { label: 'Record and void supplier payments', opens: 'Buying › Payments', sensitive: true },
  'customer.read': { label: 'See customers and what they owe', opens: 'Customers' },
  'customer.write': { label: 'Add customers and set credit limits', sensitive: true },
  'loyalty.adjust': { label: 'Add or take away loyalty points', sensitive: true },
  'dashboard.read': { label: 'See the overview', opens: 'Overview' },
  'sale.read': { label: 'See sales, costs and profit', opens: 'Reports' },
  'exception.read': { label: 'See the exception queue', opens: 'Exceptions' },
  'exception.clear': { label: 'Clear exceptions' },
  'audit.read': { label: 'See the audit log' },
  'user.read': { label: 'See staff accounts', opens: 'Staff' },
  'user.manage': { label: 'Create staff, set roles and access', opens: 'Staff', sensitive: true },
  'branch.manage': { label: 'Add and change branches', opens: 'Branches', sensitive: true },
  'settings.manage': { label: 'Change system settings', opens: 'Settings', sensitive: true },
  'data.export': { label: 'Export records to Excel or CSV (items, suppliers, customers, price lists)', opens: 'Export records', sensitive: true },
};

export const ROLE_LABEL: Record<string, string> = {
  cashier: 'Cashier',
  supervisor: 'Shift Supervisor',
  receiver: 'Goods Receiver',
  stock_controller: 'Stock Controller',
  branch_manager: 'Branch Manager',
  auditor: 'Auditor',
  finance: 'Finance',
  administrator: 'Administrator',
  settings_manager: 'Settings Manager',
};
