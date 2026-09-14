/**
 * Staff accounts.
 *
 * This is the screen an administrator uses instead of a public sign-up page.
 * A created account returns its temporary password exactly once; the server
 * only ever stores a scrypt hash, so if it is lost the account must be reset
 * rather than recovered. The UI says so plainly rather than pretending
 * otherwise.
 */

import { useState } from 'react';

import { api, ApiError, type Branch, type UserRow } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, timeAgo, useAsync } from '../lib/ui.js';

const ROLE_LABEL: Record<string, string> = {
  cashier: 'Cashier',
  supervisor: 'Shift Supervisor',
  receiver: 'Goods Receiver',
  stock_controller: 'Stock Controller',
  branch_manager: 'Branch Manager',
  auditor: 'Auditor',
  finance: 'Finance',
  administrator: 'Administrator',
};

export function Users() {
  const { can, user: me } = useAuth();
  const users = useAsync(() => api.users(), []);
  const branches = useAsync(() => api.branches(), []);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Staff accounts</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            One person, one record. Roles grant named capabilities, not a rank.
          </p>
        </div>
        {can('user.manage') && (
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : 'Add person'}
          </Button>
        )}
      </div>

      {issued !== null && (
        <Card className="border-accent-300 bg-accent-50/60 px-4 py-3.5">
          <div className="text-accent-900 text-[13px] font-semibold">
            Account created for {issued.email}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="border-accent-300 rounded-md border bg-white px-2.5 py-1 font-mono text-[13px]">
              {issued.password}
            </code>
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(issued.password);
              }}
            >
              Copy
            </Button>
            <Button variant="ghost" onClick={() => setIssued(null)}>
              Dismiss
            </Button>
          </div>
          <p className="text-accent-900/70 mt-2 text-[11.5px]">
            Shown once and never recoverable — only a hash is stored. They must change it at first
            sign-in.
          </p>
        </Card>
      )}

      {creating && (
        <CreateForm
          branches={branches.data ?? []}
          onCreated={(result) => {
            setCreating(false);
            if (result.temporaryPassword !== undefined) {
              setIssued({ email: result.email, password: result.temporaryPassword });
            }
            users.reload();
          }}
        />
      )}

      {users.error !== undefined && <ErrorNote error={users.error} />}

      <Card className="overflow-hidden">
        {users.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : (users.data ?? []).length === 0 ? (
          <Empty title="No staff yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-ink-100 text-ink-400 border-b text-[10.5px] uppercase tracking-wider">
                  <th className="px-4 py-2 text-left font-medium">Person</th>
                  <th className="px-3 py-2 text-left font-medium">Roles</th>
                  <th className="px-3 py-2 text-left font-medium">Sign-in</th>
                  <th className="px-3 py-2 text-left font-medium">Last seen</th>
                  <th className="px-4 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-ink-100 divide-y">
                {(users.data ?? []).map((u) => (
                  <Row key={u.id} user={u} isMe={u.id === me?.personId} onChange={() => users.reload()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ user, isMe, onChange }: { user: UserRow; isMe: boolean; onChange: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<string | null>(null);

  async function resetPassword() {
    setBusy(true);
    try {
      const result = await api.resetPassword(user.id);
      setReset(result.temporaryPassword);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await api.updateUser(user.id, { isActive: !user.isActive });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={user.isActive ? 'hover:bg-ink-50/60' : 'bg-ink-50/40 opacity-60'}>
      <td className="px-4 py-2">
        <div className="font-medium">
          {user.fullName}
          {isMe && <span className="text-ink-400 font-normal"> (you)</span>}
        </div>
        <div className="text-ink-400 text-[11px]">{user.loginEmail ?? user.phone ?? '—'}</div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0 ? (
            <span className="text-ink-300">—</span>
          ) : (
            user.roles.map((r, i) => (
              <Badge key={`${r.roleId}-${i}`} tone="neutral">
                {ROLE_LABEL[r.roleId] ?? r.roleId}
                {r.branchCode !== null && ` · ${r.branchCode}`}
              </Badge>
            ))
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        {!user.canSignIn ? (
          <span className="text-ink-400 text-[11.5px]">no login</span>
        ) : reset !== null ? (
          <code className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11.5px] text-amber-900">
            {reset}
          </code>
        ) : user.mustChangePassword ? (
          <Badge tone="warn">must change</Badge>
        ) : (
          <Badge tone="good">active</Badge>
        )}
      </td>
      <td className="text-ink-500 px-3 py-2 text-[11.5px]">
        {user.lastLoginAt === null ? 'never' : timeAgo(user.lastLoginAt)}
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {can('user.manage') && user.canSignIn && (
            <Button onClick={() => void resetPassword()} disabled={busy}>
              Reset password
            </Button>
          )}
          {can('user.manage') && !isMe && (
            <Button variant={user.isActive ? 'ghost' : 'secondary'} onClick={() => void toggleActive()} disabled={busy}>
              {user.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateForm({
  branches,
  onCreated,
}: {
  branches: Branch[];
  onCreated: (r: { email: string; temporaryPassword?: string }) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('cashier');
  const [branchId, setBranchId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createUser({
        fullName,
        email,
        roleIds: [roleId],
        branchId: branchId === '' ? null : branchId,
      });
      onCreated(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-4 py-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Full name
          </span>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Email
          </span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
        </label>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Role
          </span>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            {Object.entries(ROLE_LABEL).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Branch
          </span>
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          >
            <option value="">Group-wide</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <Button type="submit" variant="primary" disabled={busy} className="w-full py-1.5">
            {busy ? <Spinner /> : null}
            Create account
          </Button>
        </div>
        {error !== null && (
          <div className="text-[12px] text-red-600 sm:col-span-2 lg:col-span-5">{error}</div>
        )}
      </form>
    </Card>
  );
}
