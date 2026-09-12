# HANDOFF — read this first

You are picking up a greenfield build at Phase 0. This file is the complete
context: the client, the evidence, the decisions already made and why, what
exists, and what to do next. Everything here was derived from the client's own
system exports and documents. Do not re-litigate the decisions in §4 without
reading §2 first — they are responses to specific observed failures.

---

## 1. The client and the job

A supermarket group in Zimbabwe running **at least twelve locations**
(DOWNSTORES, Gwelutshena, Kana Mission, Kernmaur, LUPANE, Mission, Nesigwe,
NEW SUPERMARKET, OLD SUPERMARKET, St Lukes, TM, and a central WAREHOUSE — the
branch list was still scrolling when captured, so treat 12 as a floor).

They currently run **SalesIntellect** (cloud POS + back office) and have
previously used QuickBooks, Retailware and Novel. They want a replacement built.

Scale observed:

| Measure | Value |
|---|---|
| Locations | 12+, including one warehouse |
| User accounts | 29 — 1 Administrator, 20 Cashiers, 4 Managers, 1 Audit, 3 Receivers |
| Items per branch | 814 at Kana Mission |
| Goods received | ~710 GRNs, USD 1,149,555 cumulative |
| Group turnover | **UNKNOWN — still blocking** |

The internal **Auditor** is the project sponsor. He is not the budget holder.

The stated complaint is cost: ~USD 12 per terminal per month plus ~USD 10 per
site for internet. That is roughly 0.26% of estimated turnover and is **not**
the real problem. See §2.

---

## 2. Why this project exists — the evidence

This section is the reason the architecture looks the way it does. Every design
rule in §4 maps to something here.

### 2.1 Stock count IC-10027 (Kana Mission, 25 July 2026)

Parsed from the client's own count sheet:

| Metric | Value |
|---|---|
| Items in branch master | 814 |
| Items counted | 243 (30%) |
| Items left uncounted | 571 (70%) |
| **Counted lines that reconciled** | **0** |
| Surpluses (physical > book) | 240 |
| Shortages (physical < book) | 3 |
| Total variance | **USD 214,516** |

A 100% variance rate is not shrinkage. The perpetual inventory had no working
relationship with physical reality. Note the direction: almost everything
counted *higher* than expected, meaning stock entered the business without
being recorded. Several items showed book stock of **zero** with hundreds of
units on the shelf (Three Leaves 125g: 0 expected, 500 counted).

> Framing rule: present USD 214,516 as *inventory the system could not account
> for*, never as a theft estimate. Much of it is unit-of-measure error. The
> real problem is that they cannot tell the two apart.

### 2.2 Cost data is unusable

Dashboard, one trading day: gross sales 295.22, net sales 295.22, cost of sales
294.89, gross profit **0.33 — a 0.11% margin**. Grocery runs 12–25%. Cost price
has been captured at or near selling price across most of the range, so every
margin, valuation and profitability report is meaningless.

### 2.3 The item master is structurally broken (probable root cause)

**Same product, multiple records:**

| Product | Records in master |
|---|---|
| Three Leaves tea 125g | **Four**, four different barcodes |
| Three Leaves tea 250g | Two |
| Knockout fabric softener 1L | Two |
| Knockout foam bath 750ml | Two |
| Knockout foam bath 2L | Two |
| Charhons biscuits | Twelve records across pack sizes, no conversions |

Nine further products appear under identical names with different barcodes
(Pure Drop, Tomango, Blue Band, Jumbo, Natural Joy, Mazoe Raspberry 6x2l,
Mazoe Blackberry 6x2l, Bonaqua 12x500ml, D'lite 375ml).

**Cases and singles are unlinked products.** `Charhons 500g` and
`Charhons biscuits 10x500g` are unrelated records with no rule that one case
is ten units. The warehouse receives cases, the branch sells singles, and they
can never reconcile. **This alone plausibly explains a large share of the
USD 214,516.**

**Barcode integrity across 814 items:**

| Defect | Count | Examples |
|---|---|---|
| Under 6 digits | 241 | `3`, `12`, `18`, `76`, `83` |
| Over 13 digits | 42 | `6744072585426083` |
| Leading-zero (spreadsheet damage) | 75 | `074699`, `01739`, `0956` |
| **Negative** | 1 | `-1124125534` |

### 2.4 Receiving controls

- Stock received with supplier `N/A`: GRN-10699 (USD 2,000 → warehouse),
  GRN-10695 (USD 170), GRN-10693 (USD 275).
- **Backdating is routine.** `TGRN-10001` has a GRN date of 13 Dec 2025 and a
  created date of 14 May 2026 — five months — and is still in *Temporary Saved*.
- The old platform ships a "Backdate inventory report", i.e. the vendor treats
  this as normal.

### 2.5 Counts are abandoned

Counts created 18, 22 and 25 July still "In progress" (Kernmaur ×2, Mission,
TM). An unfinished count posts no adjustment, so variance never clears and the
next count starts from the same wrong base. One count was annotated
"MAREVANHEMA HANDOVER TO MAKOMBO" — counts used as informal staff handovers.

### 2.6 Identity and access

- Three records for one or two humans: `Eunice M` (Receiver),
  `Eunice Madimbe` (Manager), `EUNICE` (Manager, disabled).
- Cashiers with no email and no phone (`Dzidzai Chikuku`, `Keto`,
  `Hazel Gatsi`) — no recovery path, no proof of who used the account.
- Dormant privileged accounts on Audit and Manager roles.
- Five roles split only by POS / BACKOFFICE. No way to let a manager approve a
  price change but not a stock adjustment.

### 2.7 Client's stated problems, verbatim

> failing to do inventory · stock · selling negative / zeros — override to
> their own benefit (continue) · always update request · so many loop wholes

---

## 3. Legal constraints — both are blockers

### 3.1 ZIMRA fiscalisation

The Fiscalization and "Generate ZIMRA Taxes" toggles are **OFF** in their
current system. Under Zimbabwean rules, VAT-registered operators must register
and interface with the **FDMS** (Fiscalisation Data Management System), either
via approved fiscal hardware or a **Virtual Fiscal Device** using the FDMS API.
FDMS compliance is a condition for the ITF 263 tax clearance certificate, and
input tax may only be claimed on fiscal invoices from a connected device.

Virtual fiscal device build requirements: ECDSA P-256 or RSA-2048 signing,
real-time HTTPS to FDMS endpoints, secure local storage of device certificate
and private key, ZIMRA-spec QR codes, sequential receipt numbering, fiscal-day
open/close tracking.

**The client's own SRS omits fiscalisation entirely.** It must be in Release 1.
ZIMRA onboarding is outside our control and depends on their tax clearance
being current — start it in week 1 and track as critical path. Never commit to
a go-live date that assumes fast ZIMRA turnaround.

### 3.2 Cyber and Data Protection Act [Chapter 12:07]

Enforced by POTRAZ. Applies to all organisations regardless of size. Data
controllers must register, and most must hold a licence (SI 155 of 2024, USD
50–2,000). **Only POTRAZ-licensed persons may process biometric data.** Breaches
reportable within 24 hours. POTRAZ must be notified before transferring
personal data outside Zimbabwe — relevant because we intend to host in
Johannesburg. The compliance grace period ended July 2026 and enforcement is
active.

The client's SRS mandates collecting national ID / passport numbers, badge IDs,
addresses and driver's licence numbers — including from **third parties**
(external CIT couriers, contracted transporters) — plus biometric clock-in.

Build consequences, already reflected in the schema:

1. `person.national_id_ref` is a **nullable reference to a separately
   permissioned vault table**, not a column. Do not make it NOT NULL without a
   signed lawful-basis assessment.
2. **Biometric clock-in is out of Release 1.**
3. Cross-border hosting needs a POTRAZ notification — Phase 0 compliance track.

---

## 4. Architecture decisions (already made — do not silently reverse)

### AD-1 — Stock is a ledger, not a number

There is no `qty_on_hand` column and there never will be one. Stock is
`SUM(qty_base)` over an append-only `stock_movement` table, exposed as the
`stock_on_hand` view.

This one decision buys four things simultaneously:

- **Offline sync with no conflict resolution.** Movements are commutative. Two
  tills that traded through an outage sync in any order and agree. There is no
  last-write-wins problem because there are no writes to lose.
- **Audit trail for free** — history is the storage format.
- **Backdate detection for free** — every movement carries `occurred_at`
  (business time) and `recorded_at` (server time); the gap is data.
- **Reproducible costing** — WAC derives from the receipt movements that
  produced it, so it cannot drift to equal the selling price (§2.2).

Enforced by trigger: `UPDATE`/`DELETE` on `stock_movement` raise. Corrections
are new movements carrying `reverses_seq`.

### AD-2 — Quantities are always in base units

A product has one base unit. Packs are conversions applied at the edge (scanner,
GRN screen), never inside the ledger. Directly targets §2.3.

### AD-3 — Barcodes attach to packs and are globally unique

`barcode.code` is the primary key; one code → one pack → one product +
multiplier. Makes the Three Leaves ×4 state unrepresentable. Check constraints
reject the malformed codes catalogued in §2.3.

### AD-4 — Controls produce work items, not log lines

Every override, unlisted scan, backdate and count variance writes to
`exception_event` with `state='open'`. Clearing requires a named person and
timestamp — the schema refuses a `cleared` row without both. The old system had
"Suspicious reports" that nobody read; a control nobody clears is not a control.

### AD-5 — One human, one record

`person` is unique per human and requires at least one contact route (§2.6).

### AD-6 — Shared domain package

`packages/domain` holds the rules. The API *and* the offline POS both import
it, so an offline till enforces identical negative-stock and pack-conversion
logic to the server. Never duplicate a rule into `apps/api`.

---

## 5. Client SRS — what to build and what to defer

The client sent an 11-page SRS ("Integrated Multi-Branch Business Operations &
ERP Management System", 2 Sep 2026). It absorbed our discovery report well —
offline-first, append-only ledger, GTIN validation, pack hierarchy, WAC,
maker-checker, audit trail all came back. It is also AI-expanded and
constraint-blind: it specifies everything and gives up nothing.

Full analysis in `docs/00-scope-reconciliation.md`. Summary:

**In Release 1:** append-only ledger + offline sync · pack hierarchy · barcode
validation · unlisted-scan capture + terminal lock · blind shift cash-up · POS
tamper lock (voids/overrides/refunds behind manager auth + reason code) · cash
position across till/safe/CIT/bank/petty · cash collection handover (names and
staff IDs yes, national ID optional) · dispatch + in-transit + receiving
variance · batch and FEFO expiry · 3-way match PO/GRN/invoice · RBAC + immutable
audit log · reporting suite · **plus ZIMRA fiscalisation and data-protection
controls, which the SRS omitted**.

**Deferred, with triggers:** ML demand forecasting (needs 12 months of clean
ledger data) · autonomous PO generation (needs suggested-ordering acceptance
≥80% for a quarter) · double-entry GL / P&L / balance sheet (only if they
retire QuickBooks — export first) · biometric clock-in (needs POTRAZ biometric
licence) · RFID / weight-sensing / vision stocktaking (capital programme, not a
software decision).

**Replaced:** IoT human-free stocktaking → scanner-driven **cycle counting**
with blind entry and enforced posting, ~1% of the cost, same failure addressed.
Sensor discrepancy detection → nightly ledger-vs-count exception job.
Autonomous reordering → reorder points with **suggested** POs for approval
(automating a wrong number just makes it faster).

**On the IoT contradiction:** the client says USD 12/terminal is too expensive
while specifying RFID smart shelves and vision cameras. RFID tags run
USD 0.05–0.15; their range is salt, tea bags, loose biscuits and 50-cent
sweets, where the tag costs more than the item's margin. Frame as sequencing,
not cutting — nothing in SRS §6 works until §3 and §4 produce a year of
trustworthy data.

**Timeline:** their 30-week frame works only if SRS Phase 3 (ML + IoT +
autonomous PO in 8 weeks — not a schedule, a wish) is replaced with
fiscalisation and reporting.

---

## 6. What exists in this repo

```
package.json                              npm workspaces root, Node 22+
tsconfig.base.json / tsconfig.json        strict TS, project references
.env.example                              DATABASE_URL, CORS, session secret
.gitignore

packages/db/migrations/001_core.sql       CANONICAL SCHEMA — PostgreSQL 15+
                                          branch, terminal, person, role,
                                          product, product_pack, barcode,
                                          stock_movement (+append-only trigger),
                                          exception_event, audit_log,
                                          views: stock_on_hand, product_wac,
                                          backdated_movement

packages/domain/src/errors.ts             DomainError hierarchy — DONE
packages/domain/src/types.ts              Product, ProductPack, StockMovement,
                                          MovementReason, ExceptionKind — DONE

packages/domain/test/ledger_proof.reference.py
                                          COMPLETE WORKING REFERENCE
                                          IMPLEMENTATION, 12/12 tests passing

docs/00-scope-reconciliation.md           Client SRS vs buildable Release 1
```

### The reference implementation is your spec

`ledger_proof.reference.py` is a working Python implementation of the ledger
with twelve passing tests, each derived from a real defect above. Run it:

```bash
python3 packages/domain/test/ledger_proof.reference.py
```

```
PASS  case-to-single conversion reconciles      PASS  unlisted barcode raises and logs
PASS  duplicate barcode rejected                PASS  backdated receipt flagged
PASS  malformed barcodes rejected               PASS  replayed offline events apply once
PASS  ledger rejects UPDATE and DELETE          PASS  count variance posts an adjustment
PASS  negative stock blocked by default         PASS  count variance is costed
PASS  override creates an open exception        PASS  weighted-average cost derived from ledger
```

**Port these twelve to Vitest in TypeScript. All twelve must pass. If one
fails, a known client defect has been reintroduced.**

---

## 7. Stack (pinned, verified against the registry)

TypeScript 5.9.3 · Node 22 · Fastify 5.12 · Zod 4.5 · Kysely 0.29 (SQL-first;
the schema uses triggers and views an ORM would fight) · pg 8.23 ·
Vitest 5.0 · React 19 · Vite 7.3 · Tailwind · tsx 4.23.

SQL migration files are the source of truth for schema. Kysely provides typed
queries only — do not generate the schema from TypeScript.

**If the team is a Python/Django or PHP/Laravel shop, say so before any more
code is written.** Swapping is cheap today and expensive in a month. The schema
and the reference implementation are stack-agnostic and survive the change.

---

## 8. Build order

1. **`packages/domain`** — port `ledger_proof.reference.py` to TypeScript.
   `ledger.ts` (post/sell/postCount/resolveBarcode/raiseException),
   `packs.ts` (base-unit conversion), `barcode.ts` (EAN-13 check digit +
   the malformed-code rules). Twelve Vitest tests green.
2. **`packages/db`** — migration runner over `migrations/*.sql`, Kysely types,
   connection pool, `docker-compose.yml` with Postgres 16.
3. **`apps/api`** — Fastify + Zod. First vertical slice: products with pack
   hierarchy, `stock_on_hand`, exception queue (list + clear). Map
   `DomainError.code` to HTTP status at the edge, one place only.
4. **`apps/web`** — React + Vite back office. Same slice: item master, stock by
   branch, exception queue. The exception queue is the client's differentiator
   — build it properly, not as a table dump.
5. **CI** — `.github/workflows/ci.yml`: typecheck, vitest, migrations applied
   against a Postgres service container.
6. **Item master cleanse tooling** — duplicate detection over the 814-row
   export, pack hierarchy inference, barcode validation report. This is Phase 0
   client-facing work and can run in parallel with everything above.

Then: migration 002 procurement (supplier, PO, GRN with mandatory supplier,
3-way match), migration 003 transfers (dispatch, in-transit, receiving
variance), sync protocol spec (outbox format, cursor semantics, conflict cases).

---

## 9. Still-blocking questions — not yet answered by the client

Three documents in, none of these have answers:

1. **Group monthly turnover.** Below ~USD 30,000/month a bespoke build cannot
   be justified at any honest price; the right advice would be to keep
   SalesIntellect and fix process. Estimated ~USD 75–80k/month from the GRN
   ledger, unconfirmed.
2. **VAT registration status.** Ask this week. Determines whether §3.1 is a
   legal precondition for go-live.
3. Exact branch and terminal counts.
4. Budget authority and range.
5. Whether they hold a POTRAZ data controller licence.

Do not let build progress imply these are settled.

---

## 10. Working rules

- The client's previous vendor pain was "always update request" — a change
  treadmill. Prefer configuration over custom code; every hard-coded rule is a
  future change request.
- No hard deletes anywhere in the system. Reversals only.
- Every control must produce a work item with a named owner, not a log line.
- When a design choice trades control for convenience, control wins — the
  sponsor is an auditor and that is what we are being paid for.
