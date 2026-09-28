import { describe, expect, it } from 'vitest';

import { parseCountText } from '../src/lib/countText.js';

describe('a counted quantity from a spreadsheet', () => {
  it('reads thousands written with commas or spaces as thousands', () => {
    expect(parseCountText('1,250')).toEqual({ ok: true, value: 1250 });
    expect(parseCountText('1,250,000')).toEqual({ ok: true, value: 1_250_000 });
    expect(parseCountText('1,250.5')).toEqual({ ok: true, value: 1250.5 });
    expect(parseCountText('12 500')).toEqual({ ok: true, value: 12500 });
  });

  it('reads plain numbers and dot decimals', () => {
    expect(parseCountText('3')).toEqual({ ok: true, value: 3 });
    expect(parseCountText(' 12.75 ')).toEqual({ ok: true, value: 12.75 });
  });

  it('refuses a comma that could be a decimal or thousands, rather than guess', () => {
    const r = parseCountText('1,5');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('dot for decimals');
    expect(parseCountText('12,50').ok).toBe(false);
  });

  it('refuses words and negatives', () => {
    expect(parseCountText('abc').ok).toBe(false);
    expect(parseCountText('-4').ok).toBe(false);
  });
});
