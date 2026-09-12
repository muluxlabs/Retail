# Scope Reconciliation — client SRS vs. buildable Release 1

Status: internal. Not for the client in this form.
Source: `Goal.pdf` — "Integrated Multi-Branch Business Operations & ERP Management System", 11pp, received 2 Sep 2026.

---

## 1. Read on the document

The SRS has clearly absorbed the discovery report. Offline-first tills, the append-only event ledger, GTIN/EAN validation, pack hierarchy, weighted-average costing, maker-checker, the immutable audit trail, and the Phase 0→3 structure all came back almost verbatim. That is a good sign: the client understood the diagnosis and agrees with the architecture.

It is also, on the evidence, AI-expanded rather than authored. Page 3 contains an unrendered LaTeX fragment (`$1 \text{ Case} = 10 \text{ Units}$`) sitting inside the Retailware row. The ASCII architecture diagrams are highlighter-yellow paste artifacts. This matters only because it explains the failure mode: the document is **aspiration-complete and constraint-blind**. It specifies everything anyone could want and nothing anyone must give up.

Our job is not to argue with it. It is to sort it.

---

## 2. Two things the SRS omits that can stop the project

### 2.1 ZIMRA fiscalisation is entirely absent

The phrase "fiscal compliance" appears once, in the executive summary, and never again. There is no FDMS interface, no fiscal day, no sequential fiscal receipt numbering, no QR code, no VAT engine, no device certificate handling.

This was flagged as the single largest schedule risk in the discovery report and it has vanished from the specification. If the group is VAT-registered, a POS that cannot produce a fiscal receipt is not a POS they can legally trade on.

**This is a blocker, not a backlog item.** It must go into Release 1 or the release cannot go live.

### 2.2 The SRS mandates personal-data collection with no legal basis stated

Sections 3.2, 4.1 and 4.2 require, for every cash collection and every stock dispatch: full legal name, national ID or passport number, employee or CIT security badge ID, mobile number, physical address, driver's licence number, vehicle and trailer registration, and employer name — including for **third parties** (external security couriers, contracted transporters). Section 4 of the legacy synthesis also specifies biometric clock-in.

Zimbabwe's Cyber and Data Protection Act [Chapter 12:07] applies here. <cite index="5-1">The Act applies to anyone who processes or stores personal data, by automated or partly automated means, covering all public and private organisations regardless of size, and is enforced by POTRAZ; controllers must register before starting processing activities and many must also apply for a licence</cite>. <cite index="3-1">Under Statutory Instrument 155 of 2024, all entities engaged in data processing were required to hold a data controller's licence from POTRAZ by 12 March 2025, with fees between USD 50 and USD 2,000</cite>. Biometrics are treated separately and more strictly — <cite index="8-1">only persons licensed with POTRAZ may process biometric data</cite>. <cite index="10-1">The compliance grace period ended in July 2026 and POTRAZ is now actively enforcing</cite>. <cite index="5-1">Breaches must be reported to POTRAZ within 24 hours, and POTRAZ must be notified before any transfer of personal data outside Zimbabwe</cite> — which is directly relevant, because we intend to host in Johannesburg.

Three consequences for the build:

1. National ID storage must be **optional, separately permissioned, encrypted at rest, and retention-limited**. The schema already models it as a nullable reference into a vault table rather than a column on `person`. It must not become mandatory without a documented lawful basis.
2. **Biometric clock-in is out of Release 1.** It carries a distinct licensing requirement and buys us nothing the time-clock does not.
3. Cross-border hosting needs a POTRAZ notification. Add it to the Phase 0 compliance track alongside ZIMRA onboarding.

Neither of these is a reason to slow down. Both are reasons to start the compliance track in week one, in parallel with the build.

---

## 3. The contradiction that has to be resolved

The client's stated reason for leaving SalesIntellect is that USD 12 per terminal per month is too expensive.

The SRS specifies RFID smart-shelf arrays, weight-sensing store racks, and vision cameras for continuous human-free shelf monitoring (§6.1).

These cannot both be true. RFID tagging is roughly USD 0.05–0.15 per tag. Their range is FMCG: salt, tea bags, loose biscuits, 50-cent sweets. On a large share of the 814 SKUs the tag would cost more than the gross margin on the item. Weight-sensing shelving and vision arrays across twelve branches is a capital programme an order of magnitude above the entire software budget under discussion.

The same applies, less starkly, to:

- **ML demand forecasting using weather and hyper-local demographics** (§6.3). There is no clean sales history to train on — book stock disagreed with physical stock on 100% of counted lines. A forecasting model over that data would produce confident nonsense. This becomes possible roughly twelve months *after* the ledger is trustworthy, not before.
- **A full double-entry general ledger with P&L and balance sheet** (§2, §7.1). They already run QuickBooks. Building an accounting system to replace it is a second product. Export to QuickBooks instead.
- **Autonomous PO generation** (§6.2). Reordering automatically from stock figures that are currently wrong would automate the error. Suggested ordering with human approval first; autonomy later, if ever.

**Recommended framing for the client:** we are not cutting their vision, we are sequencing it. Nothing in §6 works until §3 and §4 have produced a year of trustworthy data. Building the IoT layer first would be building the roof before the foundation.

---

## 4. Timeline

The SRS proposes 30 weeks across four phases, then pilot and rollout.

Phase 0 (weeks 1–4) and Phase 1 (weeks 5–14) are broadly realistic for the core ERP, cash position and custody engine. Phase 2 (weeks 15–22) for offline POS plus the security control infrastructure is tight but achievable.

Phase 3 as written — ML forecasting, autonomous PO generation, IoT stock hooks, and the full multi-period reporting engine in eight weeks — is not a schedule, it is a wish. That scope alone is a multi-year programme for a small team.

The 30-week frame works if, and only if, Phase 3 is replaced with fiscalisation and the reporting suite. Which is what it should have contained anyway.

---

## 5. Proposed Release 1

Everything below is derived from the SRS. Nothing has been invented and nothing has been deleted — items are either **in**, **deferred** with a trigger condition, or **replaced** with a cheaper thing that achieves the same intent.

### In — Release 1 (~30 weeks, matching their frame)

| SRS ref | Item | Why it earns a place |
|---|---|---|
| §1.3 | Append-only event ledger, offline-first sync | Foundation. Everything else assumes it. Built and proven — see `proto/ledger_proof.py` |
| §2 Retailware | Pack hierarchy, case-to-single conversion | Probable root cause of the USD 214k variance |
| §2 Retailware | GTIN/EAN validation, one barcode → one pack | Kills the four-record Three Leaves defect |
| §5.1 | Unlisted barcode scan capture + terminal lock | Cheap, high-value, directly targets under-the-counter sales |
| §5.2 | Blind shift cash-up | Cheap, and the single best cash control in the document |
| §5.2 | POS tamper lock — voids, overrides, refunds behind manager auth + reason code | Their stated "override to their own benefit" problem |
| §3.1 | Cash position across till / safe / CIT / bank / petty cash | Genuinely needed and not hard |
| §3.2 | Cash collection handover with named collector | **Names and staff IDs yes. National ID optional** — see §2.2 above |
| §4.1–4.2 | Dispatch, in-transit state, receiving variance ticket | Warehouse→branch is core to their operating model |
| §2 Novel | Batch and FEFO expiry | Perishables; low cost once the ledger exists |
| §2 QuickBooks | 3-way match PO/GRN/invoice | Closes the `N/A` supplier hole |
| §8 | RBAC, 8 roles, immutable audit log | Their auditor is the sponsor |
| §7 | Reporting suite — financial, inventory, logistics, procurement, sales, loss prevention | Reports over a trustworthy ledger are cheap |
| **Not in SRS** | **ZIMRA FDMS fiscalisation, VAT, fiscal day, QR receipts** | **Legal blocker. Added.** |
| **Not in SRS** | **Data protection: ID vault, retention policy, POTRAZ notification** | **Legal blocker. Added.** |

### Deferred — with a named trigger

| SRS ref | Item | Trigger to revisit |
|---|---|---|
| §6.3 | ML demand forecasting | 12 months of clean ledger data at ≥3 branches |
| §6.2 | Autonomous PO generation | Suggested ordering accepted without amendment ≥80% of the time for one quarter |
| §2, §7.1 | Double-entry GL, P&L, balance sheet | Only if they decide to retire QuickBooks. Export first |
| §2 SalesIntellect | Biometric clock-in | POTRAZ biometric licence obtained and a business case made |
| §6.1 | RFID / weight-sensing / vision stocktaking | Capital budget approved separately. Not a software decision |

### Replaced

| SRS wanted | Release 1 delivers instead | Rationale |
|---|---|---|
| Human-free perpetual stocktaking via IoT (§6.1) | Scanner-driven **cycle counting** with blind entry and enforced posting | ~1% of the cost, addresses the same failure (571 of 814 items never counted), works on a phone |
| Automated hourly discrepancy detection via sensors (§6.1) | Nightly ledger-vs-count exception job into the same queue | Same output, no hardware |
| Autonomous reordering (§6.2) | Reorder points with **suggested** POs for approval | Automating a wrong number just makes it faster |

---

## 6. Still unanswered

The SRS answers none of the blocking questions from the discovery report. It is a specification of wants, not a set of decisions.

Still outstanding and still blocking a price:

1. Group monthly turnover
2. VAT registration status — now doubly urgent, since fiscalisation is missing from their own spec
3. Exact branch and terminal counts
4. Budget authority and budget range
5. Whether they hold a POTRAZ data controller licence

Item 2 should be asked this week regardless of anything else in this document.

---

## 7. What has been built

`db/001_core.sql` and `proto/ledger_proof.py`. The core domain model, and twelve executable proofs that each of their documented failures is now unrepresentable.

This work survives every scope decision above. Whatever gets cut from §5, the ledger underneath it does not change.
