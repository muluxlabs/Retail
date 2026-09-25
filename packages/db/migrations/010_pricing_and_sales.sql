-- ============================================================================
--  Migration 010: selling prices, and sales as documents
--
--  Until now the system recorded that stock left at a till, and nothing else:
--  no price, no receipt, no total, no way to sell more than one item at once.
--  That is why every report showed units sold and never a dollar figure - it
--  would have been invented. This migration gives a sale what an accountant
--  expects a sale to have:
--
--    a selling price          on the pack, because a case and a single are
--                             priced differently
--    a sales receipt          a document, numbered without gaps per branch,
--                             with lines, payments and change
--    cost of sales            captured on every line AT THE MOMENT OF SALE,
--                             so gross profit is a fact and not an estimate
--
--  Sales documents are immutable, like the ledgers. A mistake is corrected by
--  a return or a void document that refers to the original, never by editing
--  it (a later migration adds those).
-- ============================================================================

-- -- selling price ------------------------------------------------------------
-- Nullable: a product with no price yet cannot be sold, and says so, rather
-- than selling for nothing.
ALTER TABLE product_pack
    ADD COLUMN sell_price numeric(14,2) CHECK (sell_price IS NULL OR sell_price >= 0);

-- -- how people pay ------------------------------------------------------------
-- Data, not an enum, so the business can add "InnBucks" without a deploy. Used
-- by customers at the till and (later) by the business paying suppliers.
CREATE TABLE payment_type (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    -- Cash is the one tender a customer can overpay with, and the one that
    -- moves a till's cash position.
    is_cash       boolean NOT NULL DEFAULT false,
    at_till       boolean NOT NULL DEFAULT true,
    for_suppliers boolean NOT NULL DEFAULT false,
    is_active     boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 0
);

INSERT INTO payment_type (id, name, is_cash, at_till, for_suppliers, sort_order) VALUES
    ('cash',          'Cash',                    true,  true,  true,  10),
    ('mobile_money',  'EcoCash / mobile money',  false, true,  true,  20),
    ('card',          'Card / swipe',            false, true,  true,  30),
    ('bank_transfer', 'Bank transfer',           false, false, true,  40),
    ('cheque',        'Cheque',                  false, false, true,  50),
    ('other',         'Other',                   false, true,  true,  90);

-- -- gapless numbering per branch ------------------------------------------------
-- A database sequence skips a number every time a transaction rolls back; a
-- receipt book with holes is what an auditor asks about. This is a row that is
-- incremented inside the same transaction as the document, so a sale that
-- fails takes no number. It is taken LAST in the transaction to keep the lock
-- on it short.
CREATE TABLE document_counter (
    branch_id uuid NOT NULL REFERENCES branch(id),
    doc_kind  text NOT NULL,
    last_no   bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, doc_kind)
);

-- -- the sale document -----------------------------------------------------------
CREATE OR REPLACE FUNCTION document_is_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        '% is not allowed on % - financial documents are immutable; correct it with a return or a void document instead',
        TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE sale (
    -- Supplied by the client before it sends the sale, so a retry after a
    -- dropped connection is recognised as the same sale and not a second one.
    id             uuid PRIMARY KEY,
    receipt_no     text NOT NULL UNIQUE,          -- 'KANA-000123', per branch, gapless
    branch_id      uuid NOT NULL REFERENCES branch(id),
    terminal_id    uuid REFERENCES terminal(id),
    cash_point_id  uuid REFERENCES cash_point(id), -- the till that took the cash, if any
    cashier_id     uuid NOT NULL REFERENCES person(id),

    occurred_at    timestamptz NOT NULL,
    recorded_at    timestamptz NOT NULL DEFAULT now(),

    -- gross - discount = net (what the customer owes). Enforced by the
    -- database, not trusted from the application.
    gross_total    numeric(14,2) NOT NULL CHECK (gross_total >= 0),
    discount_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
    net_total      numeric(14,2) NOT NULL CHECK (net_total >= 0),
    tendered_total numeric(14,2) NOT NULL,
    change_given   numeric(14,2) NOT NULL DEFAULT 0 CHECK (change_given >= 0),
    currency       char(3) NOT NULL DEFAULT 'USD',

    CONSTRAINT sale_net_is_gross_less_discount CHECK (net_total = gross_total - discount_total),
    CONSTRAINT sale_tendered_less_change_is_net CHECK (tendered_total - change_given = net_total)
);

CREATE INDEX ON sale (branch_id, occurred_at);
CREATE INDEX ON sale (cashier_id, occurred_at);
CREATE INDEX ON sale (occurred_at);

CREATE TABLE sale_line (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id       uuid NOT NULL REFERENCES sale(id),
    line_no       integer NOT NULL,

    product_id    uuid NOT NULL REFERENCES product(id),
    pack_id       uuid NOT NULL REFERENCES product_pack(id),

    qty_packs     numeric(14,4) NOT NULL CHECK (qty_packs > 0),
    qty_base      numeric(14,4) NOT NULL CHECK (qty_base > 0),

    -- What the list said, and what was charged. They differ only when someone
    -- with authority overrode the price - and that raised an exception.
    list_price    numeric(14,2),
    unit_price    numeric(14,2) NOT NULL CHECK (unit_price >= 0),
    discount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    line_total    numeric(14,2) NOT NULL CHECK (line_total >= 0),

    -- Weighted-average cost per BASE unit at the moment of sale. Cost of sales
    -- is qty_base * unit_cost. NULL when nothing costed had ever been received,
    -- and reports say so instead of treating it as zero.
    unit_cost     numeric(14,4),

    -- The stock movement this line posted. One to one, so a line and the
    -- ledger entry it caused can never drift apart.
    movement_seq  bigint NOT NULL UNIQUE REFERENCES stock_movement(seq),

    UNIQUE (sale_id, line_no)
);

CREATE INDEX ON sale_line (product_id);
CREATE INDEX ON sale_line (sale_id);

CREATE TABLE sale_payment (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id         uuid NOT NULL REFERENCES sale(id),
    payment_type_id text NOT NULL REFERENCES payment_type(id),
    -- What this payment covers of the bill (the books see this)...
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    -- ...and what the customer actually handed over (a $10 note for a $7.50 bill).
    tendered        numeric(14,2) NOT NULL,
    reference       text,
    CONSTRAINT sale_payment_tendered_covers_amount CHECK (tendered >= amount)
);

CREATE INDEX ON sale_payment (sale_id);

CREATE TRIGGER sale_immutable BEFORE UPDATE OR DELETE ON sale
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER sale_line_immutable BEFORE UPDATE OR DELETE ON sale_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER sale_payment_immutable BEFORE UPDATE OR DELETE ON sale_payment
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- -- cash from sales reaches the till -----------------------------------------------
-- Without this the till's expected cash could never include what it took, and
-- a blind cash-up would always show a "variance" equal to the day's takings.
-- New value only; nothing in this migration uses it.
ALTER TYPE cash_reason ADD VALUE 'sales_receipts';

-- -- the business profile printed on a receipt -------------------------------------------
INSERT INTO system_setting (key, value) VALUES
    ('business_name',    'Retail Operations'),
    ('business_address', ''),
    ('business_phone',   ''),
    ('business_tin',     ''),
    ('receipt_footer',   'Thank you for shopping with us.'),
    ('receipt_width_mm', '80');

-- -- who may do what ---------------------------------------------------------------------
INSERT INTO permission (id, description) VALUES
    ('price.write', 'Set and change selling prices'),
    ('sale.read',   'See sales receipts and sales, cost and profit reports');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('stock_controller', 'price.write'),
    ('branch_manager',   'price.write'),
    ('administrator',    'price.write'),

    ('supervisor',       'sale.read'),
    ('branch_manager',   'sale.read'),
    ('auditor',          'sale.read'),
    ('finance',          'sale.read'),
    ('administrator',    'sale.read');
