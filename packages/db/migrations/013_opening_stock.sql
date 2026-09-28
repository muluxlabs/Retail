-- Opening stock: bringing stock onto the system at a branch.
--
-- A new branch, or one started fresh, has shelves full of goods the system does
-- not know about. Opening stock introduces them - as a numbered document, like
-- a goods received note, so an auditor can see exactly what was introduced,
-- by whom, when, and at what cost. It is not an adjustment: it is only allowed
-- for an item with nothing on hand at that branch (a counted difference on an
-- item already on the books is a stock take).
--
-- Every opening stock document raises an item in the exception queue, because
-- it puts value on the books with no supplier invoice behind it.

-- Added only; nothing in this migration uses the new value.
ALTER TYPE exception_kind ADD VALUE 'opening_stock';

CREATE TABLE opening_stock (
    id           uuid PRIMARY KEY,                  -- made by the client: a retry is the same document
    doc_no       text NOT NULL UNIQUE,
    branch_id    uuid NOT NULL REFERENCES branch(id),
    entered_by   uuid NOT NULL REFERENCES person(id),
    entered_at   timestamptz NOT NULL,
    note         text,
    -- The value introduced, on the lines whose cost was given.
    total_cost   numeric(14,2) NOT NULL CHECK (total_cost >= 0),
    recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON opening_stock (branch_id, entered_at);

CREATE TABLE opening_stock_line (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        uuid NOT NULL REFERENCES opening_stock(id),
    line_no       integer NOT NULL,
    product_id    uuid NOT NULL REFERENCES product(id),
    pack_id       uuid NOT NULL REFERENCES product_pack(id),
    qty_packs     numeric(14,4) NOT NULL CHECK (qty_packs > 0),
    qty_base      numeric(14,4) NOT NULL CHECK (qty_base > 0),
    -- Per PACK. NULL when the cost was not known: the stock is then on the
    -- books but cannot be valued, and says so everywhere.
    unit_cost     numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
    line_total    numeric(14,2) CHECK (line_total IS NULL OR line_total >= 0),
    movement_seq  bigint NOT NULL UNIQUE REFERENCES stock_movement(seq),
    UNIQUE (doc_id, line_no),
    UNIQUE (doc_id, product_id),
    CONSTRAINT opening_line_cost_and_total_together CHECK ((unit_cost IS NULL) = (line_total IS NULL))
);
CREATE INDEX ON opening_stock_line (product_id);

CREATE TRIGGER opening_stock_immutable BEFORE UPDATE OR DELETE ON opening_stock
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER opening_stock_line_immutable BEFORE UPDATE OR DELETE ON opening_stock_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- Its own authority, apart from stock.adjust: the client wants branch managers
-- to bring their stock on, and bringing stock on is not the same decision as
-- adjusting stock that is already counted.
INSERT INTO permission (id, description) VALUES
    ('stock.opening', 'Introduce opening stock at a branch (items with nothing on hand)');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('branch_manager',   'stock.opening'),
    ('stock_controller', 'stock.opening'),
    ('administrator',    'stock.opening');
