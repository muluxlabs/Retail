/**
 * Shared domain rules (AD-6).
 *
 * The API and the offline POS both import this package, so an offline till
 * enforces identical negative-stock and pack-conversion logic to the server.
 * Never duplicate a rule from here into apps/api.
 */

export * from './errors.js';
export * from './types.js';
export * from './barcode.js';
export * from './packs.js';
export * from './policy.js';
export * from './ledger.js';
