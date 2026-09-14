#!/usr/bin/env python3
"""
Executable proof of the core domain model.

Every test below is a real failure taken from the client's own data. If this
file passes, the model makes those failures unrepresentable. If we later change
the schema and this file fails, we have reintroduced a known defect.

Runs on stdlib sqlite3 — no services, no dependencies:

    python3 proto/ledger_proof.py
"""

import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

UTC = timezone.utc


# ---------------------------------------------------------------------------
# Schema (sqlite translation of db/001_core.sql — same rules, same constraints)
# ---------------------------------------------------------------------------

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE branch (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store','warehouse'))
);

CREATE TABLE person (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL,
    phone TEXT, email TEXT,
    CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE product (
    id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    base_uom TEXT NOT NULL, merged_into_id TEXT REFERENCES product(id),
    CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

CREATE TABLE product_pack (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES product(id),
    label TEXT NOT NULL,
    qty_base REAL NOT NULL CHECK (qty_base > 0),
    UNIQUE (product_id, label)
);

CREATE TABLE barcode (
    code TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL REFERENCES product_pack(id),
    symbology TEXT NOT NULL DEFAULT 'ean13',
    CHECK (code NOT LIKE '-%'),
    CHECK (symbology <> 'ean13' OR (length(code) = 13 AND CAST(code AS INTEGER) > 0))
);

CREATE TABLE stock_movement (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    product_id TEXT NOT NULL REFERENCES product(id),
    branch_id TEXT NOT NULL REFERENCES branch(id),
    qty_base REAL NOT NULL CHECK (qty_base <> 0),
    unit_cost REAL,
    reason TEXT NOT NULL,
    doc_type TEXT, doc_id TEXT,
    reverses_seq INTEGER REFERENCES stock_movement(seq),
    actor_id TEXT NOT NULL REFERENCES person(id),
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);

-- R2: append-only, enforced by the database.
CREATE TRIGGER sm_no_update BEFORE UPDATE ON stock_movement
BEGIN SELECT RAISE(ABORT, 'stock_movement is append-only: use a reversing movement'); END;

CREATE TRIGGER sm_no_delete BEFORE DELETE ON stock_movement
BEGIN SELECT RAISE(ABORT, 'stock_movement is append-only: use a reversing movement'); END;

CREATE TABLE exception_event (
    id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
    branch_id TEXT NOT NULL REFERENCES branch(id),
    actor_id TEXT NOT NULL REFERENCES person(id),
    product_id TEXT REFERENCES product(id),
    detail TEXT NOT NULL DEFAULT '{}',
    value_impact REAL,
    occurred_at TEXT NOT NULL,
    cleared_by TEXT REFERENCES person(id), cleared_at TEXT,
    CHECK (state <> 'cleared' OR (cleared_by IS NOT NULL AND cleared_at IS NOT NULL))
);

CREATE VIEW stock_on_hand AS
SELECT product_id, branch_id, SUM(qty_base) AS qty_base
FROM stock_movement GROUP BY product_id, branch_id;

CREATE VIEW product_wac AS
SELECT product_id, branch_id,
       SUM(qty_base * unit_cost) / SUM(qty_base) AS wac
FROM stock_movement
WHERE reason IN ('grn','opening_balance','transfer_in') AND unit_cost IS NOT NULL
GROUP BY product_id, branch_id;
"""


# ---------------------------------------------------------------------------
# Domain operations
# ---------------------------------------------------------------------------

class StockError(Exception):
    pass


class NegativeStockBlocked(StockError):
    pass


class UnlistedBarcode(StockError):
    pass


def uid():
    return str(uuid.uuid4())


class Ledger:
    """Thin domain layer. The interesting logic is that there isn't much of it —
    the constraints live in the schema, which is the point."""

    BACKDATE_THRESHOLD = timedelta(hours=48)

    def __init__(self, conn):
        self.db = conn

    # -- reads ------------------------------------------------------------

    def on_hand(self, product_id, branch_id):
        row = self.db.execute(
            "SELECT qty_base FROM stock_on_hand WHERE product_id=? AND branch_id=?",
            (product_id, branch_id)).fetchone()
        return row[0] if row else 0.0

    def wac(self, product_id, branch_id):
        row = self.db.execute(
            "SELECT wac FROM product_wac WHERE product_id=? AND branch_id=?",
            (product_id, branch_id)).fetchone()
        return row[0] if row and row[0] is not None else None

    def resolve_barcode(self, code):
        """Returns (product_id, qty_base_multiplier). Raises if unlisted."""
        row = self.db.execute(
            "SELECT pp.product_id, pp.qty_base FROM barcode b "
            "JOIN product_pack pp ON pp.id = b.pack_id WHERE b.code = ?",
            (code,)).fetchone()
        if row is None:
            raise UnlistedBarcode(code)
        return row[0], row[1]

    # -- writes -----------------------------------------------------------

    def post(self, *, event_id=None, product_id, branch_id, qty_base, reason,
             actor_id, unit_cost=None, doc_type=None, doc_id=None,
             occurred_at=None, reverses_seq=None, allow_negative=False):
        """Append one movement. Idempotent on event_id — replaying a synced
        event from an offline terminal is a no-op, not a duplicate."""
        event_id = event_id or uid()
        occurred_at = occurred_at or datetime.now(UTC)
        recorded_at = datetime.now(UTC)

        existing = self.db.execute(
            "SELECT seq FROM stock_movement WHERE event_id=?", (event_id,)).fetchone()
        if existing:
            return existing[0]          # R4: already applied

        if qty_base < 0 and not allow_negative:
            available = self.on_hand(product_id, branch_id)
            if available + qty_base < 0:
                raise NegativeStockBlocked(
                    f"on hand {available}, requested {abs(qty_base)}")

        cur = self.db.execute(
            "INSERT INTO stock_movement "
            "(event_id,product_id,branch_id,qty_base,unit_cost,reason,doc_type,"
            " doc_id,reverses_seq,actor_id,occurred_at,recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (event_id, product_id, branch_id, qty_base, unit_cost, reason,
             doc_type, doc_id, reverses_seq, actor_id,
             occurred_at.isoformat(), recorded_at.isoformat()))
        seq = cur.lastrowid

        if recorded_at - occurred_at > self.BACKDATE_THRESHOLD:
            self.raise_exception(
                kind='backdated_entry', branch_id=branch_id, actor_id=actor_id,
                product_id=product_id, occurred_at=occurred_at,
                detail={'movement_seq': seq,
                        'gap_hours': round((recorded_at - occurred_at)
                                           .total_seconds() / 3600, 1)})
        return seq

    def sell(self, *, barcode, qty_packs, branch_id, actor_id,
             override_negative=False, override_by=None):
        """Till sale. Resolves the pack multiplier, then posts in base units."""
        product_id, multiplier = self.resolve_barcode(barcode)
        qty_base = -abs(qty_packs) * multiplier
        try:
            return self.post(product_id=product_id, branch_id=branch_id,
                             qty_base=qty_base, reason='sale', actor_id=actor_id)
        except NegativeStockBlocked:
            if not override_negative:
                raise
            # An override is permitted, but it is never silent.
            seq = self.post(product_id=product_id, branch_id=branch_id,
                            qty_base=qty_base, reason='sale', actor_id=actor_id,
                            allow_negative=True)
            self.raise_exception(
                kind='negative_stock_override', branch_id=branch_id,
                actor_id=actor_id, product_id=product_id,
                occurred_at=datetime.now(UTC),
                detail={'movement_seq': seq, 'barcode': barcode,
                        'authorised_by': override_by})
            return seq

    def scan_unlisted(self, *, code, branch_id, actor_id):
        """Cashier scanned something not in the master. The old system let this
        pass silently; here it is an incident with a name attached."""
        self.raise_exception(
            kind='unlisted_barcode_scan', branch_id=branch_id, actor_id=actor_id,
            occurred_at=datetime.now(UTC), detail={'raw_barcode': code})

    def raise_exception(self, *, kind, branch_id, actor_id, occurred_at,
                        product_id=None, detail=None, value_impact=None):
        self.db.execute(
            "INSERT INTO exception_event "
            "(id,event_id,kind,branch_id,actor_id,product_id,detail,"
            " value_impact,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (uid(), uid(), kind, branch_id, actor_id, product_id,
             repr(detail or {}), value_impact, occurred_at.isoformat()))

    def post_count(self, *, product_id, branch_id, counted_base, actor_id,
                   doc_id):
        """Post a stock count. Returns (expected, counted, variance).

        Critically: the variance is computed against the ledger, and posting it
        writes an adjustment movement. A count that is not posted changes
        nothing — which is why unfinished counts must be visible."""
        expected = self.on_hand(product_id, branch_id)
        variance = counted_base - expected
        if variance != 0:
            wac = self.wac(product_id, branch_id)
            self.post(product_id=product_id, branch_id=branch_id,
                      qty_base=variance, reason='count_adjustment',
                      actor_id=actor_id, unit_cost=wac,
                      doc_type='COUNT', doc_id=doc_id, allow_negative=True)
            self.raise_exception(
                kind='count_variance', branch_id=branch_id, actor_id=actor_id,
                product_id=product_id, occurred_at=datetime.now(UTC),
                detail={'expected': expected, 'counted': counted_base},
                value_impact=round(variance * wac, 2) if wac else None)
        return expected, counted_base, variance

    def open_exceptions(self, kind=None):
        q = "SELECT kind, detail, value_impact FROM exception_event WHERE state='open'"
        p = ()
        if kind:
            q += " AND kind=?"
            p = (kind,)
        return self.db.execute(q, p).fetchall()


# ---------------------------------------------------------------------------
# Fixtures — the client's actual data
# ---------------------------------------------------------------------------

def seed(db):
    ids = {}

    ids['kana'] = uid()
    ids['warehouse'] = uid()
    db.execute("INSERT INTO branch (id,code,name,kind) VALUES (?,?,?,?)",
               (ids['kana'], 'KANA', 'Kana Mission', 'store'))
    db.execute("INSERT INTO branch (id,code,name,kind) VALUES (?,?,?,?)",
               (ids['warehouse'], 'WH', 'Warehouse', 'warehouse'))

    ids['cashier'] = uid()
    ids['manager'] = uid()
    db.execute("INSERT INTO person (id,full_name,phone) VALUES (?,?,?)",
               (ids['cashier'], 'Dzidzai Chikuku', '0773368414'))
    db.execute("INSERT INTO person (id,full_name,phone) VALUES (?,?,?)",
               (ids['manager'], 'Eunice Madimbe', '0776058588'))

    # Charhons biscuits — the case/single problem. ONE product, TWO packs.
    ids['charhons'] = uid()
    db.execute("INSERT INTO product (id,sku,name,base_uom) VALUES (?,?,?,?)",
               (ids['charhons'], 'CHAR-500', 'Charhons biscuits 500g', 'each'))
    ids['charhons_single'] = uid()
    ids['charhons_case'] = uid()
    db.execute("INSERT INTO product_pack (id,product_id,label,qty_base) VALUES (?,?,?,?)",
               (ids['charhons_single'], ids['charhons'], 'single', 1))
    db.execute("INSERT INTO product_pack (id,product_id,label,qty_base) VALUES (?,?,?,?)",
               (ids['charhons_case'], ids['charhons'], 'case of 10', 10))
    db.execute("INSERT INTO barcode (code,pack_id) VALUES (?,?)",
               ('6001234567890', ids['charhons_single']))
    db.execute("INSERT INTO barcode (code,pack_id) VALUES (?,?)",
               ('6001234567906', ids['charhons_case']))

    # Three Leaves 125g — the product that had four records.
    ids['three_leaves'] = uid()
    db.execute("INSERT INTO product (id,sku,name,base_uom) VALUES (?,?,?,?)",
               (ids['three_leaves'], 'TL-125', 'Three Leaves tea 125g', 'each'))
    ids['tl_single'] = uid()
    db.execute("INSERT INTO product_pack (id,product_id,label,qty_base) VALUES (?,?,?,?)",
               (ids['tl_single'], ids['three_leaves'], 'single', 1))
    db.execute("INSERT INTO barcode (code,pack_id) VALUES (?,?)",
               ('6009876543210', ids['tl_single']))

    return ids


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

RESULTS = []


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))


def test_pack_hierarchy_reconciles(db, ids):
    """IC-10027's likely root cause: receive cases, sell singles.

    Old system: 50 cases received, 120 singles sold -> nonsense.
    New system: 500 units received, 120 sold -> 380 on hand."""
    L = Ledger(db)
    _, case_mult = L.resolve_barcode('6001234567906')
    L.post(product_id=ids['charhons'], branch_id=ids['kana'],
           qty_base=50 * case_mult, unit_cost=1.35, reason='grn',
           actor_id=ids['manager'], doc_type='GRN')
    L.sell(barcode='6001234567890', qty_packs=120,
           branch_id=ids['kana'], actor_id=ids['cashier'])
    on_hand = L.on_hand(ids['charhons'], ids['kana'])
    check("case-to-single conversion reconciles", on_hand == 380,
          f"expected 380 singles, got {on_hand}")


def test_duplicate_barcode_impossible(db, ids):
    """The Three Leaves ×4 defect. A barcode may point at exactly one pack."""
    dupe = uid()
    db.execute("INSERT INTO product (id,sku,name,base_uom) VALUES (?,?,?,?)",
               (dupe, 'TL-125-DUP', '125g three leaves tea bags', 'each'))
    dupe_pack = uid()
    db.execute("INSERT INTO product_pack (id,product_id,label,qty_base) VALUES (?,?,?,?)",
               (dupe_pack, dupe, 'single', 1))
    try:
        db.execute("INSERT INTO barcode (code,pack_id) VALUES (?,?)",
                   ('6009876543210', dupe_pack))
        check("duplicate barcode rejected", False, "insert succeeded")
    except sqlite3.IntegrityError:
        check("duplicate barcode rejected", True)


def test_invalid_barcodes_rejected(db, ids):
    """241 codes under six digits, one negative. All now unrepresentable."""
    pack = ids['tl_single']
    outcomes = []
    for bad in ('-1124125534', '3', '6744072585426083'):
        try:
            db.execute("INSERT INTO barcode (code,pack_id) VALUES (?,?)", (bad, pack))
            outcomes.append((bad, 'ACCEPTED'))
        except sqlite3.IntegrityError:
            outcomes.append((bad, 'rejected'))
    check("malformed barcodes rejected",
          all(o[1] == 'rejected' for o in outcomes), str(outcomes))


def test_ledger_is_append_only(db, ids):
    """R2. Not a convention — the database refuses."""
    L = Ledger(db)
    seq = L.post(product_id=ids['three_leaves'], branch_id=ids['kana'],
                 qty_base=500, unit_cost=0.80, reason='opening_balance',
                 actor_id=ids['manager'])
    upd = dele = None
    try:
        db.execute("UPDATE stock_movement SET qty_base=9999 WHERE seq=?", (seq,))
    except sqlite3.IntegrityError as e:
        upd = str(e)
    try:
        db.execute("DELETE FROM stock_movement WHERE seq=?", (seq,))
    except sqlite3.IntegrityError as e:
        dele = str(e)
    check("ledger rejects UPDATE and DELETE", upd and dele)


def test_negative_stock_blocked_then_logged(db, ids):
    """'Selling negative/zeros — override to their own benefit.'
    Blocked by default; when overridden, an incident is created."""
    L = Ledger(db)
    blocked = False
    try:
        L.sell(barcode='6009876543210', qty_packs=100000,
               branch_id=ids['kana'], actor_id=ids['cashier'])
    except NegativeStockBlocked:
        blocked = True
    check("negative stock blocked by default", blocked)

    before = len(L.open_exceptions('negative_stock_override'))
    L.sell(barcode='6009876543210', qty_packs=100000, branch_id=ids['kana'],
           actor_id=ids['cashier'], override_negative=True,
           override_by=ids['manager'])
    after = len(L.open_exceptions('negative_stock_override'))
    check("override creates an open exception", after == before + 1)


def test_unlisted_scan_captured(db, ids):
    """Under-the-counter sales: the scan itself becomes evidence."""
    L = Ledger(db)
    raised = False
    try:
        L.resolve_barcode('9999999999999')
    except UnlistedBarcode:
        raised = True
        L.scan_unlisted(code='9999999999999', branch_id=ids['kana'],
                        actor_id=ids['cashier'])
    check("unlisted barcode raises and logs", raised
          and len(L.open_exceptions('unlisted_barcode_scan')) == 1)


def test_backdating_detected(db, ids):
    """TGRN-10001: goods dated 13 Dec 2025, entered 14 May 2026."""
    L = Ledger(db)
    before = len(L.open_exceptions('backdated_entry'))
    L.post(product_id=ids['three_leaves'], branch_id=ids['warehouse'],
           qty_base=200, unit_cost=0.80, reason='grn', actor_id=ids['manager'],
           occurred_at=datetime.now(UTC) - timedelta(days=152))
    after = len(L.open_exceptions('backdated_entry'))
    check("backdated receipt flagged", after == before + 1)


def test_offline_replay_is_idempotent(db, ids):
    """R4. A terminal that syncs the same batch twice must not double-count."""
    L = Ledger(db)
    eid = uid()
    before = L.on_hand(ids['three_leaves'], ids['warehouse'])
    for _ in range(3):
        L.post(event_id=eid, product_id=ids['three_leaves'],
               branch_id=ids['warehouse'], qty_base=25, unit_cost=0.80,
               reason='grn', actor_id=ids['manager'])
    after = L.on_hand(ids['three_leaves'], ids['warehouse'])
    check("replayed offline events apply once", after - before == 25,
          f"delta {after - before}, expected 25")


def test_count_posts_and_values_variance(db, ids):
    """A count that finds 400 against a book of 380 must post the adjustment
    AND value it at weighted-average cost — the step that produced the
    0.11% margin when it was skipped."""
    L = Ledger(db)
    expected, counted, variance = L.post_count(
        product_id=ids['charhons'], branch_id=ids['kana'],
        counted_base=400, actor_id=ids['manager'], doc_id=uid())
    settled = L.on_hand(ids['charhons'], ids['kana'])
    exc = [e for e in L.open_exceptions('count_variance')]
    check("count variance posts an adjustment",
          variance == 20 and settled == 400,
          f"variance {variance}, on hand {settled}")
    check("count variance is costed",
          any(e[2] is not None and e[2] > 0 for e in exc),
          f"exceptions: {exc}")


def test_wac_is_derived_not_stored(db, ids):
    """Cost comes from the movement history, so it cannot silently drift to
    equal the selling price."""
    L = Ledger(db)
    p = uid()
    db.execute("INSERT INTO product (id,sku,name,base_uom) VALUES (?,?,?,?)",
               (p, 'WAC-T', 'WAC test item', 'each'))
    L.post(product_id=p, branch_id=ids['kana'], qty_base=100, unit_cost=1.00,
           reason='grn', actor_id=ids['manager'])
    L.post(product_id=p, branch_id=ids['kana'], qty_base=100, unit_cost=2.00,
           reason='grn', actor_id=ids['manager'])
    wac = L.wac(p, ids['kana'])
    check("weighted-average cost derived from ledger", abs(wac - 1.50) < 1e-9,
          f"got {wac}")


# ---------------------------------------------------------------------------

def main():
    db = sqlite3.connect(':memory:')
    db.executescript(SCHEMA)
    ids = seed(db)

    for t in (test_pack_hierarchy_reconciles,
              test_duplicate_barcode_impossible,
              test_invalid_barcodes_rejected,
              test_ledger_is_append_only,
              test_negative_stock_blocked_then_logged,
              test_unlisted_scan_captured,
              test_backdating_detected,
              test_offline_replay_is_idempotent,
              test_count_posts_and_values_variance,
              test_wac_is_derived_not_stored):
        t(db, ids)

    width = max(len(n) for n, _, _ in RESULTS)
    print("\n  Core domain model — invariant proofs")
    print("  " + "-" * (width + 12))
    for name, ok, detail in RESULTS:
        mark = "PASS" if ok else "FAIL"
        print(f"  {mark}  {name.ljust(width)}" + (f"   {detail}" if not ok else ""))
    failed = sum(1 for _, ok, _ in RESULTS if not ok)
    print("  " + "-" * (width + 12))
    print(f"  {len(RESULTS) - failed}/{len(RESULTS)} passed\n")
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
