-- Suppliers, purchase orders, goods received, and paying for them.
--
-- The buying side of the business, in the documents an auditor expects:
--
--   supplier            who we buy from, and on what payment terms
--   purchase_order      a request for supplies (what we asked for)
--   goods_received      a goods received note - GRN (what actually arrived, at what cost)
--   supplier_payment    money paid to a supplier, by what method, with proof
--
-- What is owed to a supplier is never stored: it is goods received at cost less
-- payments made (a view), so it can never drift from the documents behind it.
-- Goods received notes and payments are immutable; a mistake is corrected by a
-- later document (a void, and later a purchase return), never by editing.

CREATE TYPE supplier_terms AS ENUM (
    'prepaid',           -- paid before the goods are sent
    'cash_on_delivery',  -- paid when the goods arrive
    'credit'             -- paid some days after the goods arrive
);

-- -- suppliers ------------------------------------------------------------------------------
CREATE SEQUENCE supplier_code_seq;

CREATE TABLE supplier (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text NOT NULL UNIQUE DEFAULT ('SUP-' || lpad(nextval('supplier_code_seq')::text, 4, '0')),
    name           text NOT NULL,
    contact_person text,
    phone          text,
    email          text,
    address        text,
    tin            text,
    terms          supplier_terms NOT NULL DEFAULT 'credit',
    credit_days    integer CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
    notes          text,
    is_active      boolean NOT NULL DEFAULT true,
    created_by     uuid REFERENCES person(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- Only credit terms have a number of days.
    CONSTRAINT supplier_credit_days_only_on_credit CHECK (terms = 'credit' OR credit_days IS NULL)
);
CREATE UNIQUE INDEX supplier_name_unique ON supplier (lower(name));

-- -- gapless group-wide numbering (payments) --------------------------------------------------
-- document_counter is per branch; a payment belongs to the group, not a branch.
CREATE TABLE group_counter (
    doc_kind text PRIMARY KEY,
    last_no  bigint NOT NULL DEFAULT 0
);

-- -- purchase orders ------------------------------------------------------------------------------
CREATE TABLE purchase_order (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    po_no          text NOT NULL UNIQUE,
    supplier_id    uuid NOT NULL REFERENCES supplier(id),
    branch_id      uuid NOT NULL REFERENCES branch(id),   -- where the goods are to be delivered
    ordered_by     uuid NOT NULL REFERENCES person(id),
    ordered_at     timestamptz NOT NULL DEFAULT now(),
    expected_date  date,
    -- The terms this order was placed on (copied from the supplier, changeable per order).
    terms          supplier_terms NOT NULL,
    credit_days    integer CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
    notes          text,
    -- Set once. A cancelled order was never fulfilled; a closed one is finished
    -- short (the supplier cannot send the rest). Neither is ever deleted.
    cancelled_at   timestamptz,
    cancelled_by   uuid REFERENCES person(id),
    cancel_reason  text,
    closed_at      timestamptz,
    closed_by      uuid REFERENCES person(id),
    close_note     text,
    CONSTRAINT po_credit_days_only_on_credit CHECK (terms = 'credit' OR credit_days IS NULL),
    CONSTRAINT po_cancel_is_complete CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL) = (cancel_reason IS NULL)),
    CONSTRAINT po_not_both_cancelled_and_closed CHECK (cancelled_at IS NULL OR closed_at IS NULL)
);
CREATE INDEX ON purchase_order (supplier_id, ordered_at);
CREATE INDEX ON purchase_order (branch_id, ordered_at);

CREATE TABLE purchase_order_line (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id       uuid NOT NULL REFERENCES purchase_order(id),
    line_no     integer NOT NULL,
    product_id  uuid NOT NULL REFERENCES product(id),
    pack_id     uuid NOT NULL REFERENCES product_pack(id),
    qty_packs   numeric(14,4) NOT NULL CHECK (qty_packs > 0),
    qty_base    numeric(14,4) NOT NULL CHECK (qty_base > 0),
    -- The price agreed for ONE PACK.
    unit_cost   numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
    line_total  numeric(14,2) NOT NULL CHECK (line_total >= 0),
    UNIQUE (po_id, line_no)
);
CREATE INDEX ON purchase_order_line (po_id);
CREATE INDEX ON purchase_order_line (product_id);

-- An order's lines never change. Its header changes exactly once, to cancel or
-- close it, and nothing else on it may change.
CREATE OR REPLACE FUNCTION purchase_order_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE is not allowed on purchase_order - cancel it instead';
    END IF;
    IF OLD.cancelled_at IS NOT NULL OR OLD.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'a cancelled or closed purchase order cannot be changed';
    END IF;
    IF (NEW.id, NEW.po_no, NEW.supplier_id, NEW.branch_id, NEW.ordered_by, NEW.ordered_at, NEW.expected_date, NEW.terms, NEW.credit_days, NEW.notes)
       IS DISTINCT FROM
       (OLD.id, OLD.po_no, OLD.supplier_id, OLD.branch_id, OLD.ordered_by, OLD.ordered_at, OLD.expected_date, OLD.terms, OLD.credit_days, OLD.notes) THEN
        RAISE EXCEPTION 'a purchase order can only be cancelled or closed, not edited';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_order_guard BEFORE UPDATE OR DELETE ON purchase_order
    FOR EACH ROW EXECUTE FUNCTION purchase_order_guard();
CREATE TRIGGER purchase_order_line_immutable BEFORE UPDATE OR DELETE ON purchase_order_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- -- goods received notes ---------------------------------------------------------------------------
CREATE TABLE goods_received (
    id               uuid PRIMARY KEY,                    -- made by the client: a retry is the same GRN
    grn_no           text NOT NULL UNIQUE,
    supplier_id      uuid NOT NULL REFERENCES supplier(id),
    branch_id        uuid NOT NULL REFERENCES branch(id),
    po_id            uuid REFERENCES purchase_order(id),
    received_by      uuid NOT NULL REFERENCES person(id),
    received_at      timestamptz NOT NULL,
    -- The supplier's own paperwork, for matching their invoice to ours.
    supplier_invoice_no text,
    invoice_date     date,
    invoice_total    numeric(14,2) CHECK (invoice_total IS NULL OR invoice_total >= 0),
    notes            text,
    -- What was received, at cost: the sum of the lines. This is what is owed.
    total_cost       numeric(14,2) NOT NULL CHECK (total_cost >= 0),
    recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON goods_received (supplier_id, received_at);
CREATE INDEX ON goods_received (branch_id, received_at);
CREATE INDEX ON goods_received (po_id);

CREATE TABLE goods_received_line (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id        uuid NOT NULL REFERENCES goods_received(id),
    line_no       integer NOT NULL,
    po_line_id    uuid REFERENCES purchase_order_line(id),
    product_id    uuid NOT NULL REFERENCES product(id),
    pack_id       uuid NOT NULL REFERENCES product_pack(id),
    qty_packs     numeric(14,4) NOT NULL CHECK (qty_packs > 0),
    qty_base      numeric(14,4) NOT NULL CHECK (qty_base > 0),
    unit_cost     numeric(14,4) NOT NULL CHECK (unit_cost >= 0),   -- per pack
    line_total    numeric(14,2) NOT NULL CHECK (line_total >= 0),
    -- The stock movement this line posted, one to one.
    movement_seq  bigint NOT NULL UNIQUE REFERENCES stock_movement(seq),
    UNIQUE (grn_id, line_no)
);
CREATE INDEX ON goods_received_line (grn_id);
CREATE INDEX ON goods_received_line (po_line_id);
CREATE INDEX ON goods_received_line (product_id);

CREATE TRIGGER goods_received_immutable BEFORE UPDATE OR DELETE ON goods_received
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER goods_received_line_immutable BEFORE UPDATE OR DELETE ON goods_received_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- -- paying suppliers ------------------------------------------------------------------------------------
CREATE TABLE supplier_payment (
    id              uuid PRIMARY KEY,                    -- made by the client: a retry is the same payment
    payment_no      text NOT NULL UNIQUE,
    supplier_id     uuid NOT NULL REFERENCES supplier(id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    payment_type_id text NOT NULL REFERENCES payment_type(id),
    -- The bank's or cheque's own number, the mobile money transaction id.
    reference       text,
    paid_at         timestamptz NOT NULL,
    -- What it was paid FOR, if anything: an order (a prepayment) or a delivery.
    -- Neither: a payment on account.
    po_id           uuid REFERENCES purchase_order(id),
    grn_id          uuid REFERENCES goods_received(id),
    note            text,
    recorded_by     uuid NOT NULL REFERENCES person(id),
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    -- A payment recorded in error is voided, never deleted: the trail stays.
    voided_at       timestamptz,
    voided_by       uuid REFERENCES person(id),
    void_reason     text,
    CONSTRAINT payment_void_is_complete CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ON supplier_payment (supplier_id, paid_at);
CREATE INDEX ON supplier_payment (po_id);
CREATE INDEX ON supplier_payment (grn_id);

CREATE OR REPLACE FUNCTION supplier_payment_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE is not allowed on supplier_payment - void it instead';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'a voided payment cannot be changed';
    END IF;
    IF (NEW.id, NEW.payment_no, NEW.supplier_id, NEW.amount, NEW.payment_type_id, NEW.reference, NEW.paid_at, NEW.po_id, NEW.grn_id, NEW.note, NEW.recorded_by, NEW.recorded_at)
       IS DISTINCT FROM
       (OLD.id, OLD.payment_no, OLD.supplier_id, OLD.amount, OLD.payment_type_id, OLD.reference, OLD.paid_at, OLD.po_id, OLD.grn_id, OLD.note, OLD.recorded_by, OLD.recorded_at) THEN
        RAISE EXCEPTION 'a payment can only be voided, not edited';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_payment_guard BEFORE UPDATE OR DELETE ON supplier_payment
    FOR EACH ROW EXECUTE FUNCTION supplier_payment_guard();

-- Evidence of the payment: the bank transfer screenshot, the cheque stub, the
-- receipt. Kept in the database so it cannot be separated from the payment, and
-- never changed.
CREATE TABLE supplier_payment_proof (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id    uuid NOT NULL REFERENCES supplier_payment(id),
    file_name     text NOT NULL,
    content_type  text NOT NULL,
    size_bytes    integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 3145728),
    sha256        text NOT NULL,
    data          bytea NOT NULL,
    uploaded_by   uuid NOT NULL REFERENCES person(id),
    uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON supplier_payment_proof (payment_id);
CREATE TRIGGER supplier_payment_proof_immutable BEFORE UPDATE OR DELETE ON supplier_payment_proof
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- -- what is owed ---------------------------------------------------------------------------------------------------
-- Goods received at cost, less payments not voided. Positive: we owe the
-- supplier. Negative: the supplier holds money of ours (a prepayment).
CREATE VIEW supplier_balance AS
SELECT s.id AS supplier_id,
       coalesce(g.received, 0)                 AS received_cost,
       coalesce(p.paid, 0)                     AS paid,
       coalesce(g.received, 0) - coalesce(p.paid, 0) AS balance
FROM supplier s
LEFT JOIN (SELECT supplier_id, sum(total_cost) AS received FROM goods_received GROUP BY supplier_id) g ON g.supplier_id = s.id
LEFT JOIN (SELECT supplier_id, sum(amount) AS paid FROM supplier_payment WHERE voided_at IS NULL GROUP BY supplier_id) p ON p.supplier_id = s.id;

-- -- who may do what ---------------------------------------------------------------------------------------------------
INSERT INTO permission (id, description) VALUES
    ('supplier.read',  'See suppliers, purchase orders and goods received'),
    ('supplier.write', 'Add and change suppliers'),
    ('po.write',       'Order stock from suppliers (purchase orders)'),
    ('supplier.pay',   'Record and void payments to suppliers'),
    ('grn.post',       'Receive goods from suppliers into stock');

-- Ordering and paying are different hands on purpose: the person who orders
-- stock is not the person who pays for it.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('administrator',    'supplier.read'),
    ('administrator',    'supplier.write'),
    ('administrator',    'po.write'),
    ('administrator',    'supplier.pay'),

    ('branch_manager',   'supplier.read'),
    ('branch_manager',   'supplier.write'),
    ('branch_manager',   'po.write'),

    ('stock_controller', 'supplier.read'),
    ('stock_controller', 'supplier.write'),
    ('stock_controller', 'po.write'),

    ('receiver',         'supplier.read'),
    ('receiver',         'grn.post'),
    ('stock_controller', 'grn.post'),
    ('branch_manager',   'grn.post'),
    ('administrator',    'grn.post'),
    ('supervisor',       'supplier.read'),
    ('auditor',          'supplier.read'),

    ('finance',          'supplier.read'),
    ('finance',          'supplier.pay');
