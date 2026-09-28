-- Access for one person, beyond (or short of) their role.
--
-- A role is the usual set of permissions for a job. Sometimes one person
-- needs a little more (a senior cashier who may look at the item master) or
-- a little less (a supervisor who should not see supplier costs). An
-- administrator records that here, against the person: 'grant' adds a
-- permission their roles do not give, 'revoke' takes away one they do.
-- A person's access is what their roles give, plus grants, minus revokes.
--
-- This is configuration, so a row can be changed or removed (back to what the
-- role gives); every change is written to the audit log, and access added
-- beyond a role is raised for review.

ALTER TYPE exception_kind ADD VALUE 'access_granted';

CREATE TYPE access_effect AS ENUM ('grant', 'revoke');

CREATE TABLE person_permission (
    person_id      uuid NOT NULL REFERENCES person(id),
    permission_id  text NOT NULL REFERENCES permission(id),
    effect         access_effect NOT NULL,
    note           text,
    set_by         uuid NOT NULL REFERENCES person(id),
    set_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, permission_id),
    -- Nobody sets their own access.
    CONSTRAINT not_self_granted CHECK (set_by <> person_id)
);

-- A cashier looks items up at the till (by name or barcode, with the selling
-- price) as part of selling; that now needs only the permission to sell. The
-- item master itself - every product, pack and barcode, and where it is
-- stocked - is not a cashier's screen.
DELETE FROM role_permission WHERE role_id = 'cashier' AND permission_id = 'product.read';
