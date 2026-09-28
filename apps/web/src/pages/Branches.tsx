/**
 * Branch management.
 *
 * Gated end to end on branch.manage, granted to administrator only
 * (migration 006) - the client's own words were "not everybody should be
 * able to make changes for the branch."
 *
 * The cap on active branches is enforced by the API, not by this screen:
 * disabling the "Add branch" button here is a courtesy once the limit shows
 * as reached, but the refusal that actually matters is the 409 the server
 * sends regardless of what this page does.
 */

import { useState } from 'react';

import { api, ApiError, type Branch } from '../lib/api.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, useAsync } from '../lib/ui.js';

export function Branches() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);

  const branches = useAsync(() => api.branches({ includeInactive }), [includeInactive]);
  const capacity = useAsync(() => api.branchCapacity(), []);

  const atLimit = capacity.data !== undefined && capacity.data.activeCount >= capacity.data.limit;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Branches</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Every stock, sale, transfer and cash position is scoped to a branch. Adding one here
            makes it usable everywhere immediately.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {capacity.data !== undefined && (
            <div className="text-right">
              <div
                className={`tnum text-[13px] font-semibold ${atLimit ? 'text-amber-700' : 'text-ink-900'}`}
              >
                {capacity.data.activeCount} / {capacity.data.limit}
              </div>
              <div className="text-ink-400 text-[10.5px]">active branches</div>
            </div>
          )}
          <Button variant="primary" onClick={() => setCreating((v) => !v)} disabled={atLimit && !creating}>
            {creating ? 'Cancel' : 'Add branch'}
          </Button>
        </div>
      </div>

      {atLimit && !creating && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
          This deployment is licensed for {capacity.data?.limit} active branches and is at that
          limit. Contact the developer to raise it before adding another.
        </div>
      )}

      {creating && (
        <CreateForm
          onCreated={() => {
            setCreating(false);
            branches.reload();
            capacity.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
          className="accent-accent-600 size-3.5"
        />
        Show inactive branches
      </label>

      {branches.error !== undefined && <ErrorNote error={branches.error} />}

      <Card className="overflow-hidden">
        {branches.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : (branches.data?.length ?? 0) === 0 ? (
          <Empty title="No branches" />
        ) : (
          <ul className="divide-ink-100 divide-y">
            {(branches.data ?? []).map((b) => (
              <Row
                key={b.id}
                branch={b}
                onChanged={() => {
                  branches.reload();
                  capacity.reload();
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Row({ branch, onChanged }: { branch: Branch; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(branch.code);
  const [name, setName] = useState(branch.name);
  const [kind, setKind] = useState(branch.kind);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateBranch(branch.id, { code, name, kind });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      await api.updateBranch(branch.id, { isActive: !branch.isActive });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[12.5px]">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="border-ink-200 w-24 rounded border px-2 py-1 font-mono text-[12px] outline-none"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border-ink-200 min-w-40 flex-1 rounded border px-2 py-1 outline-none"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Branch['kind'])}
          className="border-ink-200 rounded border px-2 py-1 text-[12px] outline-none"
        >
          <option value="store">Store</option>
          <option value="warehouse">Warehouse</option>
        </select>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : null}
          Save
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {error !== null && <span className="w-full text-[11px] text-red-600">{error}</span>}
      </li>
    );
  }

  return (
    <li className={`flex items-center gap-3 px-4 py-2.5 ${branch.isActive ? '' : 'bg-ink-50/40 opacity-60'}`}>
      <span className="text-ink-400 w-20 shrink-0 font-mono text-[11.5px]">{branch.code}</span>
      <span className="min-w-0 flex-1 text-[13px] font-medium">{branch.name}</span>
      <Badge tone={branch.kind === 'warehouse' ? 'info' : 'neutral'}>{branch.kind}</Badge>
      {!branch.isActive && <Badge tone="neutral">inactive</Badge>}
      {error !== null && <span className="text-[11px] text-red-600">{error}</span>}
      <div className="ml-auto flex items-center gap-1.5">
        <Button onClick={() => setEditing(true)}>Edit</Button>
        <Button
          variant={branch.isActive ? 'ghost' : 'secondary'}
          onClick={() => void toggleActive()}
          disabled={busy}
        >
          {branch.isActive ? 'Deactivate' : 'Reactivate'}
        </Button>
      </div>
    </li>
  );
}

function CreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'store' | 'warehouse'>('store');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createBranch({ code, name, kind });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Code</span>
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="NEWTOWN"
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Newtown Supermarket"
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            <option value="store">Store</option>
            <option value="warehouse">Warehouse</option>
          </select>
        </label>
        <div className="flex items-end">
          <Button type="submit" variant="primary" disabled={busy} className="w-full py-1.5">
            {busy ? <Spinner /> : null}
            Create branch
          </Button>
        </div>
        {error !== null && (
          <div className="text-[12px] text-red-600 sm:col-span-2 lg:col-span-4">{error}</div>
        )}
      </form>
    </Card>
  );
}
