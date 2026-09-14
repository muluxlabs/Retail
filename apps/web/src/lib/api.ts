/**
 * API client.
 *
 * Thin on purpose. It knows how to call the server and how to surface a
 * domain error; it holds no business rules, because those live in
 * packages/domain and are enforced server-side.
 */

/**
 * Where the API lives. Empty in development, where Vite proxies /api to the
 * local server, and set at build time when the frontend is deployed apart
 * from the API.
 */
const API_BASE = (import.meta.env['VITE_API_URL'] ?? '').replace(/\/$/, '');

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

/**
 * An error the server refused on purpose.
 *
 * `code` is the domain's own identifier, so the UI can react to
 * NEGATIVE_STOCK_BLOCKED specifically rather than parsing a message.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.detail = body.error.detail ?? {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_BASE + path, {
    ...init,
    // The session is an httpOnly cookie; without this it is never sent.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let body: ApiErrorBody;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = { error: { code: 'UNKNOWN', message: `${response.status} ${response.statusText}` } };
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
}

// -- shapes returned by the API ---------------------------------------------

export interface Branch {
  id: string;
  code: string;
  name: string;
  kind: 'store' | 'warehouse';
  isActive: boolean;
}

export interface Person {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
}

export interface Pack {
  id: string;
  label: string;
  qtyBase: number;
  isDefaultSell: boolean;
  isDefaultBuy: boolean;
  barcode: string | null;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  baseUom: string;
  isWeighed: boolean;
  isActive: boolean;
  mergedIntoId: string | null;
  categoryName: string | null;
  packs: Pack[];
}

export interface StockLine {
  productId: string;
  branchId: string;
  qtyBase: number;
  sku: string;
  productName: string;
  baseUom: string;
  branchCode: string;
  branchName: string;
  wac: number | null;
  value: number;
}

export interface BranchStock {
  branchId: string;
  branchCode: string;
  branchName: string;
  kind: 'store' | 'warehouse';
  lines: number;
  units: number;
  value: number;
  negativeLines: number;
}

export type ExceptionKind =
  | 'negative_stock_override'
  | 'unlisted_barcode_scan'
  | 'backdated_entry'
  | 'count_variance'
  | 'transit_loss'
  | 'cash_variance'
  | 'price_override'
  | 'void_after_tender';

export type ExceptionState = 'open' | 'acknowledged' | 'cleared' | 'escalated';

export interface ExceptionRow {
  id: string;
  kind: ExceptionKind;
  state: ExceptionState;
  detail: Record<string, unknown>;
  valueImpact: number | null;
  currency: string | null;
  occurredAt: string;
  recordedAt: string;
  clearedAt: string | null;
  clearingNote: string | null;
  branchId: string;
  branchCode: string;
  branchName: string;
  actorName: string | null;
  clearedByName: string | null;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
}

export interface ExceptionList {
  items: ExceptionRow[];
  byState: { state: ExceptionState; n: number }[];
  byKind: { kind: ExceptionKind; n: number }[];
}

export interface Movement {
  seq: number;
  eventId: string;
  qtyBase: number;
  unitCost: number | null;
  reason: string;
  docType: string | null;
  occurredAt: string;
  recordedAt: string;
  reversesSeq: number | null;
  sku: string;
  productName: string;
  branchCode: string;
  actorName: string | null;
  backdateGapHours: number;
}

export interface Dashboard {
  inventory: { lines: number; value: number; linesWithoutCost: number };
  exceptions: {
    open: number;
    valueAtRisk: number;
    byKind: { kind: ExceptionKind; count: number; valueAtRisk: number }[];
  };
  controls: { backdatedMovements: number; negativeStockLines: number };
  master: { products: number; withoutPack: number; withoutBarcode: number; merged: number };
  activity: { day: string; unitsSold: number; unitsReceived: number }[];
}

export interface CurrentUser {
  personId: string;
  fullName: string;
  email: string;
  roles: string[];
  permissions: string[];
  branchIds: string[];
  mustChangePassword: boolean;
}

export interface UserRow {
  id: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  loginEmail: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean | null;
  lockedUntil: string | null;
  canSignIn: boolean;
  roles: { roleId: string; branchId: string | null; branchCode: string | null }[];
}

// -- endpoints ---------------------------------------------------------------

export const api = {
  // -- authentication --------------------------------------------------------
  login: (body: { email: string; password: string }) =>
    request<{ user: CurrentUser; expiresAt: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<CurrentUser>('/api/auth/me'),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // -- staff accounts --------------------------------------------------------
  users: () => request<UserRow[]>('/api/users'),

  createUser: (body: {
    fullName: string;
    email: string;
    roleIds: string[];
    branchId: string | null;
  }) =>
    request<{ id: string; fullName: string; email: string; temporaryPassword?: string }>(
      '/api/users',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  updateUser: (id: string, body: { isActive?: boolean; roleIds?: string[] }) =>
    request<{ ok: true }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  resetPassword: (id: string) =>
    request<{ temporaryPassword: string }>(`/api/users/${id}/reset-password`, { method: 'POST' }),

  dashboard: () => request<Dashboard>('/api/dashboard'),

  branches: () => request<Branch[]>('/api/branches'),
  people: () => request<Person[]>('/api/people'),

  products: (params: { search?: string; limit?: number; offset?: number } = {}) =>
    request<{ items: Product[]; total: number; limit: number; offset: number }>(
      `/api/products${qs(params)}`,
    ),

  product: (id: string) =>
    request<Product & { stock: StockLine[]; movements: Movement[] }>(`/api/products/${id}`),

  stock: (params: { branchId?: string; search?: string; negativeOnly?: boolean; limit?: number } = {}) =>
    request<{ items: StockLine[] }>(`/api/stock${qs(params)}`),

  stockByBranch: () => request<BranchStock[]>('/api/stock/by-branch'),

  movements: (params: { branchId?: string; productId?: string; limit?: number } = {}) =>
    request<{ items: Movement[] }>(`/api/movements${qs(params)}`),

  exceptions: (params: { state?: string; kind?: string; branchId?: string; limit?: number } = {}) =>
    request<ExceptionList>(`/api/exceptions${qs(params)}`),

  /** Clearing requires a named person and a note. The server enforces both. */
  clearException: (id: string, body: { clearedBy: string; note: string }) =>
    request<ExceptionRow>(`/api/exceptions/${id}/clear`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setExceptionState: (id: string, body: { state: 'acknowledged' | 'escalated'; actorId: string }) =>
    request<ExceptionRow>(`/api/exceptions/${id}/state`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
