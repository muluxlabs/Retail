-- ============================================================================
--  Migration 007: cashier-created products enter review, not the master
--
--  The client's own words: a cashier at the till who cannot find an item -
--  no barcode match, not in the list - needs to add it right there to finish
--  the sale, but it should "sit specifically in a different section" until a
--  branch manager or admin either maps it onto a product that already
--  existed under another name, or accepts it into the real item master under
--  the right category. This is that distinction, expressed the same way
--  every other override in this system is: a new product row, plus a named
--  work item in the existing exception queue (AD-4). Nothing here invents a
--  parallel review mechanism - clearing the exception IS the review.
-- ============================================================================

CREATE TYPE product_review_state AS ENUM ('approved', 'pending');

ALTER TABLE product
    ADD COLUMN review_state product_review_state NOT NULL DEFAULT 'approved',
    ADD COLUMN created_by uuid REFERENCES person(id);

-- New value only; not used by any statement in this same transaction, which
-- is the one thing Postgres actually forbids for an enum added this way.
ALTER TYPE exception_kind ADD VALUE 'unreviewed_product';

INSERT INTO permission (id, description) VALUES
    ('product.quickadd', 'Add a product on the fly at the till or on receiving; it enters review, not the trusted master');

-- Granted alongside movement.post: whoever can already sell or receive is
-- who ends up stuck without a matching item and needs this. stock_controller
-- and administrator already hold product.write, a superset, but get it too
-- so the same quick-add control on the Sell screen works for every role.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('cashier',          'product.quickadd'),
    ('supervisor',       'product.quickadd'),
    ('receiver',         'product.quickadd'),
    ('stock_controller', 'product.quickadd'),
    ('branch_manager',   'product.quickadd'),
    ('administrator',    'product.quickadd');

-- The client's own words: "the admin or the branch manager would be
-- notified... they would be able to map it... or add it to proper group or
-- category." Reviewing a pending product - approve or merge - is gated on
-- product.write, same as every other item-master change; branch_manager did
-- not hold it before, so this is what actually puts them in the loop the
-- client asked for, not just quick-add.
INSERT INTO role_permission (role_id, permission_id) VALUES
    ('branch_manager', 'product.write');
