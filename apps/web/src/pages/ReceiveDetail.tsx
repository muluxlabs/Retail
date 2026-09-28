/**
 * One goods received note, as a printable document: who it came from, what
 * arrived against what was ordered, at what cost, and how it compares with the
 * supplier's invoice.
 */

import { Link, useParams } from 'react-router-dom';

import { BuyingTabs } from '../components/BuyingTabs.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { packCost, shortDate, shortDateTime } from '../lib/buying.js';
import { Button, Card, ErrorNote, Spinner, money, qty, useAsync } from '../lib/ui.js';

export function ReceiveDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const grn = useAsync(() => api.goodsReceivedNote(id), [id]);
  if (grn.error !== undefined) return <ErrorNote error={grn.error} />;
  const g = grn.data;
  if (g === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const invoiceDiff = g.invoiceTotal === null ? null : Math.round((g.invoiceTotal - g.totalCost) * 100) / 100;

  return (
    <div className="space-y-4">
      <BuyingTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/receive" className="hover:text-ink-700 hover:underline">
          Goods received
        </Link>{' '}
        / {g.grnNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Goods received note <span className="font-mono" data-testid="grn-no">{g.grnNo}</span>
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            From{' '}
            <Link to={`/suppliers/${g.supplierId}`} className="hover:text-accent-700 font-medium hover:underline">
              {g.supplierName}
            </Link>{' '}
            · into {g.branchName} · received {shortDateTime(g.receivedAt)} by {g.receivedByName}
          </p>
          <p className="text-ink-400 text-[12px]">
            {g.poId !== null && g.poNo !== null && (
              <>
                Against order{' '}
                <Link to={`/orders/${g.poId}`} className="hover:text-accent-700 font-mono hover:underline">
                  {g.poNo}
                </Link>
                {' · '}
              </>
            )}
            {g.invoiceNo !== null ? `Supplier invoice ${g.invoiceNo}` : 'No supplier invoice number recorded'}
            {g.invoiceDate !== null && ` dated ${shortDate(g.invoiceDate)}`}
          </p>
        </div>
        <div className="no-print flex gap-2">
          {can('purchase.return') && (
            <Link to={`/returns/new?grnId=${g.id}`} className="bg-white text-ink-700 ring-ink-200 hover:bg-ink-50 inline-flex items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset">
              Return goods
            </Link>
          )}
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </div>
      {g.notes !== null && <p className="text-ink-500 text-[12.5px]">{g.notes}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="grn-lines">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Pack</th>
                <th className="px-2 py-2 text-right font-medium">Received</th>
                <th className="px-2 py-2 text-right font-medium">Units into stock</th>
                <th className="px-2 py-2 text-right font-medium">Price per pack</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {g.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="px-4 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-ink-400 font-mono text-[11px]">{l.sku}</div>
                  </td>
                  <td className="px-2 py-1.5">{l.packLabel}</td>
                  <td className="tnum px-2 py-1.5 text-right">
                    {qty(l.qtyPacks)}
                    {l.orderedPacks !== null && <span className="text-ink-400 text-[11px]"> of {qty(l.orderedPacks)} ordered</span>}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right">{qty(l.qtyBase)}</td>
                  <td className="tnum px-2 py-1.5 text-right">
                    {packCost(l.unitCost)}
                    {l.orderedUnitCost !== null && Math.abs(l.orderedUnitCost - l.unitCost) > 0.00005 && (
                      <div className="text-[11px] text-amber-700">ordered at {packCost(l.orderedUnitCost)}</div>
                    )}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t font-semibold">
                <td colSpan={5} className="px-4 py-2 text-right">
                  Total received at cost
                </td>
                <td className="tnum px-4 py-2 text-right" data-testid="grn-total">{money(g.totalCost)}</td>
              </tr>
              {g.invoiceTotal !== null && (
                <tr className="text-ink-600">
                  <td colSpan={5} className="px-4 py-1 text-right">
                    Supplier invoice total
                  </td>
                  <td className="tnum px-4 py-1 text-right">{money(g.invoiceTotal)}</td>
                </tr>
              )}
              {invoiceDiff !== null && Math.abs(invoiceDiff) >= 0.005 && (
                <tr className="text-amber-800">
                  <td colSpan={5} className="px-4 py-1 text-right">
                    Difference between invoice and goods received
                  </td>
                  <td className="tnum px-4 py-1 text-right">{money(invoiceDiff)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
