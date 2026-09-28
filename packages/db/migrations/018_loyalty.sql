-- Loyalty points.
--
-- A named customer earns points on what they pay for, and can spend them at
-- the till like money. Points live in their own append-only ledger, like stock
-- and cash: a balance is the sum of the movements, never a number that is
-- overwritten. Every movement says why: earned on a sale, spent on a sale, or
-- adjusted by a manager (with a note, and raised for review).
--
-- Off until the business switches it on. The rate (points per dollar) and the
-- value of a point are settings, read at the moment of each sale.

ALTER TYPE exception_kind ADD VALUE 'loyalty_adjustment';

CREATE TYPE loyalty_reason AS ENUM ('earn', 'redeem', 'adjust');

CREATE TABLE loyalty_movement (
    seq          bigserial PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE,
    customer_id  uuid NOT NULL REFERENCES customer(id),
    points       integer NOT NULL CHECK (points <> 0),
    reason       loyalty_reason NOT NULL,
    sale_id      uuid REFERENCES sale(id),
    branch_id    uuid NOT NULL REFERENCES branch(id),
    note         text,
    actor_id     uuid NOT NULL REFERENCES person(id),
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT loyalty_movement_shape CHECK (
        (reason = 'earn'   AND points > 0 AND sale_id IS NOT NULL) OR
        (reason = 'redeem' AND points < 0 AND sale_id IS NOT NULL) OR
        (reason = 'adjust' AND sale_id IS NULL AND note IS NOT NULL AND length(trim(note)) > 0)
    )
);
-- A sale earns once and spends once.
CREATE UNIQUE INDEX loyalty_one_per_sale ON loyalty_movement (sale_id, reason) WHERE sale_id IS NOT NULL;
CREATE INDEX loyalty_movement_customer ON loyalty_movement (customer_id, seq);

CREATE OR REPLACE FUNCTION loyalty_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'loyalty_movement is append-only: post an adjustment instead of %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_movement_no_update
    BEFORE UPDATE OR DELETE ON loyalty_movement
    FOR EACH ROW EXECUTE FUNCTION loyalty_is_append_only();

-- Every customer, with their points (zero when they have none).
CREATE VIEW loyalty_balance AS
SELECT c.id AS customer_id,
       coalesce(sum(m.points) FILTER (WHERE m.reason = 'earn'), 0)::integer   AS earned,
       coalesce(-sum(m.points) FILTER (WHERE m.reason = 'redeem'), 0)::integer AS redeemed,
       coalesce(sum(m.points) FILTER (WHERE m.reason = 'adjust'), 0)::integer AS adjusted,
       coalesce(sum(m.points), 0)::integer                                   AS points
FROM customer c
LEFT JOIN loyalty_movement m ON m.customer_id = c.id
GROUP BY c.id;

-- Spending points at the till is a way of paying. It is not cash and does not touch the till.
INSERT INTO payment_type (id, name, is_cash, at_till, for_suppliers, sort_order) VALUES
    ('loyalty', 'Loyalty points', false, true, false, 85);

INSERT INTO system_setting (key, value) VALUES
    ('loyalty_enabled', 'no'),
    ('loyalty_points_per_dollar', '1'),
    ('loyalty_point_value', '0.01')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permission (id, description) VALUES
    ('customer.enrol', 'Sign up a new customer at the till (name and phone, no credit)'),
    ('loyalty.adjust', 'Add or take away a customer''s loyalty points by hand');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('cashier',        'customer.enrol'),
    ('supervisor',     'customer.enrol'),
    ('branch_manager', 'customer.enrol'),
    ('finance',        'customer.enrol'),
    ('administrator',  'customer.enrol'),
    ('branch_manager', 'loyalty.adjust'),
    ('administrator',  'loyalty.adjust');
