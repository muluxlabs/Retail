-- ============================================================================
--  Migration 004: branch-to-branch transfers
--
--  HANDOFF section 4.1-4.2 names this directly: "Dispatch, in-transit state,
--  receiving variance ticket - warehouse to branch is core to their
--  operating model." 001_core.sql already declared the movement reasons
--  (transfer_out, transfer_in, transfer_loss) but never built the workflow
--  that produces them. This does.
--
--  MODEL
--
--  A transfer is not one ledger event, it is two, separated by a real gap:
--  stock leaves the origin the moment it is dispatched (that is a fact - it
--  is on a truck), but the destination is only credited for what is
--  ACTUALLY CONFIRMED ARRIVED, never for what was merely sent. The
--  difference is the receiving variance the client asked for, and it is
--  costed and raised as an exception (kind='transit_loss', already declared
--  in 001_core.sql, never previously used) rather than written off.
--
--  There is deliberately no third "in transit" ledger movement and no
--  pseudo-branch representing a truck. Two real movements against two real
--  branches already balance correctly: origin loses exactly what was
--  dispatched, destination gains exactly what was confirmed received, and
--  a shortfall is simply absent from both - which is what shrinkage in
--  transit actually is. The transfer/transfer_line tables carry the
--  WORKFLOW state (dispatched, awaiting receipt); the ledger only ever
--  records the two confirmed, definitive events.
-- ============================================================================

CREATE TYPE transfer_state AS ENUM ('dispatched', 'received', 'cancelled');

-- Backs the human-readable reference (TR-000123). The service layer reads
-- this and formats it; the sequence itself carries no meaning beyond order.
CREATE SEQUENCE transfer_reference_seq;

CREATE TABLE transfer (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What a person reads off a dispatch note. The uuid is the real key;
    -- this is display only, still unique so two transfers are never
    -- confused on a printed slip.
    reference       text NOT NULL UNIQUE,

    origin_branch_id      uuid NOT NULL REFERENCES branch(id),
    destination_branch_id uuid NOT NULL REFERENCES branch(id),

    state           transfer_state NOT NULL DEFAULT 'dispatched',

    dispatched_by   uuid NOT NULL REFERENCES person(id),
    dispatched_at   timestamptz NOT NULL,

    -- Maker-checker: the person confirming receipt is recorded separately
    -- from the person who dispatched. Nothing enforces they differ - that is
    -- a role-grant decision (see role_permission below) - but the schema
    -- always has both names on record.
    received_by     uuid REFERENCES person(id),
    received_at     timestamptz,

    cancelled_by    uuid REFERENCES person(id),
    cancelled_at    timestamptz,

    notes           text,

    CONSTRAINT transfer_distinct_branches CHECK (origin_branch_id <> destination_branch_id),
    CONSTRAINT transfer_received_needs_actor CHECK (
        state <> 'received' OR (received_by IS NOT NULL AND received_at IS NOT NULL)
    ),
    CONSTRAINT transfer_cancelled_needs_actor CHECK (
        state <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
    )
);

CREATE INDEX ON transfer (destination_branch_id, state);
CREATE INDEX ON transfer (origin_branch_id, state);

CREATE TABLE transfer_line (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     uuid NOT NULL REFERENCES transfer(id),
    product_id      uuid NOT NULL REFERENCES product(id),

    -- What left the origin, in base units. Set at dispatch, never revised -
    -- the movement it produced is already posted and immutable.
    qty_dispatched  numeric(14,4) NOT NULL CHECK (qty_dispatched > 0),
    -- What arrived, in base units. NULL until the transfer is received.
    qty_received    numeric(14,4) CHECK (qty_received IS NULL OR qty_received >= 0),

    -- Carried forward from the origin's own WAC at dispatch time, the same
    -- way a GRN carries an explicit cost - moving stock does not change what
    -- it is worth.
    unit_cost       numeric(14,4),

    -- The two ledger rows this line produced, once each exists. Kept here so
    -- a line is never posted twice and so the screen can show "movement #x"
    -- rather than re-deriving it.
    dispatch_movement_seq bigint REFERENCES stock_movement(seq),
    receipt_movement_seq  bigint REFERENCES stock_movement(seq),

    UNIQUE (transfer_id, product_id)
);

CREATE INDEX ON transfer_line (transfer_id);

-- ---------------------------------------------------------------------------
-- PERMISSIONS
--
-- Dispatch and receipt are separate capabilities, deliberately. A person who
-- can send stock out is not automatically trusted to confirm it arrived -
-- that separation is what makes "received_by" on the transfer row mean
-- something, rather than being the same person checking their own work.
-- ---------------------------------------------------------------------------

INSERT INTO permission (id, description) VALUES
    ('transfer.read',     'See branch-to-branch transfers'),
    ('transfer.dispatch', 'Dispatch stock to another branch'),
    ('transfer.receive',  'Confirm receipt of a transfer, or cancel one still in transit');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('receiver',         'transfer.read'),
    ('receiver',         'transfer.dispatch'),
    ('receiver',         'transfer.receive'),

    ('stock_controller', 'transfer.read'),
    ('stock_controller', 'transfer.dispatch'),
    ('stock_controller', 'transfer.receive'),

    ('branch_manager',   'transfer.read'),
    ('branch_manager',   'transfer.dispatch'),
    ('branch_manager',   'transfer.receive'),

    ('auditor',          'transfer.read'),
    ('finance',          'transfer.read'),

    ('administrator',    'transfer.read'),
    ('administrator',    'transfer.dispatch'),
    ('administrator',    'transfer.receive');
