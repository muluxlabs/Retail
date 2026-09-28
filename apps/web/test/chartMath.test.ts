import { describe, expect, it } from 'vitest';

import {
  bucketHeading,
  bucketKeys,
  fillBuckets,
  bucketLabel,
  niceTicks,
  pctChange,
  pickLabelIndices,
  roundedTopRect,
} from '../src/lib/chartMath.js';

describe('niceTicks', () => {
  it('falls back to a 0-1 axis when there is nothing to plot', () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], top: 1 });
    expect(niceTicks(Number.NaN)).toEqual({ ticks: [0, 1], top: 1 });
  });

  it('always starts at zero and always covers the maximum', () => {
    for (const max of [1, 3, 7, 90, 1892, 2846, 3480, 12_345, 0.8, 0.03]) {
      const { ticks, top } = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(top);
      expect(top).toBeGreaterThanOrEqual(max);
    }
  });

  it('uses round steps and does not overshoot by more than one step', () => {
    expect(niceTicks(90).ticks).toEqual([0, 50, 100]);
    expect(niceTicks(1892).top).toBe(2000);
    const { ticks } = niceTicks(3480);
    const step = ticks[1] as number;
    expect(ticks.every((t, i) => Math.abs(t - i * step) < 1e-9)).toBe(true);
  });

  it('never proposes a fractional step for whole-unit data', () => {
    for (const max of [9, 11, 24, 240]) {
      expect(niceTicks(max).ticks.every(Number.isInteger)).toBe(true);
    }
  });

  it('does not leak floating point noise into fractional ticks', () => {
    expect(niceTicks(0.8).ticks.every((t) => String(t).length < 8)).toBe(true);
  });
});

describe('pickLabelIndices', () => {
  it('keeps everything when it fits', () => {
    expect(pickLabelIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins to the cap at a regular step and always ends on the latest point', () => {
    const picked = pickLabelIndices(30, 10);
    expect(picked.length).toBeLessThanOrEqual(10);
    expect(picked.at(-1)).toBe(29);
    const gaps = picked.slice(1).map((v, i) => v - (picked[i] as number));
    expect(new Set(gaps).size).toBe(1);
  });

  it('never repeats an index or goes out of range', () => {
    for (const [n, max] of [[31, 6], [7, 3], [100, 8], [13, 12]] as const) {
      const picked = pickLabelIndices(n, max);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.every((i) => i >= 0 && i < n)).toBe(true);
      expect(picked.length).toBeLessThanOrEqual(max);
    }
  });

  it('copes with empty and degenerate input', () => {
    expect(pickLabelIndices(0, 5)).toEqual([]);
    expect(pickLabelIndices(10, 0)).toEqual([]);
  });
});

describe('roundedTopRect', () => {
  it('draws nothing for a zero-height bar', () => {
    expect(roundedTopRect(0, 10, 12, 0, 4)).toBe('');
  });

  it('rounds the top only: the baseline corners stay square', () => {
    const d = roundedTopRect(10, 20, 12, 30, 4);
    expect(d.startsWith('M10,50L10,24')).toBe(true);
    expect(d.endsWith('L22,50Z')).toBe(true);
  });

  it('caps the radius so a short or narrow bar does not fold over itself', () => {
    const d = roundedTopRect(0, 0, 6, 2, 4);
    expect(d).toContain('Q0,0 2,0');
  });
});

describe('pctChange', () => {
  it('is signed', () => {
    expect(pctChange(120, 100)).toBeCloseTo(20);
    expect(pctChange(80, 100)).toBeCloseTo(-20);
  });

  it('refuses to invent a percentage from nothing', () => {
    expect(pctChange(50, 0)).toBeNull();
    expect(pctChange(Number.NaN, 10)).toBeNull();
  });
});

describe('period labels', () => {
  it('labels a day from its own calendar date, not the viewer time zone', () => {
    expect(bucketLabel('2026-09-03', 'day')).toBe('3 Sep');
    expect(bucketHeading('2026-09-03', 'day')).toBe('Thu 3 Sep 2026');
  });

  it('labels weeks, months and years', () => {
    expect(bucketHeading('2026-08-31', 'week')).toBe('Week of 31 Aug 2026');
    expect(bucketLabel('2026-09', 'month')).toBe('Sep 26');
    expect(bucketHeading('2026-09', 'month')).toBe('September 2026');
    expect(bucketLabel('2026', 'year')).toBe('2026');
  });
});

describe('bucketKeys', () => {
  it('lists every day inclusive, across a month boundary', () => {
    const keys = bucketKeys('2026-08-30', '2026-09-02', 'day');
    expect(keys).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('aligns weeks to Monday, like the database does', () => {
    // 2026-09-02 is a Wednesday; its week starts Monday 2026-08-31.
    expect(bucketKeys('2026-09-02', '2026-09-15', 'week')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
  });

  it('lists months and years, rolling over the year end', () => {
    expect(bucketKeys('2025-11-20', '2026-02-03', 'month')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(bucketKeys('2024-06-01', '2026-01-01', 'year')).toEqual(['2024', '2025', '2026']);
  });

  it('is empty for a backwards range and is bounded for an absurd one', () => {
    expect(bucketKeys('2026-09-10', '2026-09-01', 'day')).toEqual([]);
    expect(bucketKeys('1900-01-01', '2100-01-01', 'day').length).toBeLessThanOrEqual(800);
  });
});

describe('fillBuckets', () => {
  const zero = (bucket: string) => ({ bucket, sold: 0 });

  it('puts a zero where a quiet day was missing, keeping real rows untouched', () => {
    const rows = [
      { bucket: '2026-09-01', sold: 5 },
      { bucket: '2026-09-03', sold: 7 },
    ];
    expect(fillBuckets(rows, '2026-09-01', '2026-09-04', 'day', zero)).toEqual([
      { bucket: '2026-09-01', sold: 5 },
      { bucket: '2026-09-02', sold: 0 },
      { bucket: '2026-09-03', sold: 7 },
      { bucket: '2026-09-04', sold: 0 },
    ]);
  });

  it('never drops a real period just because the range arithmetic did not predict it', () => {
    const rows = [{ bucket: '2026-09-09', sold: 3 }];
    const filled = fillBuckets(rows, '2026-09-01', '2026-09-02', 'day', zero);
    expect(filled.some((r) => r.bucket === '2026-09-09' && r.sold === 3)).toBe(true);
  });
});
