-- Returns to suppliers (purchase returns), and paying suppliers in cash.
--
-- A purchase return note (PRN) sends goods back to the supplier: damaged,
-- expired, wrong, or over-delivered. It takes the stock off the books at what
-- it cost, and reduces what is owed to the supplier (the supplier's credit
-- note). Like every document here it is numbered without gaps, immutable, and
-- posted together with its stock movements or not at all.
--
-- Paying a supplier in cash now takes the cash out of a named cash point (the
-- safe, petty cash), so that point's expected cash is right at the next count.

-- Added only; nothing in this migration uses them.
ALTER TYPE cash_reason ADD VALUE 'supplier_payment';
ALTER TYPE cash_reason ADD VALUE 'supplier_payment_void';

CREATE TABLE purchase_return (
    id                 uuid PRIMARY KEY,                -- made by the client: a retry is the same return
    prn_no             text NOT NULL UNIQUE,
    supplier_id        uuid NOT NULL REFERENCES supplier(id),
    branch_id          uuid NOT NULL REFERENCES branch(id),
    grn_id             uuid REFERENCES goods_received(id), -- the delivery the goods came in on, if known
    returned_by        uuid NOT NULL REFERENCES person(id),
    returned_at        timestamptz NOT NULL,
    reason             text NOT NULL CHECK (length(trim(reason)) >= 3),
    credit_note_no     text,                              -- the supplier's own credit note, when it comes
    total_cost         numeric(14,2) NOT NULL CHECK (total_cost >= 0),
    recorded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON purchase_return (supplier_id, returned_at);
CREATE INDEX ON purchase_return (branch_id, returned_at);
CREATE INDEX ON purchase_return (grn_id);

CREATE TABLE purchase_return_line (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id     uuid NOT NULL REFERENCES purchase_return(id),
    line_no       integer NOT NULL,
    grn_line_id   uuid REFERENCES goods_received_line(id),
    product_id    uuid NOT NULL REFERENCES product(id),
    pack_id       uuid NOT NULL REFERENCES product_pack(id),
    qty_packs     numeric(14,4) NOT NULL CHECK (qty_packs > 0),
    qty_base      numeric(14,4) NOT NULL CHECK (qty_base > 0),
    unit_cost     numeric(14,4) NOT NULL CHECK (unit_cost >= 0),   -- per pack, what the supplier credits
    line_total    numeric(14,2) NOT NULL CHECK (line_total >= 0),
    movement_seq  bigint NOT NULL UNIQUE REFERENCES stock_movement(seq),
    UNIQUE (return_id, line_no)
);
CREATE INDEX ON purchase_return_line (return_id);
CREATE INDEX ON purchase_return_line (grn_line_id);
CREATE INDEX ON purchase_return_line (product_id);

CREATE TRIGGER purchase_return_immutable BEFORE UPDATE OR DELETE ON purchase_return
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER purchase_return_line_immutable BEFORE UPDATE OR DELETE ON purchase_return_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- A cash payment says which cash point the money came out of.
ALTER TABLE supplier_payment ADD COLUMN cash_point_id uuid REFERENCES cash_point(id);

-- The payment guard compares every column except the void fields; the new
-- column must be as fixed as the rest.
CREATE OR REPLACE FUNCTION supplier_payment_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE is not allowed on supplier_payment - void it instead';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'a voided payment cannot be changed';
    END IF;
    IF (NEW.id, NEW.payment_no, NEW.supplier_id, NEW.amount, NEW.payment_type_id, NEW.reference, NEW.paid_at, NEW.po_id, NEW.grn_id, NEW.note, NEW.recorded_by, NEW.recorded_at, NEW.cash_point_id)
       IS DISTINCT FROM
       (OLD.id, OLD.payment_no, OLD.supplier_id, OLD.amount, OLD.payment_type_id, OLD.reference, OLD.paid_at, OLD.po_id, OLD.grn_id, OLD.note, OLD.recorded_by, OLD.recorded_at, OLD.cash_point_id) THEN
        RAISE EXCEPTION 'a payment can only be voided, not edited';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- What is owed: goods received, less goods returned, less payments.
-- Replaced in place: the existing columns keep their names and order, and the
-- returned cost is added at the end.
CREATE OR REPLACE VIEW supplier_balance AS
SELECT s.id AS supplier_id,
       coalesce(g.received, 0)                                          AS received_cost,
       coalesce(p.paid, 0)                                              AS paid,
       coalesce(g.received, 0) - coalesce(r.returned, 0) - coalesce(p.paid, 0) AS balance,
       coalesce(r.returned, 0)                                          AS returned_cost
FROM supplier s
LEFT JOIN (SELECT supplier_id, sum(total_cost) AS received FROM goods_received GROUP BY supplier_id) g ON g.supplier_id = s.id
LEFT JOIN (SELECT supplier_id, sum(total_cost) AS returned FROM purchase_return GROUP BY supplier_id) r ON r.supplier_id = s.id
LEFT JOIN (SELECT supplier_id, sum(amount) AS paid FROM supplier_payment WHERE voided_at IS NULL GROUP BY supplier_id) p ON p.supplier_id = s.id;

-- Returning goods is a buying decision that changes what is owed: the people
-- who order, not the person who happens to be at the back door.
INSERT INTO permission (id, description) VALUES
    ('purchase.return', 'Return goods to a supplier (purchase return notes)');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('stock_controller', 'purchase.return'),
    ('branch_manager',   'purchase.return'),
    ('administrator',    'purchase.return');
