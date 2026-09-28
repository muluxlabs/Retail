-- ============================================================================
--  Migration 009: start a branch fresh
--
--  The client asked that a branch manager be able to set a branch's stock to
--  zero when a branch is starting over, with caution because it cannot be
--  undone.
--
--  This does not delete anything. Stock is a ledger (AD-1), so "set to zero"
--  is one offsetting movement per product, dated now, and every prior
--  movement stays exactly where it was. What makes it irreversible is not
--  data loss but that there is no undo: the old quantities can only come back
--  by being entered again through Receive or Count. That is why the action is
--  guarded (typed confirmation, a written reason, branch scope, a fresh read
--  at the moment of the reset) and why every reset raises an exception for an
--  auditor to see.
-- ============================================================================

-- A reason of its own. Posting a reset as 'write_off' or 'count_adjustment'
-- would report a fresh start as ten thousand units "written off", which is
-- false and would drown the real write-offs.
--
-- Added only: no statement in this migration uses either new value, which is
-- the one thing Postgres forbids for an enum value added in the same
-- transaction.
ALTER TYPE movement_reason ADD VALUE 'stock_reset';
ALTER TYPE exception_kind  ADD VALUE 'stock_reset';

INSERT INTO permission (id, description) VALUES
    ('stock.reset', 'Set every product at a branch to zero (start the branch fresh); cannot be undone');

-- Branch manager, as the client specified, and administrator. Deliberately
-- NOT stock_controller: counting and adjusting stock is theirs, wiping a
-- branch's position is a different order of decision.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('branch_manager', 'stock.reset'),
    ('administrator',  'stock.reset');
