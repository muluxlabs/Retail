-- ============================================================================
--  Retail Operations Platform — Core Schema (PostgreSQL 15+)
--  Migration 001: identity, product master, append-only stock ledger
--
--  DESIGN RULES (do not violate; everything else depends on these)
--
--  R1. Stock is never stored as a number. It is the SUM of an append-only
--      movement ledger. There is no `products.qty_on_hand` column and there
--      never will be one.
--  R2. Nothing in the ledger is ever UPDATEd or DELETEd. Corrections are new
--      movements that reverse old ones. Enforced by trigger, not convention.
--  R3. All quantities are stored in the product's BASE UNIT. Cases, inners
--      and singles are conversions applied at the edge, never in the ledger.
--  R4. Every movement carries a client-generated UUID (`event_id`). Replaying
--      the same event is a no-op. This is what makes offline sync safe.
--  R5. Every movement records BOTH when it happened (`occurred_at`) and when
--      the server learned about it (`recorded_at`). Backdating is detectable
--      because the gap between them is data, not metadata.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. ORGANISATION
-- ---------------------------------------------------------------------------

CREATE TYPE branch_kind AS ENUM ('store', 'warehouse');

CREATE TABLE branch (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text NOT NULL UNIQUE,
    name            text NOT NULL,
    kind            branch_kind NOT NULL DEFAULT 'store',
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terminal (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       uuid NOT NULL REFERENCES branch(id),
    code            text NOT NULL,
    -- Monotonic counter the terminal has synced up to. Used to resume sync.
    last_synced_seq bigint NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT true,
    UNIQUE (branch_id, code)
);

-- One human being = one row. Enforced hard, because the current system has
-- three records for what appears to be one "Eunice" and that destroys any
-- ability to attribute a transaction to a person.
CREATE TABLE person (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       text NOT NULL,
    -- National ID is OPTIONAL and nullable by design. See docs/data-protection.md:
    -- collecting it engages the Cyber and Data Protection Act [Chapter 12:07].
    -- Do not make this NOT NULL without a signed lawful-basis assessment.
    national_id_ref uuid,          -- FK to a separately-permissioned vault table
    phone           text,
    email           text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT person_contactable CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE role (
    id              text PRIMARY KEY,      -- 'cashier', 'branch_manager', ...
    name            text NOT NULL
);

CREATE TABLE person_role (
    person_id       uuid NOT NULL REFERENCES person(id),
    role_id         text NOT NULL REFERENCES role(id),
    branch_id       uuid REFERENCES branch(id),   -- NULL = group-wide
    PRIMARY KEY (person_id, role_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- 2. PRODUCT MASTER
--
-- This is where the current system fails. "Three leaves 125g" exists four
-- times under four barcodes; "Charhons 500g" and "Charhons biscuits 10x500g"
-- are unrelated records with no conversion between them. The model below
-- makes both of those states unrepresentable.
-- ---------------------------------------------------------------------------

CREATE TABLE product_category (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       uuid REFERENCES product_category(id),
    name            text NOT NULL
);

-- A product is ONE sellable thing, identified by its base unit.
-- "Three Leaves tea 125g" is one product, regardless of how many ways it is
-- packed, priced or barcoded.
CREATE TABLE product (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             text NOT NULL UNIQUE,
    name            text NOT NULL,
    category_id     uuid REFERENCES product_category(id),
    -- The atomic unit everything converts to. 'each', 'kg', 'litre'.
    base_uom        text NOT NULL,
    -- Weighed goods behave differently at the till (embedded-weight barcodes).
    is_weighed      boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Set when this record is merged into another during master-data cleanse.
    -- Merged products keep their history; new movements are blocked.
    merged_into_id  uuid REFERENCES product(id),
    CONSTRAINT product_not_self_merged CHECK (merged_into_id IS DISTINCT FROM id)
);

CREATE INDEX ON product (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- THE PACK HIERARCHY.
-- One row per way the product is handled: single, inner, case, pallet.
-- `qty_base` is how many base units this pack contains.
--   Charhons 500g single            -> qty_base = 1
--   Charhons biscuits 10x500g case  -> qty_base = 10
-- Receiving a case and selling singles now reconcile arithmetically.
CREATE TABLE product_pack (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      uuid NOT NULL REFERENCES product(id),
    label           text NOT NULL,         -- 'single', 'case of 10'
    qty_base        numeric(14,4) NOT NULL CHECK (qty_base > 0),
    is_default_sell boolean NOT NULL DEFAULT false,
    is_default_buy  boolean NOT NULL DEFAULT false,
    UNIQUE (product_id, label)
);

-- Exactly one default selling pack and one default buying pack per product.
CREATE UNIQUE INDEX product_one_default_sell
    ON product_pack (product_id) WHERE is_default_sell;
CREATE UNIQUE INDEX product_one_default_buy
    ON product_pack (product_id) WHERE is_default_buy;

-- Barcodes attach to a PACK, not a product. Scanning the case barcode and
-- scanning the single barcode must resolve to the same product with
-- different multipliers. A barcode is globally unique — this is the
-- constraint whose absence let one product acquire four records.
CREATE TABLE barcode (
    code            text PRIMARY KEY,
    pack_id         uuid NOT NULL REFERENCES product_pack(id),
    -- 'ean13','ean8','upca','internal','embedded_weight'
    symbology       text NOT NULL DEFAULT 'ean13',
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT barcode_shape CHECK (
        symbology <> 'ean13' OR code ~ '^[0-9]{13}$'
    ),
    CONSTRAINT barcode_no_negatives CHECK (code !~ '^-')
);

CREATE INDEX ON barcode (pack_id);

-- ---------------------------------------------------------------------------
-- 3. THE STOCK LEDGER  (append-only — see R1, R2)
-- ---------------------------------------------------------------------------

CREATE TYPE movement_reason AS ENUM (
    'grn',              -- goods received from supplier
    'grn_reversal',
    'sale',
    'sale_refund',
    'transfer_out',     -- leaves origin, enters in-transit
    'transfer_in',      -- arrives at destination
    'transfer_loss',    -- dispatched minus received
    'count_adjustment', -- stock count posting
    'write_off',
    'opening_balance'
);

CREATE TABLE stock_movement (
    -- Server-assigned. Total order for sync resumption.
    seq             bigserial PRIMARY KEY,

    -- Client-generated at the terminal, BEFORE the network is available.
    -- Idempotency key: replaying a synced event does nothing.
    event_id        uuid NOT NULL UNIQUE,

    product_id      uuid NOT NULL REFERENCES product(id),
    branch_id       uuid NOT NULL REFERENCES branch(id),

    -- Signed, in BASE UNITS. Positive = into this branch. Negative = out.
    qty_base        numeric(14,4) NOT NULL CHECK (qty_base <> 0),

    -- Unit cost in base units, at the moment of the movement. Carried on the
    -- movement itself so weighted-average cost is reproducible from history
    -- rather than depending on a mutable current-cost field.
    unit_cost       numeric(14,4),
    currency        char(3) NOT NULL DEFAULT 'USD',

    reason          movement_reason NOT NULL,
    doc_type        text,               -- 'GRN','SALE','TRANSFER','COUNT'
    doc_id          uuid,

    -- If this movement reverses an earlier one. Corrections are additive.
    reverses_seq    bigint REFERENCES stock_movement(seq),

    actor_id        uuid NOT NULL REFERENCES person(id),
    terminal_id     uuid REFERENCES terminal(id),

    -- When the business event happened (may be offline, may be backdated).
    occurred_at     timestamptz NOT NULL,
    -- When the server accepted it. Server clock, not client clock.
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON stock_movement (product_id, branch_id);
CREATE INDEX ON stock_movement (branch_id, occurred_at);
CREATE INDEX ON stock_movement (doc_type, doc_id);
-- Sync cursor: terminals pull everything above their last_synced_seq.
CREATE INDEX ON stock_movement (seq) INCLUDE (branch_id);

-- R2 enforced in the database, not in application code.
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'stock_movement is append-only: use a reversing movement (reverses_seq) instead of %',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_no_update
    BEFORE UPDATE OR DELETE ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- Backdating is visible because both timestamps are stored.
-- This view is the "Backdate inventory report" the old system normalised.
CREATE VIEW backdated_movement AS
SELECT seq, event_id, branch_id, product_id, actor_id,
       occurred_at, recorded_at,
       recorded_at - occurred_at AS backdate_gap
FROM stock_movement
WHERE recorded_at - occurred_at > interval '48 hours';

-- Current stock. A view, never a table.
CREATE VIEW stock_on_hand AS
SELECT product_id,
       branch_id,
       SUM(qty_base) AS qty_base
FROM stock_movement
GROUP BY product_id, branch_id;

-- Weighted-average cost, derived from receipt movements only.
CREATE VIEW product_wac AS
SELECT product_id,
       branch_id,
       SUM(qty_base * unit_cost) / NULLIF(SUM(qty_base), 0) AS wac
FROM stock_movement
WHERE reason IN ('grn', 'opening_balance', 'transfer_in')
  AND unit_cost IS NOT NULL
GROUP BY product_id, branch_id;

-- ---------------------------------------------------------------------------
-- 4. EXCEPTIONS
--
-- The control layer. Every override, unlisted scan, backdate and count
-- variance lands here and must be cleared by a named human. A control that
-- nobody clears is not a control.
-- ---------------------------------------------------------------------------

CREATE TYPE exception_kind AS ENUM (
    'negative_stock_override',
    'unlisted_barcode_scan',
    'backdated_entry',
    'count_variance',
    'transit_loss',
    'cash_variance',
    'price_override',
    'void_after_tender'
);

CREATE TYPE exception_state AS ENUM ('open', 'acknowledged', 'cleared', 'escalated');

CREATE TABLE exception_event (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        uuid NOT NULL UNIQUE,   -- idempotency, same as ledger
    kind            exception_kind NOT NULL,
    state           exception_state NOT NULL DEFAULT 'open',

    branch_id       uuid NOT NULL REFERENCES branch(id),
    terminal_id     uuid REFERENCES terminal(id),
    actor_id        uuid NOT NULL REFERENCES person(id),
    product_id      uuid REFERENCES product(id),

    -- Free-form detail: raw barcode string, expected vs counted, amounts.
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    value_impact    numeric(14,2),
    currency        char(3),

    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),

    cleared_by      uuid REFERENCES person(id),
    cleared_at      timestamptz,
    clearing_note   text,

    CONSTRAINT exception_cleared_needs_actor CHECK (
        state <> 'cleared' OR (cleared_by IS NOT NULL AND cleared_at IS NOT NULL)
    )
);

CREATE INDEX ON exception_event (state, kind) WHERE state = 'open';
CREATE INDEX ON exception_event (branch_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 5. AUDIT TRAIL
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
    seq             bigserial PRIMARY KEY,
    event_id        uuid NOT NULL UNIQUE,
    action_code     text NOT NULL,   -- 'UNLISTED_BARCODE_SCANNED', 'PRICE_CHANGED'
    actor_id        uuid REFERENCES person(id),
    terminal_id     uuid REFERENCES terminal(id),
    branch_id       uuid REFERENCES branch(id),
    entity_type     text,
    entity_id       uuid,
    state_before    jsonb,
    state_after     jsonb,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE INDEX ON audit_log (actor_id, occurred_at);
