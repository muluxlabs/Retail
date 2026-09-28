/**
 * Export records: every list that can be downloaded, in one place.
 */

import { useState } from 'react';

import { canExport } from '../components/ExportButton.js';
import { ApiError, type ExportKind } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { downloadExport, EXPORTS } from '../lib/exports.js';
import { Button, Card } from '../lib/ui.js';

export function Exports() {
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const mine = EXPORTS.filter((e) => canExport(can, e.kind));

  async function go(kind: ExportKind, format: 'xlsx' | 'csv') {
    setBusy(`${kind}-${format}`);
    setError(null);
    try {
      const rows = await downloadExport(kind, format);
      setDone((d) => ({ ...d, [kind]: `Downloaded ${rows} row${rows === 1 ? '' : 's'} as ${format === 'xlsx' ? 'Excel' : 'CSV'}.` }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Export records</h1>
        <p className="text-ink-500 mt-0.5 max-w-3xl text-[12.5px]">
          Download a whole list as an Excel or CSV file: for head office, the accountant, or a backup you can open anywhere. Each export is
          recorded in the audit log with who took it and how many rows. Reports have their own download on each report.
        </p>
      </div>
      {error !== null && <p className="text-[12.5px] text-red-600">{error}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {mine.map((e) => (
          <Card key={e.kind} className="flex flex-col px-4 py-3.5" data-testid={`export-card-${e.kind}`}>
            <h2 className="text-[14px] font-semibold">{e.label}</h2>
            <p className="text-ink-500 mt-1 flex-1 text-[12.5px]">{e.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => void go(e.kind, 'xlsx')}>
                {busy === `${e.kind}-xlsx` ? 'Preparing…' : 'Excel (.xlsx)'}
              </Button>
              <Button disabled={busy !== null} onClick={() => void go(e.kind, 'csv')}>
                {busy === `${e.kind}-csv` ? 'Preparing…' : 'CSV'}
              </Button>
              {done[e.kind] !== undefined && <span className="text-accent-700 text-[12px]">{done[e.kind]}</span>}
            </div>
          </Card>
        ))}
      </div>
      {mine.length === 0 && <p className="text-ink-500 text-[12.5px]">There is nothing you may export.</p>}
    </div>
  );
}
