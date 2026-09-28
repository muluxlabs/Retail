/**
 * The arithmetic behind the charts, kept out of React so it can be tested.
 * A wrong axis is the kind of bug that looks plausible on screen: the bars
 * draw, the numbers are simply misleading. Hence tests, not eyeballing.
 */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 1,284 -> "1.3K", 12,900 -> "12.9K", 4,200,000 -> "4.2M". For axes and tight spots. */
export const compact = (n: number): string => COMPACT.format(n);

/**
 * Round tick values from zero up to just past `max`.
 *
 * Steps are 1/2/5 x a power of ten and never 2.5: these are unit counts, and
 * an axis reading 0, 2.5, 5, 7.5 over whole units is noise.
 */
export function niceTicks(max: number, count = 4): { ticks: number[]; top: number } {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], top: 1 };

  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step - 1e-9) * step;

  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step / 1e6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { ticks, top: Number(top.toPrecision(12)) };
}

/**
 * Which of `n` points get an axis label: at most `max`, at a REGULAR step,
 * counting back from the last one. Spreading them evenly by index instead
 * gives gaps of 3, 3, 4, 3 days, which reads as if the axis were broken; and
 * the latest period is the one a reader most wants to see named.
 */
export function pickLabelIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max < 1) return [];
  const step = Math.ceil(n / max);
  const picked: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) picked.push(i);
  return picked.reverse();
}

/**
 * A bar with its two TOP corners rounded and its baseline edge square - the
 * bar grows out of the axis, it is not a pill floating above it.
 */
export function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return (
    `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}` +
    `L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`
  );
}

/** Percent change, or null when there is nothing to compare against. */
export function pctChange(now: number, before: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  return ((now - before) / before) * 100;
}

// -- period labels -------------------------------------------------------------
//
// Buckets arrive as strings ('2026-09-03', '2026-09', '2026'). They are parsed
// by hand and formatted from UTC parts: going through a local-time Date would
// shift a calendar day by the viewer's UTC offset and label the wrong day.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export type BucketKind = 'day' | 'week' | 'month' | 'year';

function parts(bucket: string): { y: number; m: number; d: number } {
  const [y, m, d] = bucket.split('-').map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

/** Short label for an axis: "3 Sep", "Sep 26", "2026". */
export function bucketLabel(bucket: string, kind: BucketKind): string {
  const { y, m, d } = parts(bucket);
  if (kind === 'year') return String(y);
  if (kind === 'month') return `${MONTHS[m - 1] ?? ''} ${String(y).slice(2)}`;
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

/** Full label for a tooltip: "Wed 3 Sep 2026", "Week of 1 Sep 2026", "September 2026". */
export function bucketHeading(bucket: string, kind: BucketKind): string {
  const { y, m, d } = parts(bucket);
  if (kind === 'year') return String(y);
  if (kind === 'month') return `${MONTHS_LONG[m - 1] ?? ''} ${y}`;
  const date = `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
  if (kind === 'week') return `Week of ${date}`;
  const dow = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return `${dow} ${date}`;
}

// -- filling the quiet periods -------------------------------------------------
//
// The API returns only periods that had movements. Drawn as-is, a quiet day is
// not a zero on the chart, it is a hole the line silently bridges - which
// misreports the shape of the month. So the full run of periods is rebuilt here
// and the missing ones are zero.

const DAY_MS = 86_400_000;
const MAX_BUCKETS = 800;

function utcMs(dateStr: string): number {
  const { y, m, d } = parts(dateStr);
  return Date.UTC(y, m - 1, d);
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Monday of the week containing this instant - the same week boundary Postgres' date_trunc('week') uses. */
function mondayOf(ms: number): number {
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return ms - sinceMonday * DAY_MS;
}

/** Every period key from `from` to `to` inclusive, in the exact form the API labels its buckets. */
export function bucketKeys(from: string, to: string, kind: BucketKind): string[] {
  const start = utcMs(from);
  const end = utcMs(to);
  if (!(end >= start)) return [];

  const keys: string[] = [];
  if (kind === 'day') {
    for (let t = start; t <= end && keys.length < MAX_BUCKETS; t += DAY_MS) keys.push(isoDay(t));
  } else if (kind === 'week') {
    for (let t = mondayOf(start); t <= end && keys.length < MAX_BUCKETS; t += 7 * DAY_MS) keys.push(isoDay(t));
  } else if (kind === 'month') {
    const s = new Date(start);
    const e = new Date(end);
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth();
    while ((y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth())) && keys.length < MAX_BUCKETS) {
      keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      if (++m > 11) {
        m = 0;
        y++;
      }
    }
  } else {
    for (let y = new Date(start).getUTCFullYear(); y <= new Date(end).getUTCFullYear() && keys.length < MAX_BUCKETS; y++)
      keys.push(String(y));
  }
  return keys;
}

/** `rows` (keyed by `bucket`) laid onto the complete run of periods, with zero rows where there was nothing. */
export function fillBuckets<T extends { bucket: string }>(
  rows: T[],
  from: string,
  to: string,
  kind: BucketKind,
  zero: (bucket: string) => T,
): T[] {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  const keys = bucketKeys(from, to, kind);
  // A period the server returned that our own arithmetic did not predict
  // (a boundary disagreement) must never be silently dropped.
  const known = new Set(keys);
  const extras = rows.filter((r) => !known.has(r.bucket)).map((r) => r.bucket);
  return [...keys, ...extras].sort().map((k) => byKey.get(k) ?? zero(k));
}
