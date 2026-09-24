/**
 * Item master.
 *
 * Every product is shown WITH its pack hierarchy expanded, because the pack
 * hierarchy is the thing their current master lacks. A row that reads
 * "single = 1, case of 10 = 10" is the fix for the defect that made a case
 * and a single unrelated records.
 *
 * Products with no pack, or no barcode, are flagged rather than hidden - the
 * item master cleanse needs to see them.
 *
 * Creating a product and adding/editing its packs and barcodes are the
 * actual cleanse operations (HANDOFF section 2.3: Three Leaves 125g had four
 * records, Charhons had a case and a single as unrelated products). Both are
 * gated on `product.write` - the API refuses regardless of what this screen
 * shows, this is only what decides what to render.
 */

import { useState } from 'react';

import { api, ApiError, type Category, type Pack } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

const BASE_UOM_SUGGESTIONS = ['each', 'kg', 'litre', 'box'];

export function Products() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);

  const products = useAsync(
    () =>
      api.products({
        ...(search === '' ? {} : { search }),
        ...(pendingOnly ? { reviewState: 'pending' as const } : {}),
        limit: 200,
      }),
    [search, pendingOnly],
  );
  const categories = useAsync(() => api.categories(), []);

  const items = products.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Item master</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            One product, one base unit, many packs. A barcode resolves to exactly one pack.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-ink-400 text-xs">
            {products.data !== undefined && `${products.data.total} active products`}
          </div>
          {can('product.write') && (
            <Button variant="primary" onClick={() => setCreating((v) => !v)}>
              {creating ? 'Cancel' : 'Add product'}
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <CreateProductForm
          categories={categories.data ?? []}
          onCreated={(id) => {
            setCreating(false);
            products.reload();
            setExpanded(id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or SKU…"
          className="border-ink-200 focus:border-accent-500 w-full max-w-md rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
        />
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="accent-accent-600 size-3.5"
          />
          Pending review only
        </label>
      </div>
      <p className="text-ink-400 -mt-2 text-[11.5px]">
        Items a cashier added on the fly sit here too, flagged “pending review”, until a branch
        manager maps or accepts them from the Exceptions queue.
      </p>

      {products.error !== undefined && <ErrorNote error={products.error} />}

      <Card className="overflow-hidden">
        {products.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No products match" />
        ) : (
          <ul className="divide-ink-100 divide-y">
            {items.map((product) => {
              const isOpen = expanded === product.id;
              const hasBarcode = product.packs.some((p) => p.barcode !== null);
              return (
                <li key={product.id}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : product.id)}
                    className="hover:bg-ink-50/60 flex w-full items-center gap-3 px-4 py-2.5 text-left transition"
                  >
                    <svg
                      viewBox="0 0 20 20"
                      className={`text-ink-300 size-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    >
                      <path fill="currentColor" d="M7 4l6 6-6 6z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13px] font-medium">{product.name}</span>
                        {product.isWeighed && <Badge tone="info">weighed</Badge>}
                        {!product.isActive && <Badge tone="neutral">inactive</Badge>}
                        {product.packs.length === 0 && <Badge tone="bad">no pack</Badge>}
                        {!hasBarcode && product.packs.length > 0 && (
                          <Badge tone="warn">no barcode</Badge>
                        )}
                        {product.mergedIntoId !== null && <Badge tone="neutral">merged</Badge>}
                        {product.reviewState === 'pending' && (
                          <Badge tone="warn">pending review</Badge>
                        )}
                      </div>
                      <div className="text-ink-400 mt-0.5 font-mono text-[11px]">
                        {product.sku}
                        {product.categoryName !== null && (
                          <span className="font-sans"> · {product.categoryName}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-ink-400 shrink-0 text-[11.5px]">
                      {product.packs.length} pack{product.packs.length === 1 ? '' : 's'}
                    </div>
                  </button>

                  {isOpen && (
                    <Detail
                      productId={product.id}
                      baseUom={product.baseUom}
                      categories={categories.data ?? []}
                      onProductChanged={() => products.reload()}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

// -- create ------------------------------------------------------------------

interface DraftPack {
  key: number;
  label: string;
  qtyBase: string;
  isDefaultSell: boolean;
  isDefaultBuy: boolean;
  barcode: string;
}

let draftKey = 0;
const newDraftPack = (overrides: Partial<DraftPack> = {}): DraftPack => ({
  key: draftKey++,
  label: '',
  qtyBase: '1',
  isDefaultSell: false,
  isDefaultBuy: false,
  barcode: '',
  ...overrides,
});

function CreateProductForm({
  categories,
  onCreated,
  onCancel,
}: {
  categories: Category[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [baseUom, setBaseUom] = useState('each');
  const [categoryId, setCategoryId] = useState('');
  const [isWeighed, setIsWeighed] = useState(false);
  const [packs, setPacks] = useState<DraftPack[]>([
    newDraftPack({ label: 'single', qtyBase: '1', isDefaultSell: true, isDefaultBuy: true }),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updatePack(key: number, patch: Partial<DraftPack>) {
    setPacks((rows) =>
      rows.map((row) => {
        if (row.key !== key) {
          // Default-sell and default-buy are exclusive across packs -
          // the schema allows exactly one of each per product.
          const clearSell = patch.isDefaultSell === true ? { isDefaultSell: false } : {};
          const clearBuy = patch.isDefaultBuy === true ? { isDefaultBuy: false } : {};
          return { ...row, ...clearSell, ...clearBuy };
        }
        return { ...row, ...patch };
      }),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProduct({
        sku,
        name,
        baseUom,
        categoryId: categoryId === '' ? null : categoryId,
        isWeighed,
        packs: packs.map((p) => ({
          label: p.label,
          qtyBase: Number(p.qtyBase),
          isDefaultSell: p.isDefaultSell,
          isDefaultBuy: p.isDefaultBuy,
          ...(p.barcode.trim() === '' ? {} : { barcode: p.barcode.trim() }),
        })),
      });
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="SKU">
            <input
              required
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="CHAR-500"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </Field>
          <Field label="Name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Charhons biscuits 500g"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </Field>
          <Field label="Base unit">
            <input
              required
              list="base-uom-suggestions"
              value={baseUom}
              onChange={(e) => setBaseUom(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
            <datalist id="base-uom-suggestions">
              {BASE_UOM_SUGGESTIONS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field label="Category">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            checked={isWeighed}
            onChange={(e) => setIsWeighed(e.target.checked)}
            className="accent-accent-600 size-3.5"
          />
          Weighed at the till (embedded-weight barcode)
        </label>

        <div>
          <div className="text-ink-600 mb-1.5 text-[11px] font-medium uppercase tracking-wider">
            Pack hierarchy
          </div>
          <div className="space-y-2">
            {packs.map((pack) => (
              <div
                key={pack.key}
                className="border-ink-200 grid grid-cols-[1fr_100px_auto_auto_1fr_auto] items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5"
              >
                <input
                  required
                  placeholder="Label, e.g. case of 10"
                  value={pack.label}
                  onChange={(e) => updatePack(pack.key, { label: e.target.value })}
                  className="text-[12.5px] outline-none"
                />
                <input
                  required
                  type="number"
                  min="0.0001"
                  step="any"
                  placeholder="Qty base"
                  value={pack.qtyBase}
                  onChange={(e) => updatePack(pack.key, { qtyBase: e.target.value })}
                  className="tnum text-[12.5px] outline-none"
                />
                <label className="flex items-center gap-1 text-[11px] whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={pack.isDefaultSell}
                    onChange={(e) => updatePack(pack.key, { isDefaultSell: e.target.checked })}
                    className="accent-accent-600 size-3.5"
                  />
                  sell
                </label>
                <label className="flex items-center gap-1 text-[11px] whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={pack.isDefaultBuy}
                    onChange={(e) => updatePack(pack.key, { isDefaultBuy: e.target.checked })}
                    className="accent-accent-600 size-3.5"
                  />
                  buy
                </label>
                <input
                  placeholder="Scan or type barcode…"
                  value={pack.barcode}
                  onChange={(e) => updatePack(pack.key, { barcode: e.target.value })}
                  className="text-[12.5px] font-mono outline-none"
                />
                <button
                  type="button"
                  onClick={() => setPacks((rows) => rows.filter((r) => r.key !== pack.key))}
                  disabled={packs.length === 1}
                  className="text-ink-300 hover:text-red-600 disabled:opacity-30"
                  title="Remove pack"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPacks((rows) => [...rows, newDraftPack()])}
            className="text-accent-700 mt-2 text-[12px] font-medium hover:underline"
          >
            + Add another pack
          </button>
        </div>

        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null}
            Create product
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
        {label}
      </span>
      {children}
    </label>
  );
}

// -- detail / edit -------------------------------------------------------------

function Detail({
  productId,
  baseUom,
  categories,
  onProductChanged,
}: {
  productId: string;
  baseUom: string;
  categories: Category[];
  onProductChanged: () => void;
}) {
  const { can } = useAuth();
  const detail = useAsync(() => api.product(productId), [productId]);
  const [editingCore, setEditingCore] = useState(false);
  const [addingPack, setAddingPack] = useState(false);

  if (detail.loading) {
    return (
      <div className="bg-ink-50/60 grid place-items-center py-8">
        <Spinner />
      </div>
    );
  }
  if (detail.error !== undefined) {
    return (
      <div className="bg-ink-50/60 px-4 py-3">
        <ErrorNote error={detail.error} />
      </div>
    );
  }
  if (detail.data === undefined) return null;

  const d = detail.data;
  const canWrite = can('product.write');

  function refresh() {
    detail.reload();
    onProductChanged();
  }

  return (
    <div className="bg-ink-50/60 border-ink-100 border-t px-4 py-4">
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setEditingCore((v) => !v)}>
            {editingCore ? 'Close' : 'Edit product'}
          </Button>
        </div>
      )}

      {editingCore && (
        <EditProductForm
          product={d}
          categories={categories}
          onSaved={() => {
            setEditingCore(false);
            refresh();
          }}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <section>
          <SectionTitle>Pack hierarchy</SectionTitle>
          <ul className="space-y-1.5">
            {d.packs.map((pack) => (
              <PackRow
                key={pack.id}
                pack={pack}
                productId={productId}
                baseUom={baseUom}
                canWrite={canWrite}
                onChanged={refresh}
              />
            ))}
          </ul>

          {canWrite &&
            (addingPack ? (
              <AddPackForm
                productId={productId}
                onDone={() => {
                  setAddingPack(false);
                  refresh();
                }}
                onCancel={() => setAddingPack(false)}
              />
            ) : (
              <button
                onClick={() => setAddingPack(true)}
                className="text-accent-700 mt-2 text-[12px] font-medium hover:underline"
              >
                + Add pack
              </button>
            ))}
        </section>

        <section>
          <SectionTitle>Stock by branch</SectionTitle>
          {d.stock.length === 0 ? (
            <p className="text-ink-400 text-xs">No movements recorded anywhere.</p>
          ) : (
            <ul className="space-y-1">
              {d.stock.map((s) => (
                <li key={s.branchId} className="flex items-center gap-2 text-[12.5px]">
                  <span className="text-ink-600 w-16 shrink-0">{s.branchCode}</span>
                  <span
                    className={`tnum font-medium ${Number(s.qtyBase) < 0 ? 'text-red-600' : ''}`}
                  >
                    {qty(s.qtyBase)}
                  </span>
                  <span className="text-ink-400 ml-auto text-[11.5px]">
                    {s.wac === null ? '—' : money(Number(s.wac))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle>Recent movements</SectionTitle>
          {d.movements.length === 0 ? (
            <p className="text-ink-400 text-xs">Nothing yet.</p>
          ) : (
            <ul className="space-y-1">
              {d.movements.slice(0, 8).map((m) => (
                <li key={m.seq} className="flex items-center gap-2 text-[12px]">
                  <span className="text-ink-300 tnum w-8 shrink-0 font-mono text-[10.5px]">
                    {m.seq}
                  </span>
                  <span
                    className={`tnum w-16 shrink-0 font-medium ${
                      m.qtyBase < 0 ? 'text-red-600' : 'text-accent-700'
                    }`}
                  >
                    {m.qtyBase > 0 ? '+' : ''}
                    {qty(m.qtyBase)}
                  </span>
                  <span className="text-ink-500 truncate">{m.reason.replace(/_/g, ' ')}</span>
                  <span className="text-ink-300 ml-auto shrink-0 text-[11px]">{m.branchCode}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function EditProductForm({
  product,
  categories,
  onSaved,
}: {
  product: {
    id: string;
    sku: string;
    name: string;
    baseUom: string;
    isWeighed: boolean;
    isActive: boolean;
    categoryName: string | null;
  };
  categories: Category[];
  onSaved: () => void;
}) {
  const [sku, setSku] = useState(product.sku);
  const [name, setName] = useState(product.name);
  const [baseUom, setBaseUom] = useState(product.baseUom);
  const [categoryId, setCategoryId] = useState(
    categories.find((c) => c.name === product.categoryName)?.id ?? '',
  );
  const [isWeighed, setIsWeighed] = useState(product.isWeighed);
  const [isActive, setIsActive] = useState(product.isActive);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateProduct(product.id, {
        sku,
        name,
        baseUom,
        categoryId: categoryId === '' ? null : categoryId,
        isWeighed,
        isActive,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-ink-200 mb-4 space-y-3 rounded-lg border bg-white px-3.5 py-3"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="SKU">
          <input
            required
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </Field>
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </Field>
        <Field label="Base unit">
          <input
            required
            value={baseUom}
            onChange={(e) => setBaseUom(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </Field>
        <Field label="Category">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end gap-3 pb-1.5">
          <label className="flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              checked={isWeighed}
              onChange={(e) => setIsWeighed(e.target.checked)}
              className="accent-accent-600 size-3.5"
            />
            Weighed
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="accent-accent-600 size-3.5"
            />
            Active
          </label>
        </div>
      </div>

      {error !== null && <div className="text-[12px] text-red-600">{error}</div>}

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? <Spinner /> : null}
        Save changes
      </Button>
    </form>
  );
}

function PackRow({
  pack,
  productId,
  baseUom,
  canWrite,
  onChanged,
}: {
  pack: Pack;
  productId: string;
  baseUom: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(pack.label);
  const [qtyBase, setQtyBase] = useState(String(pack.qtyBase));
  const [addingBarcode, setAddingBarcode] = useState(false);
  const [newBarcode, setNewBarcode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updatePack(productId, pack.id, { label, qtyBase: Number(qtyBase) });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function attachBarcode() {
    setBusy(true);
    setError(null);
    try {
      await api.attachBarcode(productId, pack.id, newBarcode.trim());
      setAddingBarcode(false);
      setNewBarcode('');
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeBarcode() {
    if (pack.barcode === null) return;
    setBusy(true);
    try {
      await api.removeBarcode(pack.barcode);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="border-ink-200 flex flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5 text-[12.5px]">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-28 outline-none"
        />
        <input
          type="number"
          min="0.0001"
          step="any"
          value={qtyBase}
          onChange={(e) => setQtyBase(e.target.value)}
          className="tnum w-16 outline-none"
        />
        <Button onClick={() => void save()} disabled={busy}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {error !== null && <span className="text-[11px] text-red-600">{error}</span>}
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 text-[12.5px]">
      <span className="font-medium">{pack.label}</span>
      <span className="text-ink-400">=</span>
      <span className="tnum">
        {qty(pack.qtyBase)} {baseUom}
      </span>
      {pack.isDefaultSell && <Badge tone="good">sell</Badge>}
      {pack.isDefaultBuy && <Badge tone="info">buy</Badge>}

      <span className="ml-auto flex items-center gap-1.5">
        {pack.barcode !== null ? (
          <span className="text-ink-400 flex items-center gap-1 font-mono text-[11px]">
            {pack.barcode}
            {canWrite && (
              <button
                onClick={() => void removeBarcode()}
                disabled={busy}
                className="text-ink-300 hover:text-red-600"
                title="Remove barcode"
              >
                ✕
              </button>
            )}
          </span>
        ) : (
          canWrite &&
          (addingBarcode ? (
            <span className="flex items-center gap-1">
              <input
                autoFocus
                placeholder="Scan or type…"
                value={newBarcode}
                onChange={(e) => setNewBarcode(e.target.value)}
                className="border-ink-200 w-28 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
              />
              <Button onClick={() => void attachBarcode()} disabled={busy || newBarcode.trim() === ''}>
                Add
              </Button>
            </span>
          ) : (
            <button
              onClick={() => setAddingBarcode(true)}
              className="text-accent-700 text-[11px] font-medium hover:underline"
            >
              + barcode
            </button>
          ))
        )}
        {canWrite && (
          <button
            onClick={() => setEditing(true)}
            className="text-ink-300 hover:text-ink-700 text-[11px]"
            title="Edit pack"
          >
            edit
          </button>
        )}
      </span>
      {error !== null && <span className="text-[11px] text-red-600">{error}</span>}
    </li>
  );
}

function AddPackForm({
  productId,
  onDone,
  onCancel,
}: {
  productId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [qtyBase, setQtyBase] = useState('1');
  const [barcode, setBarcode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addPack(productId, {
        label,
        qtyBase: Number(qtyBase),
        ...(barcode.trim() === '' ? {} : { barcode: barcode.trim() }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-ink-200 mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5 text-[12.5px]"
    >
      <input
        required
        autoFocus
        placeholder="Label, e.g. case of 10"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-32 outline-none"
      />
      <input
        required
        type="number"
        min="0.0001"
        step="any"
        placeholder="Qty base"
        value={qtyBase}
        onChange={(e) => setQtyBase(e.target.value)}
        className="tnum w-20 outline-none"
      />
      <input
        placeholder="Scan or type barcode…"
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        className="w-32 font-mono outline-none"
      />
      <Button type="submit" disabled={busy}>
        Add
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error !== null && <span className="text-[11px] text-red-600">{error}</span>}
    </form>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-ink-400 mb-2 text-[10.5px] font-medium uppercase tracking-wider">
      {children}
    </h3>
  );
}
