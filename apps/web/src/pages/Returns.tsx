/**
 * Returns to suppliers: goods sent back - damaged, expired, wrong or too many.
 *
 * A purchase return note (PRN) takes the stock off the books at what it cost
 * and reduces what is owed to the supplier by the same, as the supplier's
 * credit note will. Started from a delivery, it offers that delivery's lines
 * at the price they came in at, and never lets more go back than came in.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { parseLines, PurchaseLines, type PurchaseLine } from '../components/PurchaseLines.js';
import { api, ApiError, type GrnDetail } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { costLineCents, fromCents, parseCost, parseQty } from '../lib/basketMath.js';
import { packCost, shortDate, shortDateTime } from '../lib/buying.js';
import { Button, Card, Empty, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function Returns() {
  const { can } = useAuth();
  const [supplierId, setSupplierId] = useState('');
  const suppliers = useAsync(() => api.suppliers({ includeInactive: true }), []);
  const list = useAsync(() => api.purchaseReturns({ ...(supplierId === '' ? {} : { supplierId }), limit: 100 }), [supplierId]);
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Returns to suppliers</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Goods sent back to a supplier. Each return takes the stock off the books at what it cost and takes the same off what is owed to
            the supplier. To return goods from a particular delivery, open the delivery and choose Return goods.
          </p>
        </div>
        {can('purchase.return') && (
          <Link to="/returns/new" className="bg-accent-600 hover:bg-accent-700 inline-flex items-center rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm">
            New return
          </Link>
        )}
      </div>
      <Card className="px-4 py-3">
        <label className="block max-w-xs">
          <span className={label}>Supplier</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={field} aria-label="Supplier">
            <option value="">All suppliers</option>
            {(suppliers.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </Card>
      {list.error !== undefined && <ErrorNote error={list.error} />}
      <Card className="overflow-hidden">
        {list.loading && list.data === undefined ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="No returns" hint="Goods sent back to suppliers appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="returns">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Return</th>
                  <th className="px-2 py-2 font-medium">Supplier</th>
                  <th className="px-2 py-2 font-medium">Branch</th>
                  <th className="px-2 py-2 font-medium">From delivery</th>
                  <th className="px-2 py-2 font-medium">Why</th>
                  <th className="px-2 py-2 font-medium">Credit note</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/60" data-testid="return-row">
                    <td className="px-4 py-2">
                      <Link to={`/returns/${r.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                        {r.prnNo}
                      </Link>
                      <div className="text-ink-400 text-[11px]">
                        {shortDate(r.returnedAt)} · {r.returnedByName}
                      </div>
                    </td>
                    <td className="px-2 py-2">{r.supplierName}</td>
                    <td className="px-2 py-2">{r.branchName}</td>
                    <td className="px-2 py-2 font-mono text-[12px]">{r.grnNo ?? '—'}</td>
                    <td className="text-ink-600 px-2 py-2">{r.reason}</td>
                    <td className="px-2 py-2">{r.creditNoteNo ?? <span className="text-ink-400">awaited</span>}</td>
                    <td className="tnum px-4 py-2 text-right font-medium">{money(r.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

interface FromDelivery {
  lineId: string;
  productId: string;
  packId: string;
  name: string;
  sku: string;
  packLabel: string;
  packQtyBase: number;
  deliveredPacks: number;
  returnablePacks: number;
  unitCost: number;
  qty: string;
}

function linesFromDelivery(g: GrnDetail): FromDelivery[] {
  return g.lines.map((l) => {
    const packQtyBase = l.qtyPacks > 0 ? l.qtyBase / l.qtyPacks : 1;
    return {
      lineId: l.id,
      productId: l.productId,
      packId: l.packId,
      name: l.name,
      sku: l.sku,
      packLabel: l.packLabel,
      packQtyBase,
      deliveredPacks: l.qtyPacks,
      returnablePacks: Math.round(((l.qtyBase - l.returnedBase) / packQtyBase) * 10_000) / 10_000,
      unitCost: l.unitCost,
      qty: '',
    };
  });
}

export function NewReturn() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const grnId = params.get('grnId');
  const grn = useAsync(() => (grnId === null ? Promise.resolve(undefined) : api.goodsReceivedNote(grnId)), [grnId]);
  const suppliers = useAsync(() => api.suppliers({}), []);
  const allBranches = useAsync(() => api.branches(), []);
  const scoped = user?.branchIds ?? [];
  const branchList = (allBranches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));

  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [reason, setReason] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [fromDelivery, setFromDelivery] = useState<FromDelivery[]>([]);
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [id] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (grn.data !== undefined) {
      setSupplierId(grn.data.supplierId);
      setBranchId(grn.data.branchId);
      setFromDelivery(linesFromDelivery(grn.data));
    }
  }, [grn.data]);
  useEffect(() => {
    if (grnId === null && branchId === '' && branchList.length === 1 && branchList[0] !== undefined) setBranchId(branchList[0].id);
  }, [branchList, branchId, grnId]);

  // -- what is going back, and what it is worth --------------------------------------------------------------------
  const deliveryCheck = useMemo(() => {
    let cents = 0;
    let any = false;
    let problem: string | null = null;
    for (const l of fromDelivery) {
      if (l.qty.trim() === '') continue;
      const q = parseQty(l.qty);
      if (q === null) {
        problem ??= `${l.name}: enter a quantity above zero`;
        continue;
      }
      if (q > l.returnablePacks + 1e-9) problem ??= `${l.name}: at most ${qty(l.returnablePacks)} can go back`;
      any = true;
      cents += costLineCents(q, l.unitCost);
    }
    return { cents, any, problem };
  }, [fromDelivery]);
  const free = parseLines(lines, true);

  const usingDelivery = grnId !== null;
  const totalCents = usingDelivery ? deliveryCheck.cents : free.totalCents;
  const linesOk = usingDelivery ? deliveryCheck.any && deliveryCheck.problem === null : free.ok;
  const canPost = supplierId !== '' && branchId !== '' && reason.trim().length >= 3 && linesOk && !busy;

  async function post() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.returnGoods({
        id,
        supplierId,
        branchId,
        grnId: grnId,
        reason: reason.trim(),
        creditNoteNo: creditNote.trim() === '' ? null : creditNote.trim(),
        lines: usingDelivery
          ? fromDelivery
              .filter((l) => l.qty.trim() !== '')
              .map((l) => ({ productId: l.productId, packId: l.packId, qtyPacks: parseQty(l.qty)!, grnLineId: l.lineId }))
          : lines.map((l) => ({
              productId: l.productId,
              packId: l.packId,
              qtyPacks: parseQty(l.qty)!,
              ...(l.cost.trim() === '' ? {} : { unitCost: parseCost(l.cost) }),
            })),
      });
      nav(`/returns/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  if (grn.error !== undefined) return <ErrorNote error={grn.error} />;

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 text-[12px]">
        <Link to="/returns" className="hover:text-ink-700 hover:underline">
          Returns
        </Link>{' '}
        / New return
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Return goods to a supplier</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          {usingDelivery && grn.data !== undefined
            ? `From delivery ${grn.data.grnNo} (${grn.data.supplierName}, ${shortDate(grn.data.receivedAt)}): enter how many of each are going back. They go back at the price they came in at.`
            : 'Choose the supplier and branch, then the items going back. Leave the cost blank to use what the branch paid on average.'}
        </p>
      </div>

      <Card className="px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={label}>Supplier</span>
            <select value={supplierId} disabled={usingDelivery} onChange={(e) => setSupplierId(e.target.value)} className={`${field} disabled:opacity-60`} aria-label="Supplier">
              <option value="">Choose a supplier…</option>
              {(suppliers.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              {usingDelivery && grn.data !== undefined && <option value={grn.data.supplierId}>{grn.data.supplierName}</option>}
            </select>
          </label>
          <label className="block">
            <span className={label}>From branch</span>
            <select value={branchId} disabled={usingDelivery} onChange={(e) => setBranchId(e.target.value)} className={`${field} disabled:opacity-60`} aria-label="From branch">
              <option value="">Choose a branch…</option>
              {branchList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {usingDelivery && grn.data !== undefined && !branchList.some((b) => b.id === grn.data?.branchId) && (
                <option value={grn.data.branchId}>{grn.data.branchName}</option>
              )}
            </select>
          </label>
          <label className="block">
            <span className={label}>Why are they going back?</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Damaged in transit" aria-label="Reason" className={field} />
          </label>
          <label className="block">
            <span className={label}>Supplier credit note (optional)</span>
            <input value={creditNote} onChange={(e) => setCreditNote(e.target.value)} aria-label="Credit note number" className={field} />
          </label>
        </div>
      </Card>

      <Card className="px-4 py-4">
        {usingDelivery ? (
          grn.data === undefined ? (
            <div className="grid place-items-center py-8">
              <Spinner />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" data-testid="return-lines">
                <thead>
                  <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                    <th className="py-2 pr-2 font-medium">Item</th>
                    <th className="px-2 py-2 font-medium">Pack</th>
                    <th className="px-2 py-2 text-right font-medium">Delivered</th>
                    <th className="px-2 py-2 text-right font-medium">Can go back</th>
                    <th className="px-2 py-2 text-right font-medium">Returning</th>
                    <th className="px-2 py-2 text-right font-medium">Price per pack</th>
                    <th className="px-2 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-ink-100 divide-y">
                  {fromDelivery.map((l) => {
                    const q = parseQty(l.qty);
                    const over = q !== null && q > l.returnablePacks + 1e-9;
                    return (
                      <tr key={l.lineId}>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{l.name}</div>
                          <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                        </td>
                        <td className="px-2 py-2">{l.packLabel}</td>
                        <td className="tnum px-2 py-2 text-right">{qty(l.deliveredPacks)}</td>
                        <td className="tnum px-2 py-2 text-right">{qty(l.returnablePacks)}</td>
                        <td className="px-2 py-2 text-right">
                          <input
                            inputMode="decimal"
                            value={l.qty}
                            disabled={l.returnablePacks <= 0}
                            placeholder="0"
                            aria-label={`Returning of ${l.name}`}
                            onChange={(e) => setFromDelivery((ls) => ls.map((x) => (x.lineId === l.lineId ? { ...x, qty: e.target.value } : x)))}
                            className={`tnum w-24 rounded-lg border bg-white px-2 py-1.5 text-right outline-none disabled:opacity-50 ${over ? 'border-red-400' : 'border-ink-200 focus:border-accent-500'}`}
                          />
                        </td>
                        <td className="tnum px-2 py-2 text-right">{packCost(l.unitCost)}</td>
                        <td className="tnum px-2 py-2 text-right font-medium">{q === null ? '—' : money(fromCents(costLineCents(q, l.unitCost)))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {deliveryCheck.problem !== null && <p className="mt-2 text-[12.5px] text-red-700">{deliveryCheck.problem}</p>}
            </div>
          )
        ) : (
          <PurchaseLines lines={lines} onChange={setLines} costOptional costLabel="Cost per pack" />
        )}
      </Card>

      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => void post()} disabled={!canPost}>
          {busy ? <Spinner /> : null}
          Post return{totalCents > 0 ? ` · ${money(fromCents(totalCents))}` : ''}
        </Button>
        <span className="text-ink-400 text-[12px]">The stock leaves the books and what is owed to the supplier goes down by the same.</span>
      </div>
    </div>
  );
}

export function ReturnDetailPage() {
  const { id = '' } = useParams();
  const r = useAsync(() => api.purchaseReturn(id), [id]);
  if (r.error !== undefined) return <ErrorNote error={r.error} />;
  const d = r.data;
  if (d === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/returns" className="hover:text-ink-700 hover:underline">
          Returns
        </Link>{' '}
        / {d.prnNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Purchase return note <span className="font-mono" data-testid="prn-no">{d.prnNo}</span>
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            To{' '}
            <Link to={`/suppliers/${d.supplierId}`} className="hover:text-accent-700 font-medium hover:underline">
              {d.supplierName}
            </Link>{' '}
            · from {d.branchName} · {shortDateTime(d.returnedAt)} by {d.returnedByName}
          </p>
          <p className="text-ink-500 text-[12.5px]">
            Why: {d.reason}
            {d.grnId !== null && d.grnNo !== null && (
              <>
                {' '}
                · from delivery{' '}
                <Link to={`/receive/${d.grnId}`} className="hover:text-accent-700 font-mono hover:underline">
                  {d.grnNo}
                </Link>
              </>
            )}
            {' · '}
            {d.creditNoteNo === null ? 'supplier credit note awaited' : `supplier credit note ${d.creditNoteNo}`}
          </p>
        </div>
        <Button onClick={() => window.print()} className="no-print">
          Print
        </Button>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="prn-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Pack</th>
                <th className="px-2 py-2 text-right font-medium">Returned</th>
                <th className="px-2 py-2 text-right font-medium">Units off the books</th>
                <th className="px-2 py-2 text-right font-medium">Price per pack</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {d.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="px-4 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                  </td>
                  <td className="px-2 py-1.5">{l.packLabel}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyPacks)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyBase)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{packCost(l.unitCost)}</td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t font-semibold">
                <td colSpan={5} className="px-4 py-2 text-right">
                  Credit due from the supplier
                </td>
                <td className="tnum px-4 py-2 text-right" data-testid="prn-total">{money(d.totalCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
