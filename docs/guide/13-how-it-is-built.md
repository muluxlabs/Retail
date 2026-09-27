# 13. How it is built

For engineers, IT teams and technical due diligence.

## Architecture

```
  Browser (till, laptop, tablet, phone)
      │  React single-page app, served as static files
      ▼
  HTTPS ── /api/* ──▶  API (Node.js, Fastify) ── runs as a serverless function
                              │
                              ▼
                        PostgreSQL (managed)
                        · append-only ledgers
                        · immutable documents (enforced by triggers)
                        · balances as views
```

| Layer | Technology | Where |
|---|---|---|
| Web app | React 19, React Router, Tailwind CSS 4, Vite | `apps/web` |
| API | Node.js, Fastify 5, Zod validation, Kysely (type-safe SQL) | `apps/api` |
| Business rules | Pure TypeScript, no I/O, unit-tested | `packages/domain` |
| Database | PostgreSQL 16; plain SQL migrations, applied in order, never edited once applied | `packages/db` |
| Hosting | Vercel (static app + serverless API), Neon (managed Postgres) | `vercel.json` |

The code is one TypeScript repository (npm workspaces), type-checked end to end: the database schema types, the API and the web app agree at compile time.

## Design principles

**Ledgers, not balances.** Stock (`stock_movement`), cash (`cash_movement`) and loyalty points (`loyalty_movement`) are append-only tables. Database triggers refuse any `UPDATE` or `DELETE`. Stock on hand, cash on hand, customer and supplier balances are **views** over the movements, so they cannot drift from their history.

**Immutable documents.** Sales, goods received notes, returns, transfers, counts, opening stock, Z reports, supplier price lists and payments are written once. Triggers refuse edits; the few fields that may be set later (voiding a payment with a reason, closing a shift) can be set exactly once.

**Gapless numbering.** Receipt and document numbers come from counter rows updated inside the document's own transaction, so a rolled-back transaction never leaves a gap. Receipt numbers are per branch (`RIVER-000318`); some documents are group-wide (`SPL-000012`, `RCP-000045`).

**Idempotent writes.** Documents carry a client-generated UUID. A retried request finds the first result and returns it; two identical requests racing each other resolve on the primary key.

**Concurrency done in the database.** Row locks and advisory locks serialise what must be serial: two tills selling the last item, two cashiers opening the same till, two tills spending the same loyalty points, two people closing the same day. Each of these has an automated test that fires the requests at the same moment.

**Money in cents.** All arithmetic on money is done in integer cents (costs in ten-thousandths), with one rounding rule shared by the till screen and the server.

**Permissions are capabilities.** Every route asks for a named permission (e.g. `price.override`), never a role name. A person's permissions are their roles' permissions plus personal grants minus personal revokes, loaded fresh on every request.

**Exceptions as data.** Controls write an `exception_event` (who, where, what, value) in the same transaction as the action that triggered them.

## Security

- HTTPS only. Sessions are random tokens stored as hashes; the cookie is `httpOnly` and `SameSite=Lax`, `Secure` in production.
- Passwords are hashed with scrypt; temporary passwords must be changed at first sign-in; eight failures lock an account for 15 minutes.
- Deactivating a person or resetting their password ends their sessions at once.
- Branch scope is enforced on the server for every branch-specific read and write.
- Nobody can change their own access; nobody can grant what they do not hold; the database refuses self-granted permissions.

## Quality

Every feature ships with:

- unit tests of the business rules (`packages/domain`);
- live API test suites run against a real database, checking figures against independent SQL and firing concurrent requests;
- real-browser tests of every screen (Chrome, desktop and phone widths, no console errors, no sideways scrolling).

The full regression (20+ API suites, 15 browser suites) runs on a freshly built database before every release. Database migrations are applied to production **before** the code that needs them, and releases are built from a clean checkout of the committed code, never from a working copy.

## Operations

| Topic | How |
|---|---|
| **Health** | `GET /health` (the API is up), `GET /ready` (and the database answers). |
| **Backups** | Provided by the managed database (point-in-time restore). |
| **Scaling** | Serverless API scales with load; Postgres connection pooling. |
| **Time zone** | One business time zone (setting) defines "today", the day's close and report periods. |
| **Configuration** | Environment variables for the database connection; everything else is a Setting inside the system. |

## Known limitations (today)

- A connection is needed to sell; there is no offline till mode.
- One currency (USD); no second currency yet.
- No fiscal-device (ZIMRA) integration yet — it needs the business's own tax credentials and device.
- Receipts print through the browser; there is no direct ESC/POS or cash-drawer driver.
- API access uses staff sessions; dedicated API keys and webhooks are not built yet.
