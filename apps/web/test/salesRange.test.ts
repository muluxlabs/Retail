import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, defaultGrouping, describePeriod, hourKeys, rangeFor } from '../src/lib/salesRange.js';

describe('sales date ranges', () => {
  // Friday 25 September 2026
  const today = '2026-09-25';

  it('presets are on the business calendar', () => {
    expect(rangeFor('today', today)).toEqual({ from: today, to: today });
    expect(rangeFor('yesterday', today)).toEqual({ from: '2026-09-24', to: '2026-09-24' });
    expect(rangeFor('last7', today)).toEqual({ from: '2026-09-19', to: today });
    expect(rangeFor('last30', today)).toEqual({ from: '2026-08-27', to: today });
    expect(rangeFor('month', today)).toEqual({ from: '2026-09-01', to: today });
  });

  it('a week starts on Monday, as the report buckets do', () => {
    expect(rangeFor('week', today)).toEqual({ from: '2026-09-21', to: today });
    expect(rangeFor('week', '2026-09-21')).toEqual({ from: '2026-09-21', to: '2026-09-21' }); // a Monday
    expect(rangeFor('week', '2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-27' }); // a Sunday
  });

  it('last month is the whole previous month, across year ends and leap years', () => {
    expect(rangeFor('lastMonth', today)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(rangeFor('lastMonth', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(rangeFor('lastMonth', '2024-03-05')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('date arithmetic does not drift over month ends', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(daysBetween('2026-09-19', '2026-09-25')).toBe(7);
    expect(daysBetween(today, today)).toBe(1);
  });

  it('chooses a grouping that suits the length of the period', () => {
    expect(defaultGrouping(today, today)).toBe('hour');
    expect(defaultGrouping('2026-09-01', '2026-09-25')).toBe('day');
    expect(defaultGrouping('2026-06-01', '2026-09-25')).toBe('week');
    expect(defaultGrouping('2025-09-25', '2026-09-25')).toBe('month');
  });

  it('hour buckets match the server format', () => {
    const keys = hourKeys(today);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('2026-09-25 00:00');
    expect(keys[9]).toBe('2026-09-25 09:00');
  });

  it('describes a period in words', () => {
    expect(describePeriod(today, today)).toBe('25 Sept 2026');
    expect(describePeriod('2026-09-01', today)).toContain(' to ');
  });
});
