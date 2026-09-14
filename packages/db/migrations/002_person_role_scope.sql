-- ============================================================================
--  Migration 002: make group-wide role grants representable
--
--  001_core.sql declares person_role as:
--
--      branch_id  uuid REFERENCES branch(id),   -- NULL = group-wide
--      PRIMARY KEY (person_id, role_id, branch_id)
--
--  PostgreSQL marks every PRIMARY KEY column implicitly NOT NULL, so the
--  group-wide case the comment describes could never actually be inserted:
--  granting anyone a role that is not scoped to a single branch failed with
--  a not-null violation. The comment stated the intent; the constraint
--  contradicted it.
--
--  This matters beyond tidiness. HANDOFF section 2.6 records five roles split
--  only by POS/BACKOFFICE, with no way to let a manager approve a price change
--  but not a stock adjustment. The fix for that is finer-grained roles, some
--  of which (Auditor, Administrator, Finance) are inherently group-wide. A
--  schema that cannot express "group-wide" cannot express their RBAC.
--
--  Nullable discriminators cannot live in a composite primary key, so the
--  key becomes a surrogate and uniqueness moves to two partial indexes -
--  the standard Postgres shape for this.
-- ============================================================================

-- Dropping the primary key does not clear the NOT NULL it implied, so the
-- column is relaxed explicitly afterwards.
ALTER TABLE person_role DROP CONSTRAINT person_role_pkey;

ALTER TABLE person_role
    ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();

ALTER TABLE person_role
    ALTER COLUMN branch_id DROP NOT NULL;

-- A person holds a given role group-wide at most once.
CREATE UNIQUE INDEX person_role_group_wide
    ON person_role (person_id, role_id)
    WHERE branch_id IS NULL;

-- A person holds a given role at most once per branch.
CREATE UNIQUE INDEX person_role_branch_scoped
    ON person_role (person_id, role_id, branch_id)
    WHERE branch_id IS NOT NULL;

COMMENT ON COLUMN person_role.branch_id IS
    'NULL means the grant is group-wide rather than scoped to one branch.';
