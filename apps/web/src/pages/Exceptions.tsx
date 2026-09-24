/**
 * The exception queue.
 *
 * HANDOFF calls this the client's differentiator and says not to build it as
 * a table dump, so it is built as a work surface: a list you triage on the
 * left, the item you are deciding about on the right.
 *
 * The design follows AD-4. Clearing is the only way an item leaves the queue,
 * and it demands a named person and a note - which is why the clear control
 * is a small form rather than a button. The previous system had "Suspicious
 * reports" that nobody read; the difference is that a work item has an owner.
 */

import { useState } from 'react';

import { api, ApiError, type ExceptionRow, type ExceptionState, type Product } from '../lib/api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  EXCEPTION_LABEL,
  EXCEPTION_WHY,
  money,
  Spinner,
  timeAgo,
  useAsync,
} from '../lib/ui.js';

const STATE_TABS: { value: ExceptionState | 'all'; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'all', label: 'All' },
];

/** Money lost or at risk reads red; money found reads neutral, never green. */
function impactTone(value: number | null): 'bad' | 'warn' | 'neutral' {
  if (value === null) return 'neutral';
  return value < 0 ? 'bad' : 'warn';
}

export function Exceptions() {
  const [state, setState] = useState<ExceptionState | 'all'>('open');
  const [kind, setKind] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useAsync(
    () =>
      api.exceptions({
        ...(state === 'all' ? {} : { state }),
        ...(kind === '' ? {} : { kind }),
        limit: 200,
      }),
    [state, kind],
  );

  const people = useAsync(() => api.people(), []);

  const items = query.data?.items ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? items[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Exception queue</h1>
          <p className="text-ink-500 mt-0.5 text-[12.5px]">
            Every control in the system lands here as a work item. Clearing one requires a name
            and a reason.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {STATE_TABS.map((tab) => {
            const count = query.data?.byState.find((s) => s.state === tab.value)?.n;
            return (
              <button
                key={tab.value}
                onClick={() => {
                  setState(tab.value);
                  setSelectedId(null);
                }}
                className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition ${
                  state === tab.value
                    ? 'bg-ink-900 text-white'
                    : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800 bg-white'
                }`}
              >
                {tab.label}
                {count !== undefined && tab.value !== 'all' && (
                  <span className={state === tab.value ? 'text-white/60' : 'text-ink-400'}>
                    {' '}
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kind filter, with open counts so the shape of the backlog is visible. */}
      {query.data !== undefined && query.data.byKind.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setKind('')}
            className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 ring-inset transition ${
              kind === ''
                ? 'bg-accent-600 text-white ring-accent-600'
                : 'ring-ink-200 text-ink-600 hover:bg-ink-50 bg-white'
            }`}
          >
            All kinds
          </button>
          {query.data.byKind.map((k) => (
            <button
              key={k.kind}
              onClick={() => setKind(kind === k.kind ? '' : k.kind)}
              className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 ring-inset transition ${
                kind === k.kind
                  ? 'bg-accent-600 text-white ring-accent-600'
                  : 'ring-ink-200 text-ink-600 hover:bg-ink-50 bg-white'
              }`}
            >
              {EXCEPTION_LABEL[k.kind]}{' '}
              <span className={kind === k.kind ? 'text-white/60' : 'text-ink-400'}>{k.n}</span>
            </button>
          ))}
        </div>
      )}

      {query.error !== undefined && <ErrorNote error={query.error} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="overflow-hidden">
          {query.loading ? (
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <Empty
              title="Nothing in this queue"
              hint="Overrides, unlisted scans, backdated entries and count variances appear here the moment they happen."
            />
          ) : (
            <ul className="divide-ink-100 divide-y">
              {items.map((row) => {
                const isSelected = selected?.id === row.id;
                return (
                  <li key={row.id}>
                    <button
                      onClick={() => setSelectedId(row.id)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition ${
                        isSelected ? 'bg-accent-50/60' : 'hover:bg-ink-50/70'
                      }`}
                    >
                      <span
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                          row.state === 'open'
                            ? 'bg-amber-500'
                            : row.state === 'escalated'
                              ? 'bg-red-500'
                              : row.state === 'cleared'
                                ? 'bg-ink-300'
                                : 'bg-blue-400'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[13px] font-medium">
                            {EXCEPTION_LABEL[row.kind]}
                          </span>
                          <Badge tone="neutral">{row.branchCode}</Badge>
                          {row.state !== 'open' && (
                            <Badge tone={row.state === 'escalated' ? 'bad' : 'info'}>
                              {row.state}
                            </Badge>
                          )}
                        </span>
                        <span className="text-ink-500 mt-0.5 block truncate text-xs">
                          {row.productName ?? EXCEPTION_WHY[row.kind]}
                          {row.actorName !== null && <> · {row.actorName}</>}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        {row.valueImpact !== null && (
                          <span
                            className={`tnum block text-[13px] font-semibold ${
                              row.valueImpact < 0 ? 'text-red-600' : 'text-ink-700'
                            }`}
                          >
                            {money(row.valueImpact)}
                          </span>
                        )}
                        <span className="text-ink-400 block text-[11px]">
                          {timeAgo(row.occurredAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="lg:sticky lg:top-20 lg:self-start">
          {selected === undefined ? (
            <Card>
              <Empty title="Select a work item" hint="Pick one from the list to see the detail and clear it." />
            </Card>
          ) : (
            <Detail
              key={selected.id}
              row={selected}
              people={people.data ?? []}
              onDone={() => {
                setSelectedId(null);
                query.reload();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({
  row,
  people,
  onDone,
}: {
  row: ExceptionRow;
  people: { id: string; fullName: string }[];
  onDone: () => void;
}) {
  const [clearedBy, setClearedBy] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isClosed = row.state === 'cleared';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.clearException(row.id, { clearedBy, note });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function mark(state: 'acknowledged' | 'escalated') {
    if (clearedBy === '') {
      setError('Choose who is doing this first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setExceptionState(row.id, { state, actorId: clearedBy });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-ink-100 border-b px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight">
              {EXCEPTION_LABEL[row.kind]}
            </h2>
            <p className="text-ink-500 mt-0.5 text-xs">{EXCEPTION_WHY[row.kind]}</p>
          </div>
          <Badge tone={impactTone(row.valueImpact)}>{row.state}</Badge>
        </div>
      </div>

      <dl className="divide-ink-100 divide-y text-[12.5px]">
        <Row label="Branch">
          {row.branchName} <span className="text-ink-400">({row.branchCode})</span>
        </Row>
        {row.productName !== null && (
          <Row label="Product">
            {row.productName}
            <span className="text-ink-400"> · {row.productSku}</span>
          </Row>
        )}
        <Row label="Raised by">{row.actorName ?? '—'}</Row>
        <Row label="Occurred">
          {new Date(row.occurredAt).toLocaleString('en-GB')}
          <span className="text-ink-400"> · {timeAgo(row.occurredAt)}</span>
        </Row>
        {row.valueImpact !== null && (
          <Row label="Value impact">
            <span
              className={`tnum font-semibold ${row.valueImpact < 0 ? 'text-red-600' : 'text-ink-800'}`}
            >
              {money(row.valueImpact)}
            </span>
          </Row>
        )}
      </dl>

      {/* The raw payload. An auditor should never have to take our word for it. */}
      <div className="border-ink-100 border-t px-4 py-3">
        <div className="text-ink-400 mb-1.5 text-[10.5px] font-medium uppercase tracking-wider">
          Evidence
        </div>
        <pre className="bg-ink-950 overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-100">
          {JSON.stringify(row.detail, null, 2)}
        </pre>
      </div>

      {isClosed ? (
        <div className="border-ink-100 bg-ink-50/60 border-t px-4 py-3.5 text-[12.5px]">
          <div className="text-ink-700 font-medium">
            Cleared by {row.clearedByName ?? 'unknown'}
          </div>
          {row.clearedAt !== null && (
            <div className="text-ink-400 mt-0.5 text-xs">
              {new Date(row.clearedAt).toLocaleString('en-GB')}
            </div>
          )}
          {row.clearingNote !== null && (
            <p className="text-ink-600 mt-2 italic">“{row.clearingNote}”</p>
          )}
        </div>
      ) : row.kind === 'unreviewed_product' && row.productId !== null ? (
        <ProductReviewActions productId={row.productId} onDone={onDone} />
      ) : (
        <form onSubmit={submit} className="border-ink-100 bg-ink-50/50 space-y-2.5 border-t px-4 py-3.5">
          <div>
            <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              Cleared by
            </label>
            <select
              required
              value={clearedBy}
              onChange={(e) => setClearedBy(e.target.value)}
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            >
              <option value="">Select a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
              What was done
            </label>
            <textarea
              required
              minLength={3}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Recounted and adjusted; supplier credit requested."
              className="border-ink-200 focus:border-accent-500 w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </div>

          {error !== null && <div className="text-[12px] text-red-600">{error}</div>}

          <div className="flex items-center gap-2 pt-0.5">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null}
              Clear item
            </Button>
            <Button type="button" onClick={() => void mark('acknowledged')} disabled={busy}>
              Acknowledge
            </Button>
            <Button type="button" variant="ghost" onClick={() => void mark('escalated')} disabled={busy}>
              Escalate
            </Button>
          </div>
          <p className="text-ink-400 pt-0.5 text-[11px]">
            Clearing is recorded in the audit log against the person named above.
          </p>
        </form>
      )}
    </Card>
  );
}

/**
 * The two resolutions for a cashier-created product, in place of the
 * generic clear form: approve and merge both clear the exception themselves
 * as part of resolving the product (products.ts), so there is no separate
 * "clear without deciding" path here - that would leave the product
 * permanently pending with nothing pointing back at it.
 */
function ProductReviewActions({ productId, onDone }: { productId: string; onDone: () => void }) {
  const [mode, setMode] = useState<'approve' | 'merge' | null>(null);

  if (mode === 'approve') {
    return <ApproveForm productId={productId} onDone={onDone} onCancel={() => setMode(null)} />;
  }
  if (mode === 'merge') {
    return <MergeForm productId={productId} onDone={onDone} onCancel={() => setMode(null)} />;
  }

  return (
    <div className="border-ink-100 bg-ink-50/50 space-y-2.5 border-t px-4 py-3.5">
      <p className="text-ink-500 text-[12px]">
        Did this already exist under another name, or is it genuinely new?
      </p>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => setMode('approve')}>
          Accept as new
        </Button>
        <Button onClick={() => setMode('merge')}>Merge into existing</Button>
      </div>
    </div>
  );
}

function ApproveForm({
  productId,
  onDone,
  onCancel,
}: {
  productId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const categories = useAsync(() => api.categories(), []);
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('Reviewed and accepted into the item master.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.approveProduct(productId, {
        ...(categoryId === '' ? {} : { categoryId }),
        note,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-ink-100 bg-ink-50/50 space-y-2.5 border-t px-4 py-3.5">
      <div>
        <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
          Category
        </label>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="">No category</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
          Note
        </label>
        <textarea
          required
          minLength={3}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="border-ink-200 focus:border-accent-500 w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        />
      </div>
      {error !== null && <div className="text-[12px] text-red-600">{error}</div>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          Accept into the master
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}

function MergeForm({
  productId,
  onDone,
  onCancel,
}: {
  productId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Product | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useAsync(
    () =>
      search.trim() === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.products({ search, limit: 8 }),
    [search],
  );

  async function submit() {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.mergeProduct(productId, {
        targetProductId: target.id,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-ink-100 bg-ink-50/50 space-y-2.5 border-t px-4 py-3.5">
      {target === null ? (
        <div>
          <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
            Find the existing product
          </label>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or SKU…"
            className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          {search.trim() !== '' && (
            <div className="border-ink-100 mt-1.5 max-h-40 divide-y overflow-y-auto rounded-lg border bg-white">
              {results.loading ? (
                <div className="grid place-items-center py-3">
                  <Spinner />
                </div>
              ) : (results.data?.items.length ?? 0) === 0 ? (
                <p className="text-ink-400 px-3 py-2 text-[12px]">No match for “{search}”.</p>
              ) : (
                (results.data?.items ?? [])
                  .filter((p) => p.id !== productId)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setTarget(p)}
                      className="hover:bg-ink-50 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px]"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-ink-400 shrink-0 font-mono text-[11px]">{p.sku}</span>
                    </button>
                  ))
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-[12.5px]">
          <span>
            Merging into <span className="font-medium">{target.name}</span>{' '}
            <span className="text-ink-400 font-mono text-[11px]">{target.sku}</span>
          </span>
          <button onClick={() => setTarget(null)} className="text-ink-400 hover:text-ink-700 text-[11.5px]">
            change
          </button>
        </div>
      )}

      <div>
        <label className="text-ink-600 mb-1 block text-[11px] font-medium uppercase tracking-wider">
          Note (optional)
        </label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Duplicate of an item already in the master under this name."
          className="border-ink-200 focus:border-accent-500 w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 text-[12.5px] outline-none"
        />
      </div>

      {error !== null && <div className="text-[12px] text-red-600">{error}</div>}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={busy || target === null}>
          {busy ? <Spinner /> : null}
          Merge
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <dt className="text-ink-400 w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
