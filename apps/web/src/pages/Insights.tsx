/**
 * Insights: what the records say needs attention, most serious first, each with
 * the figure behind it, named examples and a button to where it is dealt with.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Insight } from '../lib/api.js';
import { useMyBranches } from '../lib/myBranches.js';
import { Card, Empty, ErrorNote, Spinner, useAsync } from '../lib/ui.js';

const TONE: Record<Insight['severity'], { bar: string; chip: string; word: string }> = {
  high: { bar: 'bg-red-500', chip: 'bg-red-50 text-red-700', word: 'Act now' },
  medium: { bar: 'bg-amber-400', chip: 'bg-amber-50 text-amber-800', word: 'Worth a look' },
  low: { bar: 'bg-ink-300', chip: 'bg-ink-50 text-ink-600', word: 'Tidy up' },
};

export function Insights() {
  const branches = useMyBranches();
  const [branchId, setBranchId] = useState('');
  const data = useAsync(() => api.insights(branchId === '' ? {} : { branchId }), [branchId]);
  const list = data.data?.insights ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Insights</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            What your own records say needs attention - prices, stock, cash and controls - most serious first. Each is a plain rule over the ledgers,
            with the figures behind it and a button to where it is fixed.
          </p>
        </div>
        {branches.list.length > 1 && (
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            aria-label="Branch"
            className="border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            <option value="">All my branches</option>
            {branches.list.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {data.error !== undefined && <ErrorNote error={data.error} />}
      {data.loading ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <Card className="px-4 py-10">
          <Empty title="Nothing needs attention" hint="No prices below cost, nothing selling out, no losses or shortages, no stale exceptions." />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((i) => {
            const t = TONE[i.severity];
            return (
              <Card key={i.id} className="relative flex flex-col overflow-hidden px-4 py-3.5 pl-5" data-testid={`insight-${i.id}`}>
                <span className={`absolute inset-y-0 left-0 w-1 ${t.bar}`} aria-hidden="true" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${t.chip}`}>{t.word}</span>
                  <span className="text-ink-400 text-[11px] uppercase tracking-wider">{i.area}</span>
                </div>
                <h2 className="mt-1.5 text-[14.5px] font-semibold leading-snug">{i.title}</h2>
                <p className="text-ink-600 mt-1 text-[12.5px]">{i.why}</p>
                {i.examples.length > 0 && (
                  <ul className="text-ink-700 mt-2 space-y-0.5 text-[12px]">
                    {i.examples.map((e) => (
                      <li key={e} className="truncate">
                        · {e}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto pt-3">
                  <Link to={i.action.to} className="text-accent-700 text-[12.5px] font-medium hover:underline">
                    {i.action.label} →
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
