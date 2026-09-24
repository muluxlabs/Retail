/**
 * Charts, built from plain SVG and HTML.
 *
 * No charting library: the marks here follow a fixed spec (2px lines, bars no
 * thicker than 24px with a 4px rounded end and a square baseline, a 2px
 * surface gap between touching marks, hairline recessive grid) that is easier
 * to hold to when it is ours than when it is a library's defaults, and it
 * keeps the bundle and the pinned dependency list unchanged.
 *
 * Rules every chart in here follows:
 *  - Colour comes from the tokens in index.css and follows the ENTITY: sold is
 *    always blue, received always teal. Text never wears a series colour;
 *    identity is the coloured mark beside the text.
 *  - Values are reachable without hovering: bars carry their number, and the
 *    time-series has a Table view. A tooltip enhances, it never gates.
 *  - Nothing is coloured to mean "series" using amber or red: those are
 *    reserved for open work items and negative stock, everywhere in this app.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { compact, niceTicks, pickLabelIndices, roundedTopRect } from './chartMath.js';
import { Card } from './ui.js';

export const VIZ = {
  sold: 'var(--viz-sold)',
  received: 'var(--viz-received)',
  neutral: 'var(--viz-neutral)',
} as const;

const fmtNumber = (n: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(n);

// -- sizing --------------------------------------------------------------------

/** An element's width, kept current as the window or its container resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Layout effect so the first paint already has a real width - no flash of a
  // wrongly-sized chart snapping into place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

// -- the time-series / grouped-column chart --------------------------------------

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface SeriesPoint {
  /** Short, for the axis. */
  label: string;
  /** Long, for the tooltip. */
  heading: string;
  /** One value per series, in series order. */
  values: number[];
}

export function SeriesChart({
  series,
  points,
  kind = 'auto',
  height = 220,
  format = fmtNumber,
  emphasizeMax = false,
  ariaLabel,
}: {
  series: Series[];
  points: SeriesPoint[];
  /** 'auto' draws columns for a handful of periods and a line for many. */
  kind?: 'auto' | 'line' | 'column';
  height?: number;
  format?: (n: number) => string;
  /** Single-series columns only: the tallest column in colour, the rest quiet. */
  emphasizeMax?: boolean;
  ariaLabel: string;
}) {
  const [ref, measured] = useWidth();
  const [active, setActive] = useState<number | null>(null);

  const n = points.length;
  const shape = kind === 'auto' ? (n <= 12 ? 'column' : 'line') : kind;
  const w = Math.max(measured, 240);

  const maxValue = Math.max(0, ...points.flatMap((p) => p.values));
  const { ticks, top: yTop } = niceTicks(maxValue);
  const tickText = ticks.map((t) => compact(t));

  const left = 10 + Math.max(...tickText.map((t) => t.length)) * 6.4;
  const right = 10;
  const topPad = 10;
  const bottomBand = 24;
  const plotW = w - left - right;
  const plotH = height - topPad - bottomBand;
  const baseY = topPad + plotH;

  const y = (v: number) => baseY - (Math.max(0, v) / yTop) * plotH;
  const band = plotW / Math.max(n, 1);
  const xAt = (i: number) =>
    shape === 'column'
      ? left + band * (i + 0.5)
      : n === 1
        ? left + plotW / 2
        : left + 6 + (i * (plotW - 12)) / (n - 1);

  // Room per axis label comes from the labels themselves: "Mon" needs a third
  // of what "26 Aug" does, so seven weekdays all fit on a phone where a fixed
  // per-label guess would thin them to every other one.
  const labelPx = Math.max(...points.map((p) => p.label.length), 3) * 6.2 + 14;
  const xLabelIdx = pickLabelIndices(n, Math.max(2, Math.floor(plotW / labelPx)));

  function indexAt(e: PointerEvent<SVGRectElement>): number {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i =
      shape === 'column'
        ? Math.floor(px / band)
        : Math.round((px - 6) / (n === 1 ? plotW : (plotW - 12) / (n - 1)));
    return Math.min(n - 1, Math.max(0, i));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (n === 0) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  }

  const k = series.length;
  const barW = Math.min(24, (Math.min(band * 0.78, k * 24 + (k - 1) * 2) - (k - 1) * 2) / k);
  const groupW = k * barW + (k - 1) * 2;
  const peak =
    emphasizeMax && k === 1 ? points.findIndex((p) => p.values[0] === maxValue) : -1;

  const activePoint = active === null ? undefined : points[active];
  const tipRight = active !== null && xAt(active) + 12 + 170 > w;

  return (
    <div>
      {k >= 2 && (
        <ul className="text-ink-600 mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                className={shape === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-[2px]'}
                style={{ background: s.color }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}

      <div
        ref={ref}
        className="relative outline-offset-4"
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. Use the left and right arrow keys to read each period, or switch to the table view.`}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? (n > 0 ? n - 1 : null))}
        onBlur={() => setActive(null)}
      >
        <svg width={w} height={height} className="block select-none" aria-hidden="true">
          {ticks.map((t, i) => (
            <g key={t}>
              <line
                x1={left}
                x2={w - right}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                style={{ stroke: i === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)' }}
              />
              <text
                x={left - 8}
                y={y(t) + 3.5}
                textAnchor="end"
                fontSize={11}
                style={{ fill: 'var(--viz-text)' }}
              >
                {tickText[i]}
              </text>
            </g>
          ))}

          {xLabelIdx.map((i) => {
            const x = xAt(i);
            const anchor = x - 22 < 0 ? 'start' : x + 22 > w ? 'end' : 'middle';
            return (
              <text
                key={i}
                x={x}
                y={height - 6}
                textAnchor={anchor}
                fontSize={11}
                style={{ fill: 'var(--viz-text)' }}
              >
                {points[i]?.label}
              </text>
            );
          })}

          {active !== null && shape === 'column' && (
            <rect
              x={left + band * active}
              y={topPad}
              width={band}
              height={plotH}
              style={{ fill: 'var(--viz-grid)' }}
            />
          )}

          {shape === 'column'
            ? points.map((p, i) =>
                series.map((s, si) => {
                  const v = p.values[si] ?? 0;
                  const top = y(v);
                  // A real but tiny value still deserves a visible sliver.
                  const barTop = v > 0 ? Math.min(top, baseY - 2) : baseY;
                  const x = xAt(i) - groupW / 2 + si * (barW + 2);
                  const colour = peak >= 0 && i !== peak ? 'var(--viz-quiet)' : s.color;
                  return (
                    <path
                      key={`${i}-${s.key}`}
                      d={roundedTopRect(x, barTop, barW, baseY - barTop, 4)}
                      style={{ fill: colour }}
                    />
                  );
                }),
              )
            : series.map((s, si) => {
                const path = points
                  .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${y(p.values[si] ?? 0)}`)
                  .join('');
                const lastI = n - 1;
                return (
                  <g key={s.key}>
                    {k === 1 && n > 1 && (
                      <path
                        d={`${path}L${xAt(lastI)},${baseY}L${xAt(0)},${baseY}Z`}
                        style={{ fill: s.color }}
                        opacity={0.1}
                      />
                    )}
                    <path
                      d={path}
                      fill="none"
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      style={{ stroke: s.color }}
                    />
                    {(n <= 14 ? points.map((_, i) => i) : [lastI]).map((i) => (
                      <circle
                        key={i}
                        cx={xAt(i)}
                        cy={y(points[i]?.values[si] ?? 0)}
                        r={4}
                        strokeWidth={2}
                        style={{ fill: s.color, stroke: 'var(--viz-surface)' }}
                      />
                    ))}
                  </g>
                );
              })}

          {active !== null && shape === 'line' && (
            <g>
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={topPad}
                y2={baseY}
                strokeWidth={1}
                style={{ stroke: 'var(--viz-quiet)' }}
              />
              {series.map((s, si) => (
                <circle
                  key={s.key}
                  cx={xAt(active)}
                  cy={y(points[active]?.values[si] ?? 0)}
                  r={5}
                  strokeWidth={2}
                  style={{ fill: s.color, stroke: 'var(--viz-surface)' }}
                />
              ))}
            </g>
          )}

          {/* The hit target is the whole plot, not the marks: readers aim at a
              period, never at a 2px line. touch-action keeps vertical page
              scroll working when a finger starts on the chart. */}
          <rect
            x={left}
            y={topPad}
            width={Math.max(plotW, 0)}
            height={Math.max(plotH, 0)}
            fill="transparent"
            style={{ touchAction: 'pan-y' }}
            onPointerMove={(e) => setActive(indexAt(e))}
            onPointerDown={(e) => setActive(indexAt(e))}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') setActive(null);
            }}
          />
        </svg>

        {active !== null && activePoint !== undefined && (
          <div
            className="border-ink-200 pointer-events-none absolute z-10 min-w-36 rounded-lg border bg-white px-2.5 py-2 shadow-lg"
            style={{
              top: 4,
              left: tipRight ? undefined : xAt(active) + 12,
              right: tipRight ? w - xAt(active) + 12 : undefined,
            }}
          >
            <div className="text-ink-500 text-[11px]">{activePoint.heading}</div>
            {series.map((s, si) => (
              <div key={s.key} className="mt-1 flex items-center gap-2 text-[12px]">
                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                <span className="text-ink-900 font-semibold">{format(activePoint.values[si] ?? 0)}</span>
                <span className="text-ink-500">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// -- horizontal bars for ranked, named things ----------------------------------------

export interface BarRow {
  key: string;
  label: string;
  /** Small, monospaced, beside the label - a SKU, say. */
  hint?: string;
  value: number;
}

/**
 * A ranked list where every bar carries its own number at its tip, so the
 * values never depend on hovering. One series, one colour: bars are not
 * shaded by size, because their length already says that.
 */
export function BarList({
  rows,
  color,
  format = fmtNumber,
}: {
  rows: BarRow[];
  color: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  // One shared width for every value. If each row sized its own, the room left
  // for the bar would differ row to row and equal values would draw unequal.
  const valueCh = Math.max(4, ...rows.map((r) => format(r.value).length)) + 1;

  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const frac = max > 0 ? Math.max(0, r.value) / max : 0;
        return (
          <li key={r.key} className="group -mx-2 rounded-lg px-2 py-0.5 hover:bg-[var(--viz-grid)]" title={`${r.label}: ${format(r.value)}`}>
            <div className="flex items-baseline gap-2 text-[12.5px]">
              <span className="text-ink-800 min-w-0 truncate">{r.label}</span>
              {r.hint !== undefined && (
                <span className="text-ink-400 shrink-0 font-mono text-[10.5px]">{r.hint}</span>
              )}
            </div>
            {/* The bar is a share of what is left after the value's own column,
                so the number always sits right at the tip and no bar can run
                under it. Every row shares one scale. */}
            <div className="mt-1 flex items-center gap-2">
              <div
                className="h-2 shrink-0 rounded-r-[4px]"
                style={{
                  width: `calc((100% - ${valueCh}ch - 0.5rem) * ${frac})`,
                  minWidth: r.value > 0 ? 2 : 0,
                  background: color,
                }}
              />
              <span
                className={`tnum shrink-0 text-[12px] font-medium ${
                  r.value < 0 ? 'text-red-700' : 'text-ink-900'
                }`}
              >
                {format(r.value)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// -- small figures ---------------------------------------------------------------

export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 88;
  const height = 30;
  if (values.length < 2) return null;

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = 5;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => (hi === lo ? height / 2 : height - pad - ((v - lo) / span) * (height - pad * 2));
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join('');
  const last = values.length - 1;

  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      <path
        d={path}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ stroke: color }}
      />
      <circle
        cx={x(last)}
        cy={y(values[last] ?? 0)}
        r={4}
        strokeWidth={2}
        style={{ fill: color, stroke: 'var(--viz-surface)' }}
      />
    </svg>
  );
}

/** A ratio against a limit. The unfilled track is a pale step of the fill's own colour. */
export function Meter({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      className="relative mt-2 h-1.5 overflow-hidden rounded-full"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className="absolute inset-0" style={{ background: color, opacity: 0.16 }} />
      <div className="relative h-full rounded-full" style={{ width: `${frac * 100}%`, background: color }} />
    </div>
  );
}

/** Change against a named period. Direction is an arrow AND a colour, never colour alone. */
export function Delta({
  pct,
  upIsGood,
  versus,
}: {
  pct: number | null;
  /** null when neither direction is better or worse, e.g. units received. */
  upIsGood: boolean | null;
  versus: string;
}) {
  if (pct === null) return <span className="text-ink-400 text-[11.5px]">No earlier period to compare</span>;

  const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  const tone =
    dir === 'flat' || upIsGood === null
      ? 'text-ink-500'
      : (dir === 'up') === upIsGood
        ? 'text-[var(--viz-good-text)]'
        : 'text-red-700';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬';
  const size = Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.abs(pct).toFixed(0);

  return (
    <span className={`flex flex-wrap items-baseline gap-x-1 text-[11.5px] font-medium ${tone}`}>
      <span aria-hidden="true" className="text-[9px]">
        {arrow}
      </span>
      {dir === 'flat' ? 'Unchanged' : `${size}% ${dir === 'up' ? 'higher' : 'lower'}`}
      <span className="text-ink-400 font-normal">{versus}</span>
    </span>
  );
}

/**
 * A headline number, optionally with its movement and a trend line.
 * Values are set in proportional figures - tabular figures are for columns
 * that must line up, and make a big standalone number look loose.
 */
export function KpiTile({
  label,
  value,
  sub,
  delta,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: ReactNode;
  spark?: { values: number[]; color: string };
}) {
  // @container: the sparkline sits BESIDE the number only when this tile is
  // wide enough for both, and drops underneath otherwise. Deciding by viewport
  // width instead truncated "1,551" to "1,..." in a two-column phone layout - a
  // headline figure must never ellipsize.
  return (
    <Card className="@container px-4 py-3.5">
      <div className="text-ink-500 text-[11px] font-medium uppercase tracking-wider">{label}</div>
      <div className="mt-1.5 flex flex-col gap-1.5 @[17rem]:flex-row @[17rem]:items-end @[17rem]:justify-between @[17rem]:gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{value}</div>
          {sub !== undefined && <div className="text-ink-400 mt-0.5 text-xs">{sub}</div>}
        </div>
        {spark !== undefined && <Sparkline values={spark.values} color={spark.color} />}
      </div>
      {delta !== undefined && <div className="mt-1.5">{delta}</div>}
    </Card>
  );
}

// -- the frame around a chart ------------------------------------------------------

/**
 * Title, an optional Chart/Table switch, and a body that dims - rather than
 * blanking - while new data loads, so the layout never jumps.
 */
export function ChartCard({
  title,
  subtitle,
  actions,
  chart,
  table,
  loading = false,
  empty,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  chart: ReactNode;
  /** When given, the card offers a Table view: the accessible twin of the chart. */
  table?: ReactNode;
  loading?: boolean;
  /** When set, shown instead of the chart and the switch. */
  empty?: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');

  // A keyboard reader who switched to Table and then lands on an empty period
  // should not be left staring at nothing.
  useEffect(() => {
    if (empty !== undefined) setView('chart');
  }, [empty]);

  return (
    <Card className="overflow-hidden">
      <div className="border-ink-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
          {subtitle !== undefined && <p className="text-ink-400 text-[11.5px]">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {table !== undefined && empty === undefined && (
            <div className="bg-ink-100 flex rounded-lg p-0.5" role="group" aria-label="View">
              {(['chart', 'table'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium capitalize transition ${
                    view === v ? 'text-ink-900 bg-white shadow-sm' : 'text-ink-500 hover:text-ink-800'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className={`transition-opacity ${loading ? 'opacity-50' : ''}`}>
        {empty !== undefined ? (
          empty
        ) : view === 'table' && table !== undefined ? (
          <div className="overflow-x-auto">{table}</div>
        ) : (
          <div className="px-4 py-4">{chart}</div>
        )}
      </div>
    </Card>
  );
}

/** The plain table twin of a chart. Numbers right-aligned, in tabular figures. */
export function MiniTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-ink-400 border-ink-100 border-b text-[10.5px] font-medium uppercase tracking-wider">
          {head.map((h, i) => (
            <th key={h} className={`px-4 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-ink-100 divide-y">
        {rows.map((r, ri) => (
          <tr key={ri}>
            {r.map((cell, ci) => (
              <td
                key={ci}
                className={`px-4 py-1.5 ${ci === 0 ? 'text-left font-medium' : 'tnum text-right'}`}
              >
                {typeof cell === 'number' ? fmtNumber(cell) : cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
