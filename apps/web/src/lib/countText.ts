/**
 * Reading a counted quantity typed into a spreadsheet.
 *
 * Spreadsheets write thousands in more than one way ("1,250", "1 250") and
 * some write decimals with a comma ("1,5"). A stock take cannot guess: "1,250"
 * read as 1.25 would write off almost all of the stock. So thousands
 * separators are understood, a dot is the decimal point, and a comma that could
 * be either is refused with a reason.
 */

export type CountText = { ok: true; value: number } | { ok: false; reason: string };

export function parseCountText(raw: string): CountText {
  const t = raw.trim().replace(/[  ]/g, ' ');
  if (t === '') return { ok: false, reason: 'empty' };
  // 1,250  1,250,000  1,250.5  — commas every three digits are thousands.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t.replace(/,/g, '')) };
  // 1 250  12 500.5 — spaces every three digits are thousands too.
  if (/^\d{1,3}( \d{3})+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t.replace(/ /g, '')) };
  if (/^\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  if (/^\d+,\d+$/.test(t)) return { ok: false, reason: `"${raw.trim()}" could be a decimal or thousands: write it with a dot for decimals (1.5) or in full (1500)` };
  return { ok: false, reason: `"${raw.trim()}" is not a number` };
}
