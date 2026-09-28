-- ============================================================================
--  Migration 006: branch management
--
--  Branches were seed-only until now - real, but only creatable by running
--  the seed script by hand. The client asked to add and edit branches
--  through the system itself, capped by default and raisable without a
--  redeploy when a client's plan grows (their words: adding branches grows
--  the database, the stock, the item count - "the amount we charge should
--  also increase", which is fair, and is exactly why the cap is a row this
--  migration seeds, not a number buried in application code).
-- ============================================================================

INSERT INTO permission (id, description) VALUES
    ('branch.manage', 'Add and edit branches');

-- Administrator only, deliberately narrow. "Not everybody should be able to
-- make changes for the branch" was the client's own framing - this is not a
-- capability any other role gets by default.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('administrator', 'branch.manage');

-- A small, generic key/value settings table rather than a bespoke column
-- somewhere, because this is the first of what will likely be more than one
-- operator-adjustable limit over time, and none of them belong hardcoded in
-- application code if the whole point is changing them without a deploy.
CREATE TABLE system_setting (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    updated_by  uuid REFERENCES person(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_setting (key, value) VALUES
    ('max_active_branches', '20');
