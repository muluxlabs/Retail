-- Importing items from a spreadsheet.
--
-- Each import is a numbered record (ITM-IMP-000001): who, when, the file's
-- name, and how many items, packs and categories it created and how many rows
-- it left out. Items that looked like existing ones were only created if the
-- importer confirmed them; the rest are counted here. Stock on hand in the
-- file becomes an ordinary opening stock document, linked here. The items themselves are ordinary items; each carries the
-- import it came from, so an import can be looked back on as a whole.

CREATE TABLE item_import (
    id                  uuid PRIMARY KEY,               -- made by the client: a retry is the same import
    import_no           text NOT NULL UNIQUE,
    file_name           text,
    items_created       integer NOT NULL CHECK (items_created >= 0),
    packs_created       integer NOT NULL CHECK (packs_created >= 0),
    categories_created  integer NOT NULL CHECK (categories_created >= 0),
    rows_skipped        integer NOT NULL CHECK (rows_skipped >= 0),
    prices_set          boolean NOT NULL,
    similar_skipped     integer NOT NULL DEFAULT 0 CHECK (similar_skipped >= 0),  -- look-alikes not confirmed
    -- The stock brought in with the items, if any. Checked at commit: the document is posted later in the same transaction.
    opening_stock_id    uuid REFERENCES opening_stock(id) DEFERRABLE INITIALLY DEFERRED,
    created_by          uuid NOT NULL REFERENCES person(id),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER item_import_immutable BEFORE UPDATE OR DELETE ON item_import
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

ALTER TABLE product ADD COLUMN import_id uuid REFERENCES item_import(id);
CREATE INDEX product_import ON product (import_id) WHERE import_id IS NOT NULL;
