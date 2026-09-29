/**
 * Not moving: stock sitting at a branch that is not selling there, the money
 * tied up in it, and where it IS selling - with a transfer one click away.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type NotMovingItem } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useMyBranches } from '../lib/myBranches.js';
import { Badge, Button, Card, Empty, ErrorNote, money, qty, Spinner, timeAgo, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';

export function NotMoving() {
  const nav = useNavigate();
  const { can } = useAuth();
  const branches = useMyBranches();
  const [branchId, setBranchId] = useState('');
  const [days, setDays] = useState(60);

  useEffect(() => {
    if (branchId === '' && branches.list.length === 1 && branches.list[0] !== undefined) setBranchId(branches.list[0].id);
  }, [branches.list, branchId]);

  const data = useAsync(() => (branchId === '' ? Promise.resolve(null) : api.notMoving({ branchId, days })), [branchId, days]);
  const items = data.data?.items ?? [];
  const notSelling = items.filter((i) => i.status === 'not-selling');

  function transfer(i: NotMovingItem) {
    const pack = i.packs.find((k) => k.qtyBase === 1) ?? i.packs[0];
    if (i.sellsAt === null || pack === undefined) return;
    nav('/transfers', {
      state: {
        transfer: {
          originBranchId: branchId,
          destinationBranchId: i.sellsAt.branchId,
          notes: `Not selling here; sells at ${i.sellsAt.name}`,
          lines: [{ productId: i.productId, productName: i.name, sku: i.sku, baseUom: i.baseUom, packId: pack.id, packs: i.packs, qtyPacks: String(Math.max(1, Math.floor(i.sellsAt.suggestQty / pack.qtyBase))) }],
        },
      },
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Not moving</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Stock sitting at a branch that is not selling there, and the money tied up in it. Where another branch is selling the same item, move it
          there before ordering more for them - or reprice it, or stop buying it.
        </p>
      </div>

      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field} aria-label="Branch">
              <option value="">Select a branch…</option>
              {branches.list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Nothing sold in the last</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={field} aria-label="Period">
              {[30, 60, 90, 180].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {data.error !== undefined && <ErrorNote error={data.error} />}
      {branchId === '' ? (
        <Card className="px-4 py-10">
          <Empty title="Choose a branch" hint="Pick the branch to look at." />
        </Card>
      ) : data.loading ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card className="px-4 py-10">
          <Empty title="Everything is moving" hint={`Every item in stock here sold in the last ${days} days at a healthy pace.`} />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-testid="not-moving-summary">
            <Card className="px-4 py-3">
              <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">Money tied up</div>
              <div className="tnum mt-1 text-lg font-semibold">{money(data.data?.totalValue ?? 0)}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">Not selling at all</div>
              <div className="tnum mt-1 text-lg font-semibold">{notSelling.length}</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-ink-400 text-[10.5px] font-medium uppercase tracking-wider">Selling at another branch</div>
              <div className="tnum mt-1 text-lg font-semibold">{items.filter((i) => i.sellsAt !== null).length}</div>
            </Card>
          </div>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-ink-400 border-ink-100 border-b text-left text-[10.5px] uppercase tracking-wider">
                    <th className="px-4 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 text-right font-medium">On hand</th>
                    <th className="px-2 py-2 text-right font-medium">Tied up</th>
                    <th className="px-2 py-2 font-medium">Last sold here</th>
                    <th className="px-4 py-2 font-medium">Sells at</th>
                  </tr>
                </thead>
                <tbody className="divide-ink-100 divide-y">
                  {items.map((i) => (
                    <tr key={i.productId} data-testid="not-moving-line">
                      <td className="px-4 py-2">
                        <div className="font-medium">{i.name}</div>
                        <div className="text-ink-400 flex items-center gap-1.5 font-mono text-[11px]">
                          {i.sku}
                          {i.status === 'not-selling' ? <Badge tone="bad">not selling</Badge> : <Badge tone="warn">slow · {qty(i.daysOfCover ?? 0)} days of stock</Badge>}
                        </div>
                      </td>
                      <td className="tnum px-2 py-2 text-right">
                        {qty(i.onHand)} <span className="text-ink-400 text-[11px]">{i.baseUom}</span>
                      </td>
                      <td className="tnum px-2 py-2 text-right">{i.value === null ? <span className="text-ink-400 text-[11px]">no cost</span> : money(i.value)}</td>
                      <td className="text-ink-600 px-2 py-2">{i.lastSold === null ? 'never' : timeAgo(i.lastSold)}</td>
                      <td className="px-4 py-2">
                        {i.sellsAt === null ? (
                          <span className="text-ink-400 text-[12px]">nowhere else either</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px]">
                              <b>{i.sellsAt.name}</b> · {qty(i.sellsAt.perDayThere)} a day, holds {qty(i.sellsAt.stockThere)}
                            </span>
                            {can('transfer.dispatch') && i.sellsAt.suggestQty > 0 && (
                              <Button onClick={() => transfer(i)}>Move {qty(i.sellsAt.suggestQty)} there</Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="text-ink-500 text-[12px]">
            <b>Not selling</b>: in stock here, nothing sold in the last {days} days. <b>Slow</b>: sold, but at that pace the stock here lasts more than{' '}
            {data.data?.slowDays ?? 180} days. <b>Move</b> suggests what the other branch would sell over the same period, less what it already holds.
          </p>
        </>
      )}
    </div>
  );
}
