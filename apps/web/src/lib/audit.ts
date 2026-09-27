/**
 * The audit log in plain words: a label for every kind of change, grouped the
 * way someone reviewing it thinks, and where to go to see the thing changed.
 */

export const AUDIT_GROUPS: { name: string; actions: string[] }[] = [
  { name: 'Sign-in and passwords', actions: ['LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_BLOCKED', 'LOGOUT', 'PASSWORD_CHANGED', 'PASSWORD_CHANGE_FAILED', 'USER_PASSWORD_RESET'] },
  { name: 'Staff and access', actions: ['USER_CREATED', 'USER_UPDATED', 'ACCESS_GRANTED', 'ACCESS_REVOKED', 'ACCESS_RESET'] },
  { name: 'Prices', actions: ['PRICE_CHANGED', 'SUPPLIER_PRICE_LIST'] },
  { name: 'Items', actions: ['ITEMS_IMPORTED', 'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_QUICKADDED', 'PRODUCT_APPROVED', 'PRODUCT_MERGED', 'PACK_ADDED', 'PACK_UPDATED', 'BARCODE_ATTACHED', 'BARCODE_REMOVED'] },
  { name: 'Stock', actions: ['OPENING_STOCK_POSTED', 'BRANCH_STOCK_RESET'] },
  { name: 'Buying', actions: ['SUPPLIERS_IMPORTED', 'SUPPLIER_ADDED', 'SUPPLIER_CHANGED', 'SUPPLIER_DEACTIVATED', 'PO_PLACED', 'PO_CANCELLED', 'PO_CLOSED', 'GRN_POSTED', 'PURCHASE_RETURN_POSTED', 'SUPPLIER_PAID', 'SUPPLIER_PAYMENT_VOIDED', 'PAYMENT_PROOF_ATTACHED'] },
  { name: 'Customers', actions: ['CUSTOMERS_IMPORTED', 'CUSTOMER_ADDED', 'CUSTOMER_CHANGED', 'CREDIT_LIMIT_CHANGED', 'CUSTOMER_PAID', 'CUSTOMER_PAYMENT_VOIDED'] },
  { name: 'Shifts and end of day', actions: ['SHIFT_OPENED', 'SHIFT_CLOSED', 'DAY_CLOSED'] },
  { name: 'Branches and settings', actions: ['BRANCH_CREATED', 'BRANCH_UPDATED', 'SETTING_CHANGED'] },
  { name: 'Exceptions', actions: ['EXCEPTION_CLEARED'] },
];

export const AUDIT_LABEL: Record<string, string> = {
  LOGIN_SUCCEEDED: 'Signed in',
  LOGIN_FAILED: 'Wrong password',
  LOGIN_BLOCKED: 'Sign-in refused (locked or inactive)',
  LOGOUT: 'Signed out',
  PASSWORD_CHANGED: 'Changed their password',
  PASSWORD_CHANGE_FAILED: 'Password change refused',
  USER_PASSWORD_RESET: 'Reset a password',
  USER_CREATED: 'Added a person',
  USER_UPDATED: 'Changed a person’s account',
  ACCESS_GRANTED: 'Gave access beyond the role',
  ACCESS_REVOKED: 'Took away access',
  ACCESS_RESET: 'Put access back to the role',
  PRICE_CHANGED: 'Changed a selling price',
  SUPPLIER_PRICE_LIST: 'Applied a supplier price list',
  ITEMS_IMPORTED: 'Imported items from a spreadsheet',
  PRODUCT_CREATED: 'Added an item',
  PRODUCT_UPDATED: 'Changed an item',
  PRODUCT_QUICKADDED: 'Added an item at the till',
  PRODUCT_APPROVED: 'Approved an item added at the till',
  PRODUCT_MERGED: 'Merged a duplicate item',
  PACK_ADDED: 'Added a pack',
  PACK_UPDATED: 'Changed a pack',
  BARCODE_ATTACHED: 'Added a barcode',
  BARCODE_REMOVED: 'Removed a barcode',
  OPENING_STOCK_POSTED: 'Brought in opening stock',
  BRANCH_STOCK_RESET: 'Set a branch’s stock to zero',
  SUPPLIER_ADDED: 'Added a supplier',
  SUPPLIER_CHANGED: 'Changed a supplier',
  SUPPLIER_DEACTIVATED: 'Deactivated a supplier',
  PO_PLACED: 'Placed a purchase order',
  PO_CANCELLED: 'Cancelled a purchase order',
  PO_CLOSED: 'Closed an order short',
  GRN_POSTED: 'Received goods',
  PURCHASE_RETURN_POSTED: 'Returned goods to a supplier',
  SUPPLIER_PAID: 'Paid a supplier',
  SUPPLIER_PAYMENT_VOIDED: 'Voided a supplier payment',
  PAYMENT_PROOF_ATTACHED: 'Attached proof of payment',
  CUSTOMERS_IMPORTED: 'Imported customers from a spreadsheet',
  SUPPLIERS_IMPORTED: 'Imported suppliers from a spreadsheet',
  CUSTOMER_ADDED: 'Added a customer',
  CUSTOMER_CHANGED: 'Changed a customer',
  CREDIT_LIMIT_CHANGED: 'Changed a credit limit',
  CUSTOMER_PAID: 'Received a customer payment',
  CUSTOMER_PAYMENT_VOIDED: 'Voided a customer payment',
  SHIFT_OPENED: 'Opened a shift',
  SHIFT_CLOSED: 'Closed a shift',
  DAY_CLOSED: 'Closed the day',
  BRANCH_CREATED: 'Added a branch',
  BRANCH_UPDATED: 'Changed a branch',
  SETTING_CHANGED: 'Changed a setting',
  EXCEPTION_CLEARED: 'Cleared an exception',
};

/** Sensitive changes are highlighted in the list. */
export const AUDIT_SENSITIVE = new Set([
  'LOGIN_BLOCKED', 'ACCESS_GRANTED', 'ACCESS_REVOKED', 'USER_PASSWORD_RESET', 'BRANCH_STOCK_RESET', 'CREDIT_LIMIT_CHANGED',
  'SUPPLIER_PAYMENT_VOIDED', 'CUSTOMER_PAYMENT_VOIDED', 'SETTING_CHANGED', 'PRODUCT_MERGED',
]);

export function auditLabel(action: string): string {
  if (AUDIT_LABEL[action] !== undefined) return AUDIT_LABEL[action];
  const s = action.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Where to see the record a change was made to. */
export function auditLink(entityType: string | null, entityId: string | null, after: Record<string, unknown> | null): string | null {
  if (entityId === null) return null;
  switch (entityType) {
    case 'product':
      return '/products';
    case 'product_pack':
      return '/prices';
    case 'person':
      return `/users/${entityId}/access`;
    case 'supplier':
      return `/suppliers/${entityId}`;
    case 'customer':
      return `/customers/${entityId}`;
    case 'purchase_order':
      return `/orders/${entityId}`;
    case 'goods_received':
      return `/receive/${entityId}`;
    case 'purchase_return':
      return `/returns/${entityId}`;
    case 'supplier_price_list':
      return `/price-lists/${entityId}`;
    case 'shift':
      return `/shifts/${entityId}`;
    case 'day_close':
      return `/day-close/${entityId}`;
    case 'item_import':
      return '/products/import';
    case 'opening_stock':
      return `/opening-stock/${entityId}`;
    case 'branch':
      return '/branches';
    default:
      return after !== null && typeof after['customerId'] === 'string' ? `/customers/${after['customerId']}` : null;
  }
}

const HIDDEN = new Set(['ip', 'userAgent', 'sessionId']);
/** Names what the change was about; shown even though it is the same before and after. */
const CONTEXT = ['key', 'permission', 'shiftNo', 'listNo', 'importNo'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields that changed, before → after; for a new record, what it was created with. Raw ids are left out. */
export function auditChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { key: string; from: string | null; to: string | null }[] {
  const show = (v: unknown): string | null =>
    v === undefined ? null : v === null ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !HIDDEN.has(k));
  const context = CONTEXT.filter((k) => keys.includes(k)).map((k) => ({ key: k, from: null, to: show((after ?? before ?? {})[k]) }));
  const changes = keys
    .filter((k) => !CONTEXT.includes(k))
    .map((k) => ({ key: k, from: before === null ? null : show(before[k]), to: after === null ? null : show(after[k]) }))
    .filter((c) => c.from !== c.to && !UUID.test(c.to ?? '') && !UUID.test(c.from ?? ''));
  return [...context, ...changes];
}

export function humanKey(key: string): string {
  const s = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
