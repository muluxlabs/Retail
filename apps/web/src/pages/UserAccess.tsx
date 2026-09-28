/**
 * One person's access.
 *
 * Their roles give the usual set for their job. Here an administrator can add
 * a permission for just this person, or take away one their role gives. It
 * takes effect on their next click, it is audited, and anything added beyond
 * a role goes to the exception queue for review.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError, type UserAccess } from '../lib/api.js';
import { AREAS, PERMISSION_INFO, ROLE_LABEL } from '../lib/access.js';
import { useAuth } from '../lib/auth.js';
import { shortDateTime } from '../lib/buying.js';
import { Badge, Button, Card, ErrorNote, Spinner, useAsync } from '../lib/ui.js';

type Perm = UserAccess['permissions'][number];

export function UserAccessPage() {
  const { id = '' } = useParams();
  const { can, user: me } = useAuth();
  const d = useAsync(() => api.userAccess(id), [id]);
  const [asking, setAsking] = useState<{ perm: Perm; effect: 'grant' | 'revoke' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'has' | 'changed'>('all');

  if (d.error !== undefined) return <ErrorNote error={d.error} />;
  const a = d.data;
  if (a === undefined) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  const isMe = me?.personId === a.person.id;
  const mayEdit = can('user.manage') && !isMe;
  const byId = new Map(a.permissions.map((p) => [p.id, p]));
  const known = new Set(AREAS.flatMap((x) => x.permissions));
  const areas = [...AREAS, { name: 'Other', permissions: a.permissions.map((p) => p.id).filter((p) => !known.has(p)) }].filter((x) => x.permissions.length > 0);
  const changed = a.permissions.filter((p) => p.override !== null);

  async function set(perm: Perm, effect: 'grant' | 'revoke' | 'role', why: string | null) {
    setBusy(true);
    setError(null);
    try {
      await api.setUserAccess(a!.person.id, perm.id, { effect, note: why });
      setAsking(null);
      setNote('');
      d.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const show = (p: Perm) => filter === 'all' || (filter === 'has' ? p.effective : p.override !== null);

  return (
    <div className="space-y-4">
      <div className="text-ink-400 text-[12px]">
        <Link to="/users" className="hover:text-ink-700 hover:underline">
          Staff
        </Link>{' '}
        / {a.person.fullName}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight" data-testid="access-name">
            Access for {a.person.fullName}
          </h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Role:{' '}
            {a.roles.length === 0
              ? 'none'
              : a.roles.map((r) => `${ROLE_LABEL[r.roleId] ?? r.roleId}${r.branchName === null ? ' (group-wide)' : ` at ${r.branchName}`}`).join(', ')}
            . Their role gives the usual access for the job; anything added or removed here is for this person only.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['has', 'What they can do'],
              ['changed', `Set for them (${changed.length})`],
            ] as const
          ).map(([k, t]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${filter === k ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {isMe && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">This is your own account: another administrator must change your access.</div>}
      {error !== null && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">{error}</div>}

      {areas.map((area) => {
        const perms = area.permissions.map((p) => byId.get(p)).filter((p): p is Perm => p !== undefined && show(p));
        if (perms.length === 0) return null;
        return (
          <Card key={area.name} className="overflow-hidden">
            <div className="border-ink-100 border-b px-4 py-2">
              <h2 className="text-[13px] font-semibold tracking-tight">{area.name}</h2>
            </div>
            <ul className="divide-ink-100 divide-y">
              {perms.map((p) => {
                const info = PERMISSION_INFO[p.id];
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" data-testid={`perm-${p.id}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                        <span className={p.effective ? 'font-medium' : 'text-ink-400'}>{info?.label ?? p.description}</span>
                        {info?.sensitive === true && <Badge tone="warn">sensitive</Badge>}
                      </div>
                      <div className="text-ink-400 text-[11.5px]">
                        {info?.opens !== undefined && <>Opens {info.opens} · </>}
                        <span className="font-mono">{p.id}</span>
                      </div>
                      {p.override !== null && (
                        <div className="text-[11.5px] text-amber-800">
                          {p.override.effect === 'grant' ? 'Added' : 'Removed'} by {p.override.setByName}, {shortDateTime(p.override.setAt)}
                          {p.override.note !== null && ` — ${p.override.note}`}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {p.override?.effect === 'grant' ? (
                        <Badge tone="info">Added for them</Badge>
                      ) : p.override?.effect === 'revoke' ? (
                        <Badge tone="bad">Removed for them</Badge>
                      ) : p.fromRoles.length > 0 ? (
                        <Badge tone="good">From role</Badge>
                      ) : (
                        <span className="text-ink-300 text-[12px]">Not given</span>
                      )}
                      {mayEdit &&
                        (p.override !== null ? (
                          <Button onClick={() => void set(p, 'role', null)} disabled={busy}>
                            Back to role
                          </Button>
                        ) : p.effective ? (
                          <Button variant="ghost" onClick={() => { setAsking({ perm: p, effect: 'revoke' }); setNote(''); }} disabled={busy}>
                            Remove
                          </Button>
                        ) : (
                          can(p.id) && (
                            <Button onClick={() => { setAsking({ perm: p, effect: 'grant' }); setNote(''); }} disabled={busy}>
                              Give access
                            </Button>
                          )
                        ))}
                    </div>
                    {asking?.perm.id === p.id && (
                      <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                        <span className="text-[12.5px] text-amber-900">
                          {asking.effect === 'grant' ? 'Give' : 'Remove'} “{info?.label ?? p.description}” {asking.effect === 'grant' ? 'to' : 'from'} {a.person.fullName}?
                        </span>
                        <input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Why (optional, kept with the change)"
                          aria-label="Reason"
                          className="border-ink-200 focus:border-accent-500 min-w-48 flex-1 rounded-lg border bg-white px-2.5 py-1 text-[12.5px] outline-none"
                        />
                        <Button variant="primary" onClick={() => void set(p, asking.effect, note.trim() === '' ? null : note.trim())} disabled={busy}>
                          {busy ? <Spinner /> : null}
                          Yes, {asking.effect === 'grant' ? 'give' : 'remove'}
                        </Button>
                        <Button variant="ghost" onClick={() => setAsking(null)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
