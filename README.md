# Retail Operations Platform

One system for every branch of a retail group: the tills, the stock, the suppliers, the cash, the customers and the numbers — with every movement recorded, nothing deleted, and anything unusual put in front of a named person.

**Live:** [retail-five-pi.vercel.app](https://retail-five-pi.vercel.app) · **User & partner guide:** [in the system at /docs](https://retail-five-pi.vercel.app/docs) · [in this repository](docs/guide/README.md)

![The group overview](docs/guide/images/overview.jpg)

## What is in it

| Area | Highlights |
|---|---|
| **Selling** | Multi-item till with barcode scanning, split payments (cash, mobile money, card, account, loyalty points), 58/80 mm receipts, gapless receipt numbers |
| **Shifts & cash** | Cashier shifts with counted float and blind close, cash custody (tills, safes, bank), X and Z reports where every sale is on exactly one Z |
| **Stock** | Item master with pack hierarchy, stock on hand, the stock ledger in accounting form, stock takes, opening stock, branch transfers |
| **Buying** | Suppliers, purchase orders, goods received, returns, supplier payments with proof, aged creditors, supplier price lists |
| **Customers** | Credit accounts with limits, payments, aged debtors, loyalty points |
| **Reports** | Group overview, sales and profit, item analysis, stock movement |
| **Controls** | Exception queue, audit log, role-based access with per-person grants, branch scope |

## The guide

The full guide lives in [`docs/guide/`](docs/guide/README.md) and is published inside the system at **/docs**:

1. [What the platform is](docs/guide/01-introduction.md) · 2. [Getting started](docs/guide/02-getting-started.md) · 3. [Roles and access](docs/guide/03-roles-and-access.md) · 4. [Selling](docs/guide/04-selling.md) · 5. [Shifts, cash and end of day](docs/guide/05-cash-and-end-of-day.md) · 6. [Items, prices and stock](docs/guide/06-items-prices-stock.md) · 7. [Buying](docs/guide/07-buying.md) · 8. [Customers and loyalty](docs/guide/08-customers-and-loyalty.md) · 9. [Reports and controls](docs/guide/09-reports-and-controls.md) · 10. [Administration](docs/guide/10-administration.md) · 11. [The demo guide](docs/guide/11-demo-guide.md) · 12. [API reference](docs/guide/12-api-reference.md) · 13. [How it is built](docs/guide/13-how-it-is-built.md) · 14. [Questions and answers](docs/guide/14-faq.md)

## For developers

| Folder | What |
|---|---|
| `apps/web` | React 19 + Tailwind 4 single-page app (Vite) |
| `apps/api` | Fastify API: routes, services, permission guards |
| `packages/domain` | Business rules in pure TypeScript, unit-tested |
| `packages/db` | PostgreSQL migrations (plain SQL, applied in order, never edited once applied), schema types, seed |
| `api/` | The serverless entry point for Vercel |
| `docs/` | The guide, the deployment runbook, scope notes |

### Run it locally

Needs Node.js 22+ and Docker.

```bash
npm install
cp .env.example .env          # local settings; never commit real secrets
npm run db:up                 # Postgres 16 in Docker
npm run db:reset              # migrate + seed; prints one-time temporary passwords
npm run dev:api               # API on http://localhost:3000
npm run dev:web               # web on http://localhost:5173
```

### Check it

```bash
npm run typecheck             # the API and packages
(cd apps/web && npx tsc -b)   # the web app
npm test                      # unit tests
```

Every feature is also verified against a running system: live API suites (figures checked against independent SQL, concurrent requests) and real-browser suites, on a freshly built database.

### Ship it

See [docs/01-deployment.md](docs/01-deployment.md). In short: new migrations go to the production database **before** the code that needs them, and a release is built from a clean checkout of the pushed commit — never from a working copy.
