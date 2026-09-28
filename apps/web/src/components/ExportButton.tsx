/**
 * "Export" on a record screen: Excel or CSV of the whole list. Shown only to
 * someone who may export records AND see this data.
 */

import { useState } from 'react';

import { ApiError, type ExportKind } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { downloadExport, EXPORTS } from '../lib/exports.js';
import { Button } from '../lib/ui.js';

export function canExport(can: (p: string) => boolean, kind: ExportKind): boolean {
  const info = EXPORTS.find((e) => e.kind === kind)!;
  return can('data.export') && can(info.needs);
}

export function ExportButton({ kind }: { kind: ExportKind }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canExport(can, kind)) return null;

  async function go(format: 'xlsx' | 'csv') {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(kind, format);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={`export-${kind}`}>
        {busy ? 'Preparing…' : 'Export'}
      </Button>
      {open && (
        <div className="ring-ink-200 absolute right-0 z-20 mt-1 w-52 rounded-lg bg-white p-1 shadow-lg ring-1">
          <button type="button" disabled={busy} onClick={() => void go('xlsx')} className="hover:bg-ink-50 block w-full rounded-md px-3 py-2 text-left text-[12.5px]">
            Excel (.xlsx)
          </button>
          <button type="button" disabled={busy} onClick={() => void go('csv')} className="hover:bg-ink-50 block w-full rounded-md px-3 py-2 text-left text-[12.5px]">
            CSV
          </button>
          <p className="text-ink-400 border-ink-100 mt-1 border-t px-3 py-1.5 text-[11px]">Every export is recorded in the audit log.</p>
        </div>
      )}
      {error !== null && <p className="absolute right-0 mt-1 w-64 text-right text-[11.5px] text-red-600">{error}</p>}
    </div>
  );
}
