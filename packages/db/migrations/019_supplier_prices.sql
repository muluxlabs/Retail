-- A supplier's price list.
--
-- When a supplier sends new prices, they are pasted in, matched to our items,
-- and applied in one go: the supplier's cost for each pack is recorded, and
-- (if asked) our selling price moves with it. Each import is a numbered,
-- unchangeable document holding the old and new cost and price of every line,
-- so "why did the price of sugar change on the 3rd?" has an answer.
--
-- supplier_item is the current state: what each supplier charges for each
-- pack, and their own code for it. It is what the next list is matched by,
-- and what fills in the price on a new purchase order.

CREATE TABLE supplier_price_list (
    id           uuid PRIMARY KEY,                     -- made by the client: a retry is the same import
    list_no      text NOT NULL UNIQUE,                 -- 'SPL-000001', group-wide
    supplier_id  uuid NOT NULL REFERENCES supplier(id),
    rule         jsonb NOT NULL,                       -- how selling prices were worked out
    note         text,
    lines        integer NOT NULL CHECK (lines > 0),
    prices_changed integer NOT NULL CHECK (prices_changed >= 0),
    created_by   uuid NOT NULL REFERENCES person(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_price_list_supplier ON supplier_price_list (supplier_id, created_at DESC);

CREATE TABLE supplier_price_list_line (
    list_id        uuid NOT NULL REFERENCES supplier_price_list(id),
    line_no        integer NOT NULL CHECK (line_no > 0),
    pack_id        uuid NOT NULL REFERENCES product_pack(id),
    supplier_code  text,
    cost           numeric(14,4) NOT NULL CHECK (cost > 0),     -- per pack
    old_cost       numeric(14,4),                                -- the supplier's last cost, else our average cost
    old_sell       numeric(14,2),
    new_sell       numeric(14,2),                                -- NULL: the selling price was left alone
    PRIMARY KEY (list_id, line_no),
    UNIQUE (list_id, pack_id),
    CONSTRAINT price_not_below_cost CHECK (new_sell IS NULL OR new_sell >= cost)
);

CREATE TRIGGER supplier_price_list_immutable BEFORE UPDATE OR DELETE ON supplier_price_list
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();
CREATE TRIGGER supplier_price_list_line_immutable BEFORE UPDATE OR DELETE ON supplier_price_list_line
    FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

CREATE TABLE supplier_item (
    supplier_id    uuid NOT NULL REFERENCES supplier(id),
    pack_id        uuid NOT NULL REFERENCES product_pack(id),
    supplier_code  text,
    cost           numeric(14,4) NOT NULL CHECK (cost > 0),
    list_id        uuid NOT NULL REFERENCES supplier_price_list(id),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (supplier_id, pack_id)
);
-- A supplier's code means one pack of ours.
CREATE UNIQUE INDEX supplier_item_code ON supplier_item (supplier_id, lower(supplier_code)) WHERE supplier_code IS NOT NULL;
