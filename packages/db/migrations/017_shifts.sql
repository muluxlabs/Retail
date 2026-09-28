-- Cashier shifts.
--
-- A shift is one cashier's session on one till. It opens with the cashier
-- counting the float: if that does not match what the books expect, the
-- difference is posted then and there, so the new cashier does not inherit
-- someone else's shortage. Every sale records the shift it was rung up in.
-- It closes with a blind count; any over or short is posted to the till and
-- attributed to that cashier.
--
-- One open shift per till, and one per cashier. A shift's opening is fixed
-- once written, and its closing can be written exactly once.

ALTER TYPE exception_kind ADD VALUE 'shift_variance';

CREATE TABLE shift (
    id                uuid PRIMARY KEY,                  -- made by the client: a retry is the same shift
    shift_no          text NOT NULL UNIQUE,
    branch_id         uuid NOT NULL REFERENCES branch(id),
    cash_point_id     uuid NOT NULL REFERENCES cash_point(id),
    cashier_id        uuid NOT NULL REFERENCES person(id),
    opened_at         timestamptz NOT NULL,
    opened_by         uuid NOT NULL REFERENCES person(id),
    opening_expected  numeric(14,2) NOT NULL,
    opening_counted   numeric(14,2) NOT NULL CHECK (opening_counted >= 0),
    opening_variance  numeric(14,2) NOT NULL,
    closed_at         timestamptz,
    closed_by         uuid REFERENCES person(id),
    closing_expected  numeric(14,2),
    closing_counted   numeric(14,2) CHECK (closing_counted IS NULL OR closing_counted >= 0),
    closing_variance  numeric(14,2),
    note              text,
    CONSTRAINT shift_opening_adds_up CHECK (opening_counted - opening_expected = opening_variance),
    CONSTRAINT shift_close_is_complete CHECK (
        (closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (closing_expected IS NULL)
        AND (closed_at IS NULL) = (closing_counted IS NULL) AND (closed_at IS NULL) = (closing_variance IS NULL)),
    CONSTRAINT shift_closing_adds_up CHECK (closed_at IS NULL OR closing_counted - closing_expected = closing_variance),
    CONSTRAINT shift_closes_after_it_opens CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE UNIQUE INDEX shift_one_open_per_till ON shift (cash_point_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX shift_one_open_per_cashier ON shift (cashier_id) WHERE closed_at IS NULL;
CREATE INDEX ON shift (branch_id, opened_at);
CREATE INDEX ON shift (cashier_id, opened_at);

-- The opening is fixed; the closing is written once and then fixed too.
CREATE OR REPLACE FUNCTION shift_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE is not allowed on shift';
    END IF;
    IF OLD.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'a closed shift cannot be changed';
    END IF;
    IF (NEW.id, NEW.shift_no, NEW.branch_id, NEW.cash_point_id, NEW.cashier_id, NEW.opened_at, NEW.opened_by,
        NEW.opening_expected, NEW.opening_counted, NEW.opening_variance)
       IS DISTINCT FROM
       (OLD.id, OLD.shift_no, OLD.branch_id, OLD.cash_point_id, OLD.cashier_id, OLD.opened_at, OLD.opened_by,
        OLD.opening_expected, OLD.opening_counted, OLD.opening_variance) THEN
        RAISE EXCEPTION 'a shift''s opening cannot be changed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shift_guard BEFORE UPDATE OR DELETE ON shift FOR EACH ROW EXECUTE FUNCTION shift_guard();

-- Which shift a sale was rung up in (none for sales before shifts, or where they are not used).
ALTER TABLE sale ADD COLUMN shift_id uuid REFERENCES shift(id);
CREATE INDEX ON sale (shift_id) WHERE shift_id IS NOT NULL;

-- Whether a till refuses to sell without an open shift. Off until the business switches it on.
INSERT INTO system_setting (key, value) VALUES ('shifts_required', 'no') ON CONFLICT (key) DO NOTHING;

INSERT INTO permission (id, description) VALUES
    ('shift.open',   'Open and close your own shift on a till'),
    ('shift.manage', 'Close another cashier''s shift, and see every shift');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('cashier',        'shift.open'),
    ('supervisor',     'shift.open'),
    ('supervisor',     'shift.manage'),
    ('branch_manager', 'shift.open'),
    ('branch_manager', 'shift.manage'),
    ('administrator',  'shift.open'),
    ('administrator',  'shift.manage');
