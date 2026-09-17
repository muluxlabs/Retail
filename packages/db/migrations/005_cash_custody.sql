-- ============================================================================
--  Migration 005: cash custody
--
--  Scope reconciliation section 5: "Cash position across till / safe / CIT /
--  bank / petty cash" and "blind shift cash-up... the single best cash
--  control in the document." exception_kind already declared 'cash_variance'
--  in 001_core.sql; nothing has used it until now.
--
--  MODEL: the same discipline as stock, applied to cash (AD-1, generalised).
--  There is no `cash_point.balance` column and there never will be one.
--  Cash on hand at a till, safe, petty box or bank account is
--  SUM(cash_movement.amount), exactly the way stock is SUM(qty_base). A
--  blind cash-up is the cash equivalent of a stock count: the cashier counts
--  without being shown the system's expected figure first, the difference
--  is posted as a reconciling movement and costed as an open exception
--  (kind='cash_variance') - never silently absorbed.
--
--  v1 deliberately does NOT auto-post cash when a sale is tendered. Coupling
--  every till sale to a cash movement is a real future step, but it touches
--  the Sell screen and the payment-method question (card vs cash) that
--  hasn't been asked yet. Movements here are posted explicitly - float
--  issued, cash counted, cash moved between custody points - which is
--  enough to make the position and the blind count real without widening
--  scope into payment handling.
-- ============================================================================

CREATE TYPE cash_point_kind AS ENUM ('till', 'safe', 'petty', 'bank');

-- One row per place cash can sit. A till is scoped to one terminal (so two
-- cashiers sharing a physical drawer on different shifts still have separate
-- accountability if the business ever assigns terminals that way); safe and
-- petty are one per branch; bank is one per branch, matching how the group
-- actually reconciles deposits today rather than a single group-wide account.
CREATE TABLE cash_point (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id   uuid NOT NULL REFERENCES branch(id),
    kind        cash_point_kind NOT NULL,
    terminal_id uuid REFERENCES terminal(id),
    name        text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,

    CONSTRAINT cash_point_till_has_terminal CHECK (
        (kind = 'till') = (terminal_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX cash_point_one_till_per_terminal
    ON cash_point (terminal_id) WHERE kind = 'till';
-- At most one safe, one petty box, one bank account per branch. A group that
-- genuinely runs two safes at one branch renames one - this is a control
-- surface, not a general ledger with arbitrary sub-accounts.
CREATE UNIQUE INDEX cash_point_one_per_branch_kind
    ON cash_point (branch_id, kind) WHERE kind <> 'till';

-- One reason per named event, shared by both legs of a two-point move (the
-- sign of `amount` says which leg this row is; counterpart_seq links the
-- two). Simpler than a handover_out/handover_in pair on top of these -
-- "float_issue" at -30 and "float_issue" at +30 already says everything a
-- separate structural reason would.
CREATE TYPE cash_reason AS ENUM (
    'opening_balance',    -- seeds a custody point. One-sided.
    'float_issue',        -- safe -> till at shift start. Two-sided.
    'float_return',        -- till -> safe at shift end. Two-sided.
    'bank_deposit',        -- safe -> bank (covers CIT pickup too). Two-sided.
    'cash_variance',        -- the blind count's own reconciling entry. One-sided.
    'petty_disbursement',   -- petty cash spent; leaves the system. One-sided.
    'write_off'             -- cash formally absorbed as lost. One-sided.
);

-- Append-only, same as stock_movement: history is the storage format, and
-- corrections are new rows, never edits (R2).
CREATE TABLE cash_movement (
    seq          bigserial PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE,

    cash_point_id uuid NOT NULL REFERENCES cash_point(id),
    -- Signed. Positive = cash entering this point, negative = leaving it.
    amount        numeric(14,2) NOT NULL CHECK (amount <> 0),
    currency      char(3) NOT NULL DEFAULT 'USD',

    reason        cash_reason NOT NULL,
    doc_type      text,
    doc_id        uuid,

    -- Pairs a two-sided move's other leg (float_issue's -30 at the safe
    -- points here to its +30 at the till, and back), so one side can always
    -- be traced to the other - the same way reverses_seq links a stock
    -- reversal to what it reverses. NULL for one-sided reasons.
    counterpart_seq bigint REFERENCES cash_movement(seq),

    actor_id      uuid NOT NULL REFERENCES person(id),
    terminal_id   uuid REFERENCES terminal(id),

    occurred_at   timestamptz NOT NULL,
    recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON cash_movement (cash_point_id);
CREATE INDEX ON cash_movement (doc_type, doc_id);

CREATE TRIGGER cash_movement_no_update
    BEFORE UPDATE OR DELETE ON cash_movement
    FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- Cash on hand. A view, never a table - identical reasoning to stock_on_hand.
CREATE VIEW cash_on_hand AS
SELECT cash_point_id,
       SUM(amount) AS amount
FROM cash_movement
GROUP BY cash_point_id;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
--
-- Counting and moving cash are separate from merely seeing the position, the
-- same separation already used for stock (movement.post vs stock.adjust) and
-- transfers (transfer.dispatch vs transfer.receive).
-- ---------------------------------------------------------------------------

INSERT INTO permission (id, description) VALUES
    ('cash.read',  'See cash positions and the cash ledger'),
    ('cash.count', 'Post a blind cash count'),
    ('cash.move',  'Issue float, or move cash between custody points');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('cashier',          'cash.count'),

    ('supervisor',       'cash.read'),
    ('supervisor',       'cash.count'),
    ('supervisor',       'cash.move'),

    ('stock_controller',  'cash.read'),

    ('branch_manager',   'cash.read'),
    ('branch_manager',   'cash.count'),
    ('branch_manager',   'cash.move'),

    ('finance',          'cash.read'),
    ('auditor',          'cash.read'),

    ('administrator',    'cash.read'),
    ('administrator',    'cash.count'),
    ('administrator',    'cash.move');
