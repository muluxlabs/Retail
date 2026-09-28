/**
 * System settings.
 *
 * Gated end to end on settings.manage - administrator holds it by default
 * (migration 008), same narrow-by-default precedent as Branches. The
 * client's own words: "accessed by the admin only or admin chooses who will
 * have access to them" - the second half is the settings_manager role,
 * assignable from the Staff screen's existing role picker, so an admin can
 * delegate this without handing out full administrator.
 */

import { useState } from 'react';

import { api, ApiError, type SettingRow } from '../lib/api.js';
import { Button, Card, Empty, ErrorNote, Spinner, useAsync } from '../lib/ui.js';

export function Settings() {
  const settings = useAsync(() => api.settings(), []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-ink-500 mt-0.5 text-[12.5px]">
          Operator-adjustable limits. Changing one here takes effect immediately, with no
          redeploy - and is recorded in the audit log against whoever made the change.
        </p>
      </div>

      {settings.error !== undefined && <ErrorNote error={settings.error} />}

      <Card className="overflow-hidden">
        {settings.loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : (settings.data?.length ?? 0) === 0 ? (
          <Empty title="No settings" />
        ) : (
          <ul className="divide-ink-100 divide-y">
            {(settings.data ?? []).map((row) => (
              <SettingItem key={row.key} row={row} onChanged={() => settings.reload()} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SettingItem({ row, onChanged }: { row: SettingRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Numbers (limits) get a small box; text (the business name on receipts) a wide one.
  const isText = !/^[\d.\s-]*$/.test(row.value) || row.value === '';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateSetting(row.key, value);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{row.label}</div>
          {row.description !== null && (
            <p className="text-ink-500 mt-0.5 max-w-xl text-[12px]">{row.description}</p>
          )}
          <div className="text-ink-400 mt-1.5 text-[11px]">
            {row.updatedByName !== null
              ? `Last changed by ${row.updatedByName}`
              : 'Set at deployment, never changed since'}
            {row.updatedAt !== null && <> · {new Date(row.updatedAt).toLocaleString('en-GB')}</>}
          </div>
        </div>

        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={`tnum border-ink-200 focus:border-accent-500 rounded-lg border bg-white px-2.5 py-1.5 text-[13px] outline-none ${isText ? 'w-64 max-w-full' : 'w-28'}`}
            />
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner /> : null}
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue(row.value);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            {row.value === '' ? (
              <span className="text-ink-400 text-[13px] italic">blank</span>
            ) : (
              <span className={`tnum font-semibold ${isText ? 'max-w-64 truncate text-[13px]' : 'text-[15px]'}`}>{row.value}</span>
            )}
            <Button onClick={() => setEditing(true)}>Edit</Button>
          </div>
        )}
      </div>
      {error !== null && <div className="mt-2 text-[12px] text-red-600">{error}</div>}
    </li>
  );
}
