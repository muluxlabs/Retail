import { describe, expect, it } from 'vitest';

import { csvCell, toCsv } from '../src/lib/csv.js';

describe('a CSV cell', () => {
  it('never lets text run as a spreadsheet formula', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+263 77 000')).toBe("'+263 77 000");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
  });

  it('leaves numbers, negative amounts and ordinary text alone', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('White sugar 2kg')).toBe('White sugar 2kg');
    expect(csvCell(null)).toBe('');
  });

  it('quotes commas, quotes and new lines', () => {
    expect(toCsv(['Name', 'Note'], [['Mai, Rudo', 'said "hi"\nthen left']])).toBe('Name,Note\n"Mai, Rudo","said ""hi""\nthen left"');
  });
});
