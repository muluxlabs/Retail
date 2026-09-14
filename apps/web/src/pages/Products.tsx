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
 */

import { useState } from 'react';

import { api } from '../lib/api.js';
import { Badge, Card, Empty, ErrorNote, money, qty, Spinner, useAsync } from '../lib/ui.js';

export function Products() {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const products = useAsync(
    () => api.products({ ...(search === '' ? {} : { search }), limit: 200 }),
    [search],
  );

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
        <div className="text-ink-400 text-xs">
          {products.data !== undefined && `${products.data.total} active products`}
        </div>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or SKU…"
        className="border-ink-200 focus:border-accent-500 w-full max-w-md rounded-lg border bg-white px-3 py-1.5 text-[12.5px] outline-none"
      />

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
                        {product.packs.length === 0 && <Badge tone="bad">no pack</Badge>}
                        {!hasBarcode && product.packs.length > 0 && (
                          <Badge tone="warn">no barcode</Badge>
                        )}
                        {product.mergedIntoId !== null && <Badge tone="neutral">merged</Badge>}
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

                  {isOpen && <Detail productId={product.id} baseUom={product.baseUom} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Detail({ productId, baseUom }: { productId: string; baseUom: string }) {
  const detail = useAsync(() => api.product(productId), [productId]);

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

  return (
    <div className="bg-ink-50/60 border-ink-100 grid gap-5 border-t px-4 py-4 lg:grid-cols-3">
      <section>
        <SectionTitle>Pack hierarchy</SectionTitle>
        <ul className="space-y-1.5">
          {d.packs.map((pack) => (
            <li key={pack.id} className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium">{pack.label}</span>
              <span className="text-ink-400">=</span>
              <span className="tnum">
                {qty(pack.qtyBase)} {baseUom}
              </span>
              {pack.isDefaultSell && <Badge tone="good">sell</Badge>}
              {pack.isDefaultBuy && <Badge tone="info">buy</Badge>}
              {pack.barcode !== null && (
                <span className="text-ink-400 ml-auto font-mono text-[11px]">{pack.barcode}</span>
              )}
            </li>
          ))}
        </ul>
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
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-ink-400 mb-2 text-[10.5px] font-medium uppercase tracking-wider">
      {children}
    </h3>
  );
}
