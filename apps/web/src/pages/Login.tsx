/**
 * Sign in, and the forced password change that follows a seeded or reset
 * credential.
 *
 * There is no "create account" link, deliberately. Accounts are issued by an
 * administrator; a back office holding twelve branches' stock valuations is
 * not something anyone should be able to join.
 */

import { useState } from 'react';

import { ApiError, api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Spinner } from '../lib/ui.js';

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Sign in"
      subtitle="Multi-branch retail operations"
      footer="Accounts are issued by your administrator."
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email">
          <input
            type="email"
            required
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
          />
        </Field>

        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="w-full py-2">
          {busy ? <Spinner /> : null}
          Sign in
        </Button>
      </form>
    </Shell>
  );
}

/**
 * Shown when `mustChangePassword` is set. The API refuses every other route
 * until this is done, so this is a wall rather than a prompt.
 */
export function ChangePassword() {
  const { user, refresh, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Choose a new password"
      subtitle={`Signed in as ${user?.email ?? ''}`}
      footer="Your temporary password cannot be used again once this is done."
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Temporary password">
          <input
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
          />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-2 text-[13px] outline-none"
          />
        </Field>

        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="w-full py-2">
          {busy ? <Spinner /> : null}
          Set password and continue
        </Button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-ink-400 hover:text-ink-700 w-full text-center text-[12px]"
        >
          Sign out instead
        </button>
      </form>
    </Shell>
  );
}

function Shell({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-ink-100 flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="bg-accent-600 grid size-8 place-items-center rounded-lg">
            <svg viewBox="0 0 24 24" className="size-4.5 text-white" aria-hidden="true">
              <path fill="currentColor" d="M4 7h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm12-4h4v2h-4z" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">Retail Operations</div>
            <div className="text-ink-400 text-[11px]">{subtitle}</div>
          </div>
        </div>

        <div className="border-ink-200/80 rounded-xl border bg-white p-5 shadow-[0_1px_3px_rgba(16,24,40,0.06)]">
          <h1 className="mb-4 text-[14px] font-semibold tracking-tight">{title}</h1>
          {children}
        </div>

        <p className="text-ink-400 mt-4 text-center text-[11.5px]">{footer}</p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="text-ink-400 mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}
