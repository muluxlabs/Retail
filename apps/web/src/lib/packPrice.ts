/**
 * What a pack's price means per unit, and against buying singles.
 *
 * Each pack has its own selling price, set by the business: a single at $4.00
 * and a pack of 3 at $10.00 is normal (a bulk saving). Shown as it is typed,
 * so a mistake - a pack dearer than the same number of singles - is caught
 * before it reaches the till.
 */

export interface PackPriceNote {
  /** Price of one base unit inside this pack. */
  perUnit: number;
  /** What the same number of singles would cost, when there is a single price to compare with. */
  singlesTotal: number | null;
  /** singlesTotal - pack price: positive is a saving for the customer. */
  saving: number | null;
  kind: 'saves' | 'same' | 'dearer' | 'no-compare';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function packPriceNote(price: number | null, units: number, singlePrice: number | null): PackPriceNote | null {
  if (price === null || !Number.isFinite(price) || !(units > 0)) return null;
  const perUnit = price / units;
  if (units === 1 || singlePrice === null) return { perUnit, singlesTotal: null, saving: null, kind: 'no-compare' };
  const singlesTotal = round2(singlePrice * units);
  const saving = round2(singlesTotal - price);
  return { perUnit, singlesTotal, saving, kind: saving > 0 ? 'saves' : saving < 0 ? 'dearer' : 'same' };
}

/** "a unit" for items counted one by one, "per kg" (etc.) otherwise. */
export function perUnitWord(baseUom: string): string {
  return baseUom === 'each' || baseUom === '' ? 'a unit' : `per ${baseUom}`;
}

/** The note in words, e.g. "$3.33 a unit · saves $2.00 against 3 singles". */
export function packPriceText(note: PackPriceNote, units: number, baseUom: string, money: (n: number) => string): string {
  const each = `${money(note.perUnit)} ${perUnitWord(baseUom)}`;
  const n = Number.isInteger(units) ? String(units) : units.toFixed(2);
  const singles = baseUom === 'each' || baseUom === '' ? `${n} singles` : `${n} ${baseUom} sold singly`;
  if (note.kind === 'saves') return `${each} · saves ${money(note.saving!)} against ${singles}`;
  if (note.kind === 'same') return `${each} · the same as ${singles}`;
  if (note.kind === 'dearer') return `${each} · ${money(-note.saving!)} MORE than ${singles}. Is this right?`;
  return each;
}
