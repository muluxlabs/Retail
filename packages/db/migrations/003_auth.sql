-- ============================================================================
--  Migration 003: credentials, sessions and capability-based permissions
--
--  Three things this has to get right, all of them traceable to HANDOFF §2.6:
--
--  1. One human, one login. Credentials hang off `person`, which is already
--     unique per human. There is no separate "user" table to drift out of
--     step with it, so the three-records-for-one-Eunice failure cannot
--     reappear through the login system.
--
--  2. Roles must be finer-grained than POS/BACKOFFICE. Their current system
--     "has no way to let a manager approve a price change but not a stock
--     adjustment". Permissions are therefore named capabilities granted to
--     roles, not a rank ordering. `price.override` and `stock.adjust` are
--     separate grants and always will be.
--
--  3. No hard deletes (HANDOFF §10). Sessions are revoked, never deleted, so
--     "who was signed in when this happened" stays answerable afterwards.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CREDENTIALS
-- ---------------------------------------------------------------------------

CREATE TABLE user_credential (
    person_id            uuid PRIMARY KEY REFERENCES person(id),

    -- Login identity. Kept here rather than reusing person.email because a
    -- person may be contactable at an address they do not sign in with, and
    -- person.email is nullable by design (some cashiers have no email at all).
    email                text NOT NULL,

    -- Derived key plus its parameters. Never a plaintext or reversible value.
    password_hash        text NOT NULL,
    password_algo        text NOT NULL DEFAULT 'scrypt',

    -- Shared and seeded accounts must not stay shared. Set on any password an
    -- administrator issues; cleared once the person picks their own.
    must_change_password boolean NOT NULL DEFAULT true,

    -- Online-guessing defence. Cleared on every successful sign-in.
    failed_attempts      integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until         timestamptz,

    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT user_credential_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Email is the login identifier, so it must be unique case-insensitively.
-- 'Eunice@x.co.zw' and 'eunice@x.co.zw' are the same human.
CREATE UNIQUE INDEX user_credential_email_key ON user_credential (lower(email));

-- ---------------------------------------------------------------------------
-- 2. SESSIONS
-- ---------------------------------------------------------------------------

CREATE TABLE user_session (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The SHA-256 of the cookie value, never the value itself. A stolen
    -- database backup therefore does not hand over live sessions.
    token_hash    text NOT NULL UNIQUE,

    person_id     uuid NOT NULL REFERENCES person(id),

    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL DEFAULT now(),

    -- Revoked, not deleted. Sign-out and forced logout leave a trace.
    revoked_at    timestamptz,
    revoked_reason text,

    ip            text,
    user_agent    text,

    CONSTRAINT user_session_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX user_session_person ON user_session (person_id, expires_at DESC);
CREATE INDEX user_session_live ON user_session (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. PERMISSIONS
-- ---------------------------------------------------------------------------

CREATE TABLE permission (
    id          text PRIMARY KEY,
    description text NOT NULL
);

-- Roles are reference data the application depends on, so they belong in a
-- migration rather than in a development seed. Permissions below reference
-- them by id, and a fresh database must satisfy those keys with no seed run.
-- ON CONFLICT because 001 left the table empty but a seeded database may
-- already hold these ids.
INSERT INTO role (id, name) VALUES
    ('cashier',          'Cashier'),
    ('supervisor',       'Shift Supervisor'),
    ('receiver',         'Goods Receiver'),
    ('stock_controller', 'Stock Controller'),
    ('branch_manager',   'Branch Manager'),
    ('auditor',          'Auditor'),
    ('finance',          'Finance'),
    ('administrator',    'Administrator')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE role_permission (
    role_id       text NOT NULL REFERENCES role(id),
    permission_id text NOT NULL REFERENCES permission(id),
    PRIMARY KEY (role_id, permission_id)
);

INSERT INTO permission (id, description) VALUES
    ('dashboard.read',    'See the group overview'),
    ('stock.read',        'See stock positions and the ledger'),
    ('product.read',      'See the item master'),
    ('product.write',     'Create and amend products, packs and barcodes'),
    ('movement.post',     'Post stock movements and record sales'),
    ('stock.adjust',      'Post stock counts and adjustments'),
    ('stock.override',    'Authorise a sale that takes stock below zero'),
    ('price.override',    'Authorise a sale away from list price'),
    ('exception.read',    'See the exception queue'),
    ('exception.clear',   'Clear, acknowledge or escalate an exception'),
    ('user.read',         'See staff accounts'),
    ('user.manage',       'Create staff accounts and assign roles'),
    ('audit.read',        'See the immutable audit log');

-- Capability grants. Note deliberately that branch_manager may authorise a
-- price override but NOT a stock adjustment, and stock_controller the reverse.
-- That separation is the whole point of this table.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('cashier',          'product.read'),
    ('cashier',          'movement.post'),

    ('supervisor',       'product.read'),
    ('supervisor',       'stock.read'),
    ('supervisor',       'movement.post'),
    ('supervisor',       'exception.read'),

    ('receiver',         'product.read'),
    ('receiver',         'stock.read'),
    ('receiver',         'movement.post'),

    ('stock_controller', 'dashboard.read'),
    ('stock_controller', 'product.read'),
    ('stock_controller', 'product.write'),
    ('stock_controller', 'stock.read'),
    ('stock_controller', 'movement.post'),
    ('stock_controller', 'stock.adjust'),
    ('stock_controller', 'exception.read'),
    ('stock_controller', 'exception.clear'),

    ('branch_manager',   'dashboard.read'),
    ('branch_manager',   'product.read'),
    ('branch_manager',   'stock.read'),
    ('branch_manager',   'movement.post'),
    ('branch_manager',   'stock.override'),
    ('branch_manager',   'price.override'),
    ('branch_manager',   'exception.read'),
    ('branch_manager',   'exception.clear'),
    ('branch_manager',   'user.read'),

    ('auditor',          'dashboard.read'),
    ('auditor',          'product.read'),
    ('auditor',          'stock.read'),
    ('auditor',          'exception.read'),
    ('auditor',          'exception.clear'),
    ('auditor',          'user.read'),
    ('auditor',          'audit.read'),

    ('finance',          'dashboard.read'),
    ('finance',          'product.read'),
    ('finance',          'stock.read'),
    ('finance',          'exception.read'),
    ('finance',          'audit.read'),

    ('administrator',    'dashboard.read'),
    ('administrator',    'product.read'),
    ('administrator',    'product.write'),
    ('administrator',    'stock.read'),
    ('administrator',    'movement.post'),
    ('administrator',    'stock.adjust'),
    ('administrator',    'stock.override'),
    ('administrator',    'price.override'),
    ('administrator',    'exception.read'),
    ('administrator',    'exception.clear'),
    ('administrator',    'user.read'),
    ('administrator',    'user.manage'),
    ('administrator',    'audit.read');

-- Sessions are security state, not business history, so they are exempt from
-- the append-only trigger: last_seen_at and revoked_at must be updatable.
-- Credentials likewise. Neither table is part of the stock ledger.
