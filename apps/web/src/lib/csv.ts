/**
 * A cell as it goes into a CSV file. Text a spreadsheet would run as a formula
 * (starting with = + - @, or a tab or carriage return) is written with a
 * leading apostrophe, so a name typed as "=HYPERLINK(...)" opens as plain
 * text, never as a live formula. Plain negative numbers are left as numbers.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole file as text. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

/** Download `rows` as a CSV file, quoting anything that needs it. */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  // A byte-order mark so Excel reads accented names correctly.
  const blob = new Blob(['﻿' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
