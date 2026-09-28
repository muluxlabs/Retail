/**
 * The audit log: who changed what, when, and from what to what.
 *
 * The exception queue is a to-do list of unusual events that need a decision.
 * This is the complete history: every change to how the business is set up,
 * and every sign-in. Nothing here can be edited or deleted; it only grows.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ControlsTabs } from '../components/ControlsTabs.js';
import { api, type AuditEntry } from '../lib/api.js';
import { AUDIT_GROUPS, AUDIT_SENSITIVE, auditChanges, auditLabel, auditLink, humanKey } from '../lib/audit.js';
import { shortDateTime } from '../lib/buying.js';
import { downloadCsv } from '../lib/csv.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, useAsync } from '../lib/ui.js';

const field = 'border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none';
const label = 'text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider';
const PAGE = 100;

export function Audit() {
  const [params] = useSearchParams();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [group, setGroup] = useState('');
  const [actorId, setActorId] = useState(params.get('actorId') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const entityType = params.get('entityType') ?? undefined;
  const entityId = params.get('entityId') ?? undefined;

  const facets = useAsync(() => api.auditFacets(), []);
  const actions = group === '' ? undefined : (AUDIT_GROUPS.find((g) => g.name === group)?.actions ?? []).join(',');
  const log = useAsync(
    () =>
      api.audit({
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
        ...(actions === undefined ? {} : { actions }),
        ...(actorId === '' ? {} : { actorId }),
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        ...(entityType === undefined ? {} : { entityType }),
        ...(entityId === undefined ? {} : { entityId }),
        limit: PAGE,
        offset: page * PAGE,
      }),
    [from, to, actions, actorId, q, entityType, entityId, page],
  );
  const rows = log.data?.items ?? [];
  const total = log.data?.total ?? 0;
  const reset = () => setPage(0);

  function exportCsv() {
    downloadCsv(
      'audit-log.csv',
      ['When', 'Who', 'What', 'Record', 'Branch', 'Changes'],
      rows.map((r) => [
        r.at,
        r.actorName ?? '',
        auditLabel(r.action),
        r.entityName ?? r.entityType ?? '',
        r.branchName ?? '',
        auditChanges(r.before, r.after).map((c) => `${humanKey(c.key)}: ${c.from ?? ''} -> ${c.to ?? ''}`).join('; '),
      ]),
    );
  }

  return (
    <div className="space-y-4">
      <ControlsTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Audit log</h1>
          <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
            Every change to how the business is set up — prices, items, staff and access, suppliers, customers, settings — and every sign-in, with who
            made it, when, and the value before and after. It only ever grows: nothing here can be edited or deleted.
          </p>
        </div>
        <Button onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </Button>
      </div>

      {entityId !== undefined && (
        <div className="border-accent-300/60 bg-accent-50 flex items-center justify-between rounded-lg border px-3 py-2 text-[12.5px]">
          <span>Showing the history of one record.</span>
          <Link to="/audit" className="text-accent-700 font-medium hover:underline">
            Show everything
          </Link>
        </div>
      )}

      <Card className="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block">
          <span className={label}>From</span>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} className={field} aria-label="From" />
        </label>
        <label className="block">
          <span className={label}>Until</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} className={field} aria-label="Until" />
        </label>
        <label className="block">
          <span className={label}>Kind of change</span>
          <select value={group} onChange={(e) => { setGroup(e.target.value); reset(); }} className={field} aria-label="Kind of change">
            <option value="">Everything</option>
            {AUDIT_GROUPS.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Who</span>
          <select value={actorId} onChange={(e) => { setActorId(e.target.value); reset(); }} className={field} aria-label="Who">
            <option value="">Anyone</option>
            {(facets.data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Search</span>
          <input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="A name, a value, a reason…" className={field} aria-label="Search the audit log" />
        </label>
      </Card>

      {log.error !== undefined && <ErrorNote error={log.error} />}
      <Card className="overflow-hidden">
        {log.loading && log.data === undefined ? (
          <div className="grid place-items-center py-12">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="Nothing recorded for these filters" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" data-testid="audit-list">
              <thead>
                <tr className="text-ink-500 border-ink-100 border-b text-left text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Who</th>
                  <th className="px-2 py-2 font-medium">What</th>
                  <th className="px-2 py-2 font-medium">Changes</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {rows.map((r) => (
                  <Row key={r.seq} r={r} open={open === r.seq} onToggle={() => setOpen(open === r.seq ? null : r.seq)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE && (
          <div className="border-ink-100 flex items-center justify-between border-t px-4 py-2 text-[12.5px]">
            <span className="text-ink-500">
              {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
                Newer
              </Button>
              <Button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE >= total}>
                Older
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ r, open, onToggle }: { r: AuditEntry; open: boolean; onToggle: () => void }) {
  const changes = auditChanges(r.before, r.after);
  const link = auditLink(r.entityType, r.entityId, r.after);
  const late = new Date(r.recordedAt).getTime() - new Date(r.at).getTime() > 10 * 60 * 1000;
  return (
    <tr className="align-top" data-testid="audit-row">
      <td className="px-4 py-2 whitespace-nowrap">
        {shortDateTime(r.at)}
        {late && <div className="text-[11px] text-amber-700">recorded {shortDateTime(r.recordedAt)}</div>}
      </td>
      <td className="px-2 py-2">
        <div className="font-medium">{r.actorName ?? '—'}</div>
        {r.branchName !== null && <div className="text-ink-400 text-[11px]">{r.branchName}</div>}
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{auditLabel(r.action)}</span>
          {AUDIT_SENSITIVE.has(r.action) && <Badge tone="warn">review</Badge>}
        </div>
        {(r.entityName !== null || link !== null) && (
          <div className="text-ink-500 text-[11.5px]">
            {link !== null ? (
              <Link to={link} className="hover:text-accent-700 hover:underline">
                {r.entityName ?? 'Open'}
              </Link>
            ) : (
              r.entityName
            )}
          </div>
        )}
      </td>
      <td className="px-2 py-2">
        {changes.length === 0 ? (
          <span className="text-ink-300">—</span>
        ) : (
          <ul className="space-y-0.5">
            {(open ? changes : changes.slice(0, 3)).map((c) => (
              <li key={c.key} className="text-[12px]">
                <span className="text-ink-500">{humanKey(c.key)}:</span>{' '}
                {c.from !== null && c.to !== null ? (
                  <>
                    <span className="text-ink-400 line-through decoration-1">{c.from}</span> → <span className="font-medium">{c.to}</span>
                  </>
                ) : (
                  <span className="font-medium">{c.to ?? c.from}</span>
                )}
              </li>
            ))}
            {changes.length > 3 && (
              <li>
                <button onClick={onToggle} className="text-accent-700 text-[11.5px] hover:underline">
                  {open ? 'Show less' : `${changes.length - 3} more`}
                </button>
              </li>
            )}
          </ul>
        )}
      </td>
    </tr>
  );
}
