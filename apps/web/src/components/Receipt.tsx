/**
 * A till receipt: on screen as a preview, and on paper at the width of the
 * roll in the printer (80mm or 58mm, from Settings).
 *
 * Printing is the browser's: any thermal printer installed in the operating
 * system prints it, with no driver code of our own. The receipt is portalled
 * to <body> and, while printing, everything else is hidden - so the paper gets
 * the receipt and nothing else, and the page size is the roll width.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import type { Receipt as ReceiptData } from '../lib/api.js';
import { Button, money, qty } from '../lib/ui.js';

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function printReceipt(widthMm: number): void {
  const style = document.createElement('style');
  style.setAttribute('data-receipt-page', '');
  style.textContent = `@page { size: ${widthMm}mm auto; margin: 0; }`;
  document.head.appendChild(style);
  document.body.classList.add('print-receipt');
  const done = () => {
    document.body.classList.remove('print-receipt');
    style.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

export function ReceiptSheet({ receipt }: { receipt: ReceiptData }) {
  const b = receipt.business;
  return (
    <div
      className="receipt-sheet bg-white font-mono text-[11.5px] leading-snug text-black"
      style={{ width: `${b.widthMm}mm` }}
      data-testid="receipt"
    >
      <div className="text-center">
        <div className="text-[14px] font-bold uppercase">{b.name}</div>
        {b.address !== '' && <div>{b.address}</div>}
        {b.phone !== '' && <div>Tel {b.phone}</div>}
        {b.tin !== '' && <div>TIN {b.tin}</div>}
        <div className="mt-1">{receipt.branch.name}</div>
      </div>

      <div className="my-2 border-y border-dashed border-black py-1">
        <div className="flex justify-between">
          <span>Receipt</span>
          <span className="font-bold">{receipt.receiptNo}</span>
        </div>
        <div className="flex justify-between">
          <span>Date</span>
          <span>{fmtDate(receipt.occurredAt)}</span>
        </div>
        <div className="flex justify-between">
          <span>Cashier</span>
          <span>{receipt.cashier.name}</span>
        </div>
        {receipt.till !== null && (
          <div className="flex justify-between">
            <span>Till</span>
            <span>{receipt.till}</span>
          </div>
        )}
      </div>

      <table className="w-full">
        <tbody>
          {receipt.lines.map((l) => (
            <tr key={l.lineNo} className="align-top">
              <td className="py-0.5 pr-1">
                <div>{l.name}</div>
                <div className="text-[10.5px]">
                  {qty(l.qtyPacks)} {l.packLabel} × {money(l.unitPrice)}
                  {l.discount > 0 && <> less {money(l.discount)}</>}
                </div>
              </td>
              <td className="tnum py-0.5 text-right whitespace-nowrap">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-1 border-t border-dashed border-black pt-1">
        {receipt.discount > 0 && (
          <>
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span className="tnum">{money(receipt.gross)}</span>
            </div>
            <div className="flex justify-between">
              <span>Discount</span>
              <span className="tnum">-{money(receipt.discount)}</span>
            </div>
          </>
        )}
        <div className="flex justify-between text-[14px] font-bold">
          <span>TOTAL</span>
          <span className="tnum">{money(receipt.net)}</span>
        </div>
        <div className="text-[10.5px]">
          {receipt.lines.length} {receipt.lines.length === 1 ? 'item' : 'items'}
        </div>
      </div>

      <div className="mt-1 border-t border-dashed border-black pt-1">
        {receipt.payments.map((p, i) => (
          <div key={i}>
            <div className="flex justify-between">
              <span>{p.type}</span>
              <span className="tnum">{money(p.isCash ? p.tendered : p.amount)}</span>
            </div>
            {p.reference !== null && p.reference !== '' && <div className="text-[10.5px]">Ref {p.reference}</div>}
          </div>
        ))}
        {receipt.change > 0 && (
          <div className="flex justify-between font-bold">
            <span>Change</span>
            <span className="tnum">{money(receipt.change)}</span>
          </div>
        )}
      </div>

      {b.footer !== '' && <div className="mt-2 text-center">{b.footer}</div>}
      <div className="mt-1 text-center text-[10px]">{receipt.currency}</div>
    </div>
  );
}

/** Modal preview with Print / Done. Escape closes it. */
export function ReceiptDialog({
  receipt,
  onClose,
  closeLabel = 'New sale',
}: {
  receipt: ReceiptData;
  onClose: () => void;
  closeLabel?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="receipt-portal fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-label="Receipt"
    >
      <div className="my-auto flex flex-col items-center gap-3">
        <div className="rounded-sm p-3 shadow-xl" style={{ background: '#fff' }}>
          <ReceiptSheet receipt={receipt} />
        </div>
        <div className="no-print flex gap-2">
          <Button variant="primary" onClick={() => printReceipt(receipt.business.widthMm)}>
            Print receipt
          </Button>
          <Button onClick={onClose}>{closeLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
