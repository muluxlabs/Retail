# 12. API reference

Everything the screens do goes through one HTTP JSON API, so anything a person can do in the system, an integration can do too — with exactly the same rules, permissions and records. This chapter is for engineers and integration partners.

**Base URL:** `https://<your-system>/api` (for the live system: `https://retail-five-pi.vercel.app/api`)

> **Status of external access.** Today the API authenticates with the same signed-in session the screens use. There are no separate API keys yet. For an integration, create a **dedicated staff account** (e.g. *Website integration*) and give it only the permissions it needs — see [Roles and access](03-roles-and-access.md). Everything it does is recorded under that account's name. Dedicated API keys and webhooks are on the roadmap.

## Signing in

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "integration@yourbusiness.com", "password": "…" }
```

The response sets an `httpOnly` cookie, `retail_session`, valid for 12 hours; send it with every request. `GET /api/auth/me` returns the signed-in person, their roles, branches and **effective permissions**. `POST /api/auth/logout` ends the session.

```bash
# curl: keep the session in a cookie jar
curl -c jar.txt -H 'Content-Type: application/json' \
     -d '{"email":"integration@yourbusiness.com","password":"…"}' \
     https://retail-five-pi.vercel.app/api/auth/login
curl -b jar.txt https://retail-five-pi.vercel.app/api/auth/me
```

- A new account must change its temporary password (`POST /api/auth/change-password`) before anything else works.
- Eight wrong passwords lock the account for 15 minutes.

## Conventions

| Topic | Rule |
|---|---|
| **Format** | JSON in, JSON out. Dates and times are ISO 8601 (`2026-09-27T08:15:00Z`); calendar days are `YYYY-MM-DD` in the business's time zone. |
| **Money** | Numbers in the business currency (USD). Prices and totals have at most **2 decimals**; costs per pack at most **4**. The server rounds each line half away from zero, exactly as the till does. |
| **Identifiers** | UUIDs. Items are addressed by `productId` + `packId`. |
| **Idempotency** | Documents that move stock or money take an `id` **you generate** (a UUID): `saleId` for a sale, `id` for a delivery, payment, return, shift, day close, price list… Sending the same request again — after a timeout, say — returns the original result (HTTP 200 instead of 201) and posts nothing twice. |
| **Permissions** | Every route checks a permission on the server (listed below). Branch-scoped accounts can only act on their own branches. |
| **Immutability** | Posted documents are never edited. There are no `DELETE`s for them: corrections are new documents (a return, a void with a reason, a reversing count). |
| **Paging** | List routes take `limit` and `offset`. |

### Errors

Every error has the same shape:

```json
{ "error": { "code": "CREDIT_LIMIT_EXCEEDED", "message": "Mai Rudo Tuckshop has $42.00 of credit left.", "detail": { } } }
```

| HTTP | Meaning | Example codes |
|---|---|---|
| 401 | Not signed in | `NOT_AUTHENTICATED` |
| 403 | Signed in, but not permitted | `NOT_PERMITTED` |
| 404 | Not found | `NOT_FOUND` |
| 409 | A business rule said no | `NEGATIVE_STOCK_BLOCKED`, `CREDIT_LIMIT_EXCEEDED`, `NOT_ENOUGH_POINTS`, `SHIFT_REQUIRED`, `SHIFT_ALREADY_OPEN`, `SHIFTS_STILL_OPEN`, `CUSTOMER_EXISTS`, `CANNOT_CHANGE_OWN_ACCESS` |
| 422 | The request is not valid | `VALIDATION_FAILED`, `INVALID_BASKET`, `PRICE_BELOW_COST`, `INVALID_PRICE_LIST`, `INVALID_LOYALTY` |
| 429 | Too many attempts | account locked after failed sign-ins |

For business rules (409) and most 422s, `message` is written to be shown to a person as it is. For `VALIDATION_FAILED`, `detail.issues` lists each field that did not match.

## Worked example: a sale

```http
POST /api/sales/checkout
```

```json
{
  "saleId": "5f0c1c1e-6a39-4a8b-9a55-2b1e7e0f2c11",
  "branchId": "…",
  "cashPointId": "…",
  "customerId": null,
  "lines": [
    { "productId": "…", "packId": "…", "qtyPacks": 2 },
    { "productId": "…", "packId": "…", "qtyPacks": 1, "unitPrice": 3.50, "discount": 0.20 }
  ],
  "payments": [
    { "paymentTypeId": "cash", "amount": 10.00, "tendered": 20.00 },
    { "paymentTypeId": "mobile_money", "amount": 4.35, "reference": "MP240927.1455" }
  ],
  "overrideNegative": false
}
```

- Leave out `unitPrice` to charge the list price. A different price or a `discount` needs `price.override`.
- Payment types: `GET /api/payment-types` (e.g. `cash`, `mobile_money`, `card`, `account`, `loyalty`). `account` and `loyalty` need `customerId`.
- Response `201`: `{ "receipt": { "receiptNo": "RIVER-000318", "lines": […], "net": 14.35, "change": 10.00, "payments": […], "loyalty": {…} }, "replayed": false }`.
- `409 NEGATIVE_STOCK_BLOCKED` names the item in `detail`; a caller holding `stock.override` may resend with `"overrideNegative": true`.

## Endpoints

Paths are relative to `/api`. **Permission** is what the signed-in account needs ("signed in" = any account).

### Reference data

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/branches` | signed in | Branches |
| POST · PATCH | `/branches`, `/branches/:id` | branch.manage | Add / change a branch |
| GET | `/payment-types` | signed in | Payment methods |
| GET | `/branches/:id/tills` | movement.post | Tills at a branch |
| GET | `/roles`, `/people` | signed in | Roles; people (for pickers) |
| GET | `/business/today` | signed in | The business's current day and time zone |

### Items and prices

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/products?search=` | product.read *or* movement.post | Items with packs, barcodes and selling prices (no costs) |
| GET | `/barcodes/:code` | product.read *or* movement.post | Resolve a scan to an item and pack |
| GET | `/products/:id` | product.read | One item with stock by branch and recent movements |
| POST · PATCH | `/products`, `/products/:id` | product.write | Add / change an item. Adding answers `409 SIMILAR_ITEMS` (with the look-alikes) unless `confirmSimilar: true`; an existing SKU is `409 DUPLICATE_SKU` |
| POST · PATCH | `/products/:id/packs`, `…/packs/:packId` | product.write | Add / change a pack |
| POST · DELETE | `/products/:id/packs/:packId/barcodes`, `/barcodes/:code` | product.write | Add / remove a barcode |
| POST | `/products/quick-add` | product.quickadd | Add an item at the till (pending review) |
| POST | `/products/:id/approve`, `/products/:id/merge` | product.write | Review items added at the till |
| GET | `/categories` | product.read | Categories |
| POST | `/products/import/check` | product.write | Check spreadsheet rows (`{headings, rows}`): new, existing, look-alike, problems |
| POST | `/products/import` | product.write (+ stock.opening to bring stock) | Import: `{id, fileName, headings, rows, confirmSimilar: [keys], stockBranchId}` |
| GET | `/products/imports` | product.read | Recent imports |
| GET · PUT | `/price-list` | price.write | Packs with cost, price, margin; save price changes |
| POST | `/price-list/fill-missing` | price.write | Price unpriced packs from cost + markup |

### Selling

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/sales/checkout` | movement.post | Record a sale (see above) |
| GET | `/sales?branchId=&from=&to=&q=` | sale.read | Sales receipts |
| GET | `/sales/:id` | movement.post or sale.read | One receipt, within the account's branches |
| POST | `/scans/unlisted` | movement.post | Log a scan that matched nothing |
| GET | `/customers/lookup?q=` | movement.post | Find a customer at the till (credit left, points) |
| POST | `/customers/enrol` | customer.enrol | Sign up a customer (name, phone) |
| GET | `/loyalty/rules` | signed in | Loyalty on/off, rate, point value |

### Shifts, cash and end of day

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/shifts/current` | signed in | My open shift; whether shifts are required |
| GET | `/shifts/tills?branchId=` | shift.open | Tills and who is on each |
| POST | `/shifts/open` | shift.open | Open a shift with the counted float |
| POST | `/shifts/:id/close` | shift.open | Close with a blind count (others' shifts: shift.manage) |
| GET | `/shifts`, `/shifts/:id` | shift.manage or sale.read (own closed shift: its cashier) | Shifts and shift reports |
| GET | `/cash`, `/cash/ledger` | cash.read | Cash positions; the cash ledger |
| GET | `/cash/points` | cash.count | Cash points to count |
| POST | `/cash/points`, `/cash/open`, `/cash/move` | cash.move | Add a cash point; opening cash; move cash |
| POST | `/cash/count` | cash.count | A blind count |
| GET | `/day-close/preview?branchId=` | day.close | The X report |
| POST | `/day-close` | day.close | Close the day (Z report) |
| GET | `/day-close`, `/day-close/:id` | day.close or sale.read | Z reports |

### Stock

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/stock`, `/stock/by-branch` | stock.read | Stock on hand and value |
| GET | `/movements`, `/movements/backdated` | stock.read | The stock movement log; late entries |
| GET | `/stock-ledger`, `/stock-reconciliation` | stock.read | Ledger in accounting form; reconciliation |
| GET | `/reports/movements` | stock.read | Stock movement by period |
| POST | `/movements` | movement.post | Post a stock movement |
| POST | `/counts` | stock.adjust | Post a stock take |
| GET · POST | `/opening-stock…` | stock.read / stock.opening | Opening stock documents |
| GET · POST | `/transfers`, `/transfers/:id/receive`, `/transfers/:id/cancel` | transfer.read / .dispatch / .receive | Transfers |
| GET · POST | `/branches/:id/stock-reset(/preview)` | stock.reset | Start a branch fresh |

### Buying

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET · POST · PATCH | `/suppliers`, `/suppliers/:id` | supplier.read / supplier.write | Suppliers and their account |
| POST | `/suppliers/import/check`, `/suppliers/import` | supplier.write | Import suppliers from spreadsheet rows |
| GET | `/payables` | supplier.read | Owed to suppliers (aged) |
| GET · POST | `/purchase-orders`, `/purchase-orders/:id(/cancel|/close)` | supplier.read / po.write | Purchase orders |
| GET · POST | `/goods-received`, `/goods-received/:id` | supplier.read / grn.post | Deliveries (GRNs) |
| GET · POST | `/purchase-returns`, `/purchase-returns/:id` | supplier.read / purchase.return | Returns (PRNs) |
| GET · POST | `/supplier-payments`, `/supplier-payments/:id(/void|/proofs)` | supplier.read / supplier.pay | Payments and proof of payment |
| POST | `/supplier-price-lists/preview` | price.write + supplier.read | Match a pasted list; suggested prices; `suggestions` for unmatched lines; `links` `{code: packId}` to link lines by hand |
| POST | `/supplier-price-lists` | price.write + supplier.read | Apply a price list |
| GET | `/supplier-price-lists(/:id)`, `/suppliers/:id/items` | supplier.read | Applied lists; a supplier's current costs |

### Customers

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET · POST · PATCH | `/customers`, `/customers/:id` | customer.read / customer.write | Customers and their account |
| GET | `/debtors` | customer.read | Owed by customers (aged) |
| POST | `/customer-payments`, `/customer-payments/:id/void` | customer.receive / customer.write | Payments received |
| GET · POST | `/customers/:id/loyalty` | customer.read / loyalty.adjust | Points history; adjust points |
| POST | `/customers/import/check`, `/customers/import` | customer.write | Import customers from spreadsheet rows (`confirmSimilar` for look-alikes) |

### Reports and controls

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/dashboard` | dashboard.read | The overview |
| GET | `/reports/sales` | sale.read | Sales and profit |
| GET | `/reports/items`, `/reports/items/:id/history` | sale.read | Item analysis |
| GET · POST | `/exceptions`, `/exceptions/:id(/clear|/state)` | exception.read / exception.clear | The exception queue |
| GET | `/audit?from=&to=&actions=&actorId=&branchId=&entityType=&entityId=&q=` | audit.read | The audit log: who, when, before → after (branch-scoped accounts: their branches only) |
| GET | `/audit/facets` | audit.read | Kinds of change and people found, for filters |

### Administration

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET · POST · PATCH | `/users`, `/users/:id` | user.read / user.manage | Staff accounts |
| POST | `/users/:id/reset-password` | user.manage | New temporary password |
| GET | `/users/:id/access` | user.read | A person's effective access |
| PUT | `/users/:id/access/:permission` | user.manage | `{"effect":"grant"|"revoke"|"role","note":…}` |
| GET | `/permissions` | user.read | All permissions and what each role holds |
| GET · PATCH | `/settings`, `/settings/:key` | settings.manage | System settings |
| GET | `/health`, `/ready` *(no /api prefix)* | public | Liveness; database readiness |

## Building an integration — good practice

1. **One account per integration**, holding only the permissions it uses. A website that shows stock needs `stock.read` and `product.read`, nothing else.
2. **Generate document ids yourself** and store them before sending, so a retry after a timeout is always safe.
3. **Treat 409 as a business answer**, not a failure to retry: show `message` to a person.
4. **Never cache permissions**; read `/auth/me` if you need them.
5. **Stay within one branch** when the account is branch-scoped.
