/**
 * End of day.
 *
 * The X report is the day so far at a branch, since its last close. Closing
 * the day counts every till - blind: the screen never shows what the books
 * expect until the close is posted - and issues the Z report: a numbered,
 * unchangeable record of the receipts issued, the takings, and each till's
 * cash expected against counted. Any over or short is posted to the till and
 * lands in the exception queue.
 *
 * A Z report covers a range of receipt numbers, starting where the last one
 * ended, so every sale is on exactly one of them.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { CashTabs } from '../components/CashTabs.js';
import { api, ApiError, type DayFigures } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { parseMoney } from '../lib/basketMath.js';
import { shortDate, shortDateTime } from '../lib/buying.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, money, useAsync, EXCEPTION_LABEL } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

/** Two tills with the same name must still be told apart when counting: number them. */
function tillName(tills: { name: string }[], i: number): string {
  const name = tills[i]!.name;
  const same = tills.filter((t) => t.name === name).length;
  return same > 1 ? `${name} (${tills.slice(0, i + 1).filter((t) => t.name === name).length} of ${same})` : name;
}

function Figures({ f }: { f: DayFigures }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <table className="w-full text-[12.5px]" data-testid="day-figures">
        <tbody className="divide-ink-100 divide-y">
          <tr>
            <td className="text-ink-500 py-1.5">Receipts</td>
            <td className="tnum py-1.5 text-right font-medium">
              {f.receipts.toLocaleString()}
              {f.firstReceipt !== null && (
                <div className="text-ink-400 font-mono text-[11px] font-normal">
                  {f.firstReceipt} to {f.lastReceipt}
                </div>
              )}
            </td>
          </tr>
          <tr>
            <td className="text-ink-500 py-1.5">Total sales</td>
            <td className="tnum py-1.5 text-right">{money(f.gross)}</td>
          </tr>
          <tr>
            <td className="text-ink-500 py-1.5 pl-3">Less: discounts</td>
            <td className="tnum py-1.5 text-right">{f.discounts === 0 ? '—' : `(${money(f.discounts)})`}</td>
          </tr>
          <tr className="font-semibold">
            <td className="py-1.5">Net sales</td>
            <td className="tnum py-1.5 text-right" data-testid="day-net">{money(f.net)}</td>
          </tr>
          <tr>
            <td className="text-ink-500 py-1.5 pl-3">Less: cost of sales</td>
            <td className="tnum py-1.5 text-right">{f.cost === 0 ? '—' : `(${money(f.cost)})`}</td>
          </tr>
          <tr className="font-semibold">
            <td className="py-1.5">Gross profit</td>
            <td className="tnum py-1.5 text-right">{money(f.grossProfit)}</td>
          </tr>
          {f.uncostedNet > 0 && (
            <tr>
              <td className="py-1.5 text-amber-800">Sales with no cost on record</td>
              <td className="tnum py-1.5 text-right text-amber-800">{money(f.uncostedNet)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div>
        <div className="text-ink-500 mb-1 text-[11px] font-medium uppercase tracking-wider">Takings by payment method</div>
        {f.byPayment.length === 0 ? (
          <p className="text-ink-400 text-[12.5px]">None</p>
        ) : (
          <table className="w-full text-[12.5px]" data-testid="day-by-payment">
            <tbody className="divide-ink-100 divide-y">
              {f.byPayment.map((p) => (
                <tr key={p.paymentTypeId}>
                  <td className="py-1.5">
                    {p.name} <span className="text-ink-400 text-[11px]">· {p.receipts}</span>
                  </td>
                  <td className="tnum py-1.5 text-right">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <div className="text-ink-500 mb-1 text-[11px] font-medium uppercase tracking-wider">By cashier</div>
        {f.byCashier.length === 0 ? (
          <p className="text-ink-400 text-[12.5px]">None</p>
        ) : (
          <table className="w-full text-[12.5px]" data-testid="day-by-cashier">
            <tbody className="divide-ink-100 divide-y">
              {f.byCashier.map((c) => (
                <tr key={c.cashierId}>
                  <td className="py-1.5">
                    {c.name} <span className="text-ink-400 text-[11px]">· {c.receipts}</span>
                  </td>
                  <td className="tnum py-1.5 text-right">{money(c.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function DayClose() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const mayClose = can('day.close');
  const allBranches = useAsync(() => api.branches(), []);
  const scoped = user?.branchIds ?? [];
  const branchList = (allBranches.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id));
  const [branchId, setBranchId] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [id] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (branchId === '' && branchList.length === 1 && branchList[0] !== undefined) setBranchId(branchList[0].id);
  }, [branchList, branchId]);

  const preview = useAsync(() => (branchId === '' || !mayClose ? Promise.resolve(undefined) : api.dayPreview(branchId)), [branchId, mayClose]);
  const history = useAsync(() => api.zReports({ ...(branchId === '' ? {} : { branchId }), limit: 30 }), [branchId]);
  const p = preview.data;

  const bad = (p?.tills ?? []).filter((t) => (counts[t.id] ?? '').trim() === '' || parseMoney(counts[t.id] ?? '') === null);
  const canClose = p !== undefined && bad.length === 0 && !busy;

  async function close() {
    if (p === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.closeDay({
        id,
        branchId,
        note: note.trim() === '' ? null : note.trim(),
        counts: p.tills.map((t) => ({ cashPointId: t.id, counted: parseMoney(counts[t.id] ?? '')! })),
      });
      nav(`/day-close/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      <CashTabs />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">End of day</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          The day so far at a branch, and closing it: count the cash in every till, and the Z report records the receipts issued, the
          takings and each till's cash against what the books expected. Every sale is on exactly one Z report.
        </p>
      </div>

      <Card className="px-4 py-3">
        <label className="block max-w-xs">
          <span className={label}>Branch</span>
          <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setCounts({}); }} className={field} aria-label="Branch">
            <option value="">{mayClose ? 'Choose a branch…' : 'All branches'}</option>
            {branchList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </Card>

      {mayClose && branchId !== '' && (
        <>
          {preview.error !== undefined && <ErrorNote error={preview.error} />}
          {p === undefined ? (
            <div className="grid place-items-center py-12">
              <Spinner />
            </div>
          ) : (
            <>
              <Card className="px-4 py-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-[13px] font-semibold tracking-tight">The day so far (X report)</h2>
                  <span className="text-ink-400 text-[12px]">
                    {p.lastClose === null ? 'Since the branch started trading' : `Since ${p.lastClose.closeNo}, ${shortDateTime(p.lastClose.at)}`}
                  </span>
                </div>
                {p.figures.receipts === 0 ? <p className="text-ink-400 text-[12.5px]">No sales since the last close.</p> : <Figures f={p.figures} />}
              </Card>

              <Card className="px-4 py-4">
                <h2 className="text-[13px] font-semibold tracking-tight">Close the day</h2>
                <p className="text-ink-500 mt-0.5 mb-3 text-[12.5px]">
                  Count the cash in each till and enter what is there. What the books expect is shown only after the close - that keeps the count
                  honest.
                </p>
                {p.tills.length === 0 ? (
                  <p className="text-ink-400 mb-3 text-[12.5px]">This branch has no tills to count.</p>
                ) : (
                  <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {p.tills.map((t, i) => (
                      <label key={t.id} className="block">
                        <span className={label}>{tillName(p.tills, i)} - cash counted</span>
                        <input
                          inputMode="decimal"
                          value={counts[t.id] ?? ''}
                          onChange={(e) => setCounts((c) => ({ ...c, [t.id]: e.target.value }))}
                          placeholder="0.00"
                          aria-label={`Cash counted in ${tillName(p.tills, i)}`}
                          className={`${field} tnum text-right`}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <label className="mb-3 block max-w-lg">
                  <span className={label}>Note (optional)</span>
                  <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" className={field} />
                </label>
                {error !== null && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}
                {confirming ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <span className="text-[12.5px] text-amber-900">
                      Close the day at {branchList.find((b) => b.id === branchId)?.name}? The Z report cannot be changed afterwards.
                    </span>
                    <Button variant="primary" onClick={() => void close()} disabled={!canClose}>
                      {busy ? <Spinner /> : null}
                      Yes, close the day
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Not yet
                    </Button>
                  </div>
                ) : (
                  <Button variant="primary" onClick={() => setConfirming(true)} disabled={!canClose}>
                    Close the day
                  </Button>
                )}
              </Card>
            </>
          )}
        </>
      )}

      <Card className="overflow-hidden">
        <div className="border-ink-100 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Z reports</h2>
        </div>
        {(history.data?.items ?? []).length === 0 ? (
          <Empty title="No days closed yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="z-list">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Z report</th>
                  <th className="px-2 py-2 font-medium">Day</th>
                  <th className="px-2 py-2 font-medium">Branch</th>
                  <th className="px-2 py-2 font-medium">Closed by</th>
                  <th className="px-2 py-2 text-right font-medium">Receipts</th>
                  <th className="px-2 py-2 text-right font-medium">Net sales</th>
                  <th className="px-4 py-2 text-right font-medium">Cash over / (short)</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {(history.data?.items ?? []).map((z) => (
                  <tr key={z.id} className="hover:bg-ink-50/60" data-testid="z-row">
                    <td className="px-4 py-2">
                      <Link to={`/day-close/${z.id}`} className="hover:text-accent-700 font-mono font-medium hover:underline">
                        {z.closeNo}
                      </Link>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{shortDate(z.businessDay)}</td>
                    <td className="px-2 py-2">{z.branchName}</td>
                    <td className="text-ink-600 px-2 py-2">{z.closedByName}</td>
                    <td className="tnum px-2 py-2 text-right">{z.receipts}</td>
                    <td className="tnum px-2 py-2 text-right font-medium">{money(z.net)}</td>
                    <td className={`tnum px-4 py-2 text-right ${z.cashVariance < 0 ? 'font-medium text-red-700' : ''}`}>
                      {z.cashVariance === 0 ? '—' : z.cashVariance < 0 ? `(${money(-z.cashVariance)})` : money(z.cashVariance)}
                    </td>
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

export function ZReportPage() {
  const { id = '' } = useParams();
  const z = useAsync(() => api.zReport(id), [id]);
  if (z.error !== undefined) return <ErrorNote error={z.error} />;
  const d = z.data;
  if (d === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const vr = (v: number) => (v === 0 ? '—' : v < 0 ? `(${money(-v)})` : money(v));
  return (
    <div className="space-y-4">
      <CashTabs />
      <div className="text-ink-400 no-print text-[12px]">
        <Link to="/day-close" className="hover:text-ink-700 hover:underline">
          End of day
        </Link>{' '}
        / {d.closeNo}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Z report <span className="font-mono" data-testid="z-no">{d.closeNo}</span>
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            {d.branchName} · day of {shortDate(d.businessDay)} · closed {shortDateTime(d.periodTo)} by {d.closedByName}
          </p>
          <p className="text-ink-400 text-[12px]">
            {d.periodFrom === null ? 'From the branch’s first sale' : `Since ${shortDateTime(d.periodFrom)}`}
            {d.detail.previousClose !== null && (
              <>
                {' '}
                (after{' '}
                <Link to={`/day-close/${d.detail.previousClose.id}`} className="hover:text-accent-700 font-mono hover:underline">
                  {d.detail.previousClose.closeNo}
                </Link>
                )
              </>
            )}
            {d.note !== null && ` · ${d.note}`}
          </p>
        </div>
        <Button onClick={() => window.print()} className="no-print">
          Print
        </Button>
      </div>
      <Card className="px-4 py-4">
        <Figures f={d.detail.figures} />
      </Card>
      <Card className="overflow-hidden">
        <div className="border-ink-100 border-b px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Cash in the tills</h2>
        </div>
        {d.detail.tills.length === 0 ? (
          <p className="text-ink-400 px-4 py-4 text-[12.5px]">No tills at this branch.</p>
        ) : (
          <table className="w-full text-[12.5px]" data-testid="z-tills">
            <thead>
              <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Till</th>
                <th className="px-2 py-2 text-right font-medium">Expected</th>
                <th className="px-2 py-2 text-right font-medium">Counted</th>
                <th className="px-4 py-2 text-right font-medium">Over / (short)</th>
              </tr>
            </thead>
            <tbody className="divide-ink-100 divide-y">
              {d.detail.tills.map((t, i) => (
                <tr key={t.id}>
                  <td className="px-4 py-1.5 font-medium">{tillName(d.detail.tills, i)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{money(t.expected)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{money(t.counted)}</td>
                  <td className={`tnum px-4 py-1.5 text-right ${t.variance < 0 ? 'font-medium text-red-700' : ''}`}>{vr(t.variance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-ink-200 border-t font-semibold">
                <td className="px-4 py-2">Total</td>
                <td className="tnum px-2 py-2 text-right">{money(d.cashExpected)}</td>
                <td className="tnum px-2 py-2 text-right">{money(d.cashCounted)}</td>
                <td className={`tnum px-4 py-2 text-right ${d.cashVariance < 0 ? 'text-red-700' : ''}`} data-testid="z-variance">{vr(d.cashVariance)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>
      {d.detail.exceptions.length > 0 && (
        <Card className="px-4 py-3">
          <div className="text-ink-500 mb-1 text-[11px] font-medium uppercase tracking-wider">Raised for review during this period</div>
          <div className="flex flex-wrap gap-2">
            {d.detail.exceptions.map((e) => (
              <Badge key={e.kind} tone="warn">
                {(EXCEPTION_LABEL as Record<string, string>)[e.kind] ?? e.kind} · {e.count}
              </Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
