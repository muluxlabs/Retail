-- End of day: the Z report.
--
-- Closing the day at a branch counts every till blind, posts any cash over or
-- short, and records one numbered, unchangeable document covering everything
-- since the branch's previous close: the receipts issued, sales, discounts,
-- net sales, cost of sales, takings by payment method and by cashier, and
-- expected against counted cash for each till.
--
-- A close covers a RANGE OF RECEIPT NUMBERS, not a stretch of clock time.
-- Receipt numbers are gapless and handed out under a lock, so each receipt is
-- in exactly one Z report; a sale still being rung up while the day is closed
-- gets the next number and lands on the next report instead of falling between
-- two. Closes follow one another: each starts where the previous one ended.

CREATE TABLE day_close (
    id              uuid PRIMARY KEY,                   -- made by the client: a retry is the same close
    close_no        text NOT NULL UNIQUE,
    branch_id       uuid NOT NULL REFERENCES branch(id),
    -- The business day it was closed on, in the business time zone.
    business_day    date NOT NULL,
    period_from     timestamptz,                         -- the previous close; NULL for a branch's first
    period_to       timestamptz NOT NULL,
    -- Receipts covered: numbers after from_receipt_no, up to and including to_receipt_no.
    from_receipt_no bigint NOT NULL CHECK (from_receipt_no >= 0),
    to_receipt_no   bigint NOT NULL,
    closed_by       uuid NOT NULL REFERENCES person(id),
    note            text,
    receipts        integer NOT NULL CHECK (receipts >= 0),
    gross_sales     numeric(14,2) NOT NULL,
    discounts       numeric(14,2) NOT NULL,
    net_sales       numeric(14,2) NOT NULL,
    cost_of_sales   numeric(14,2) NOT NULL,
    cash_expected   numeric(14,2) NOT NULL,
    cash_counted    numeric(14,2) NOT NULL,
    cash_variance   numeric(14,2) NOT NULL,
    -- Everything else on the report, as it stood at the close.
    detail          jsonb NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT day_close_receipts_forward CHECK (to_receipt_no >= from_receipt_no),
    CONSTRAINT day_close_cash_adds_up CHECK (cash_counted - cash_expected = cash_variance)
);
CREATE INDEX ON day_close (branch_id, period_to);
-- Two closes can never start from the same point.
CREATE UNIQUE INDEX day_close_one_start ON day_close (branch_id, coalesce(period_from, '-infinity'::timestamptz));

CREATE TRIGGER day_close_immutable BEFORE UPDATE OR DELETE ON day_close
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- A receipt's number, for finding a close's receipts by range.
CREATE INDEX sale_branch_receipt_number ON sale (branch_id, (substring(receipt_no from '(\d+)$')::bigint));

INSERT INTO permission (id, description) VALUES
    ('day.close', 'Close the day at a branch: count the tills and issue the Z report');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('supervisor',     'day.close'),
    ('branch_manager', 'day.close'),
    ('administrator',  'day.close');
