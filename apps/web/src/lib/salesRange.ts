/**
 * Date ranges for the sales and profit screen.
 *
 * Everything here is plain 'YYYY-MM-DD' arithmetic on the BUSINESS's calendar.
 * "Today" is given by the server (the shop's time zone), never read from the
 * browser: a manager travelling, or a till PC with the wrong clock, must not
 * move what "today" means.
 */

export type Preset = 'today' | 'yesterday' | 'last7' | 'week' | 'last30' | 'month' | 'lastMonth' | 'custom';

export const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'week', label: 'This week' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

const DAY_MS = 86_400_000;
const ms = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const str = (n: number): string => new Date(n).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => str(ms(d) + n * DAY_MS);

/** Whole days from `from` to `to`, inclusive. */
export const daysBetween = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / DAY_MS) + 1;

export function rangeFor(preset: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'week': {
      // Weeks start on Monday, as the report's own week buckets do.
      const sinceMonday = (new Date(ms(today)).getUTCDay() + 6) % 7;
      return { from: addDays(today, -sinceMonday), to: today };
    }
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const first = `${today.slice(0, 7)}-01`;
      const lastDay = addDays(first, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}

export type Grouping = 'hour' | 'day' | 'week' | 'month';

/** A sensible way to slice a period so the chart is neither one lump nor noise. */
export function defaultGrouping(from: string, to: string): Grouping {
  const n = daysBetween(from, to);
  if (n <= 1) return 'hour';
  if (n <= 45) return 'day';
  if (n <= 180) return 'week';
  return 'month';
}

/** Every hour bucket of one day, in the form the API labels them: '2026-09-25 09:00'. */
export function hourKeys(day: string): string[] {
  return Array.from({ length: 24 }, (_, h) => `${day} ${String(h).padStart(2, '0')}:00`);
}

/** '14:00' style axis label for an hour bucket or a bare hour number. */
export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** The words for a period, for a heading or a printout. */
export function describePeriod(from: string, to: string): string {
  const f = (d: string) =>
    new Date(ms(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return from === to ? f(from) : `${f(from)} to ${f(to)}`;
}
