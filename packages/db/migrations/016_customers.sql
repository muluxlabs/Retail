-- Customers on credit (debtors).
--
-- A customer can be allowed to buy on account up to a credit limit, and pay
-- later. What a customer owes is never stored: it is sales charged to their
-- account less payments received (a view). Payments from customers are
-- numbered without gaps, never edited, and voided with a reason.

-- Added only; nothing in this migration uses them.
ALTER TYPE cash_reason ADD VALUE 'customer_payment';
ALTER TYPE cash_reason ADD VALUE 'customer_payment_void';
ALTER TYPE exception_kind ADD VALUE 'credit_limit_change';

CREATE SEQUENCE customer_code_seq;

CREATE TABLE customer (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE DEFAULT ('CUS-' || lpad(nextval('customer_code_seq')::text, 4, '0')),
    name          text NOT NULL,
    phone         text,
    email         text,
    address       text,
    id_number     text,
    -- How much the customer may owe at once. 0 = no credit: cash customers only.
    credit_limit  numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    -- Days after a sale that it must be paid.
    credit_days   integer NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 0 AND 365),
    notes         text,
    is_active     boolean NOT NULL DEFAULT true,
    created_by    uuid REFERENCES person(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_name_search ON customer (lower(name));
CREATE UNIQUE INDEX customer_phone_unique ON customer (phone) WHERE phone IS NOT NULL;

-- A sale may be to a named customer; charged to their account when paid "on account".
ALTER TABLE sale ADD COLUMN customer_id uuid REFERENCES customer(id);
CREATE INDEX ON sale (customer_id) WHERE customer_id IS NOT NULL;

-- The till's payment method for charging a customer's account. Not cash, not for suppliers.
INSERT INTO payment_type (id, name, is_cash, at_till, for_suppliers, sort_order) VALUES
    ('account', 'On account (credit)', false, true, false, 80);

CREATE TABLE customer_payment (
    id              uuid PRIMARY KEY,                    -- made by the client: a retry is the same payment
    receipt_no      text NOT NULL UNIQUE,
    customer_id     uuid NOT NULL REFERENCES customer(id),
    branch_id       uuid NOT NULL REFERENCES branch(id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    payment_type_id text NOT NULL REFERENCES payment_type(id) CHECK (payment_type_id <> 'account'),
    reference       text,
    cash_point_id   uuid REFERENCES cash_point(id),
    received_at     timestamptz NOT NULL,
    note            text,
    recorded_by     uuid NOT NULL REFERENCES person(id),
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    voided_at       timestamptz,
    voided_by       uuid REFERENCES person(id),
    void_reason     text,
    CONSTRAINT customer_payment_void_is_complete CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ON customer_payment (customer_id, received_at);

CREATE OR REPLACE FUNCTION customer_payment_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE is not allowed on customer_payment - void it instead';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'a voided payment cannot be changed';
    END IF;
    IF (NEW.id, NEW.receipt_no, NEW.customer_id, NEW.branch_id, NEW.amount, NEW.payment_type_id, NEW.reference, NEW.cash_point_id, NEW.received_at, NEW.note, NEW.recorded_by, NEW.recorded_at)
       IS DISTINCT FROM
       (OLD.id, OLD.receipt_no, OLD.customer_id, OLD.branch_id, OLD.amount, OLD.payment_type_id, OLD.reference, OLD.cash_point_id, OLD.received_at, OLD.note, OLD.recorded_by, OLD.recorded_at) THEN
        RAISE EXCEPTION 'a customer payment can only be voided, not edited';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_payment_guard BEFORE UPDATE OR DELETE ON customer_payment
    FOR EACH ROW EXECUTE FUNCTION customer_payment_guard();

-- What each customer owes: sales charged to account, less payments not voided.
CREATE VIEW customer_balance AS
SELECT c.id AS customer_id,
       coalesce(s.charged, 0)                       AS charged,
       coalesce(p.paid, 0)                          AS paid,
       coalesce(s.charged, 0) - coalesce(p.paid, 0) AS balance
FROM customer c
LEFT JOIN (SELECT sa.customer_id, sum(sp.amount) AS charged
           FROM sale sa JOIN sale_payment sp ON sp.sale_id = sa.id AND sp.payment_type_id = 'account'
           GROUP BY sa.customer_id) s ON s.customer_id = c.id
LEFT JOIN (SELECT customer_id, sum(amount) AS paid FROM customer_payment WHERE voided_at IS NULL GROUP BY customer_id) p ON p.customer_id = c.id;

INSERT INTO permission (id, description) VALUES
    ('customer.read',    'See customers, what they owe and their statements'),
    ('customer.write',   'Add and change customers, and set credit limits'),
    ('customer.receive', 'Receive payments from customers on their accounts');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('administrator',  'customer.read'),
    ('administrator',  'customer.write'),
    ('administrator',  'customer.receive'),
    ('finance',        'customer.read'),
    ('finance',        'customer.write'),
    ('finance',        'customer.receive'),
    ('branch_manager', 'customer.read'),
    ('branch_manager', 'customer.write'),
    ('branch_manager', 'customer.receive'),
    ('supervisor',     'customer.read'),
    ('supervisor',     'customer.receive'),
    ('cashier',        'customer.receive'),
    ('auditor',        'customer.read');
