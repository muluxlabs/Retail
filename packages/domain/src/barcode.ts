/**
 * Barcode rules.
 *
 * Two jobs, deliberately separated:
 *
 *   1. `assertBarcodeRegistrable` — the gate on writing to master data. It
 *      mirrors the CHECK constraints in `001_core.sql` exactly, because the
 *      migration is the source of truth for schema (HANDOFF §7) and the
 *      offline POS must agree with the server about what the database will
 *      accept.
 *   2. `classifyBarcode` / `ean13CheckDigit` — diagnostics over data that
 *      already exists. This is what the item-master cleanse reports against
 *      the client's 814-row export, where the codes in HANDOFF §2.3 live.
 *
 * On the check digit: the schema does NOT verify it, and neither does this
 * module by default. Every barcode in the client's own fixtures fails a GS1
 * modulo-10 check, so enforcing it at registration would make their real data
 * unrepresentable rather than merely suspect. It is reported as a defect and
 * available as an opt-in registration rule for greenfield master data.
 */

import { InvalidMasterData } from './errors.js';

export type Symbology = 'ean13' | 'ean8' | 'upca' | 'internal' | 'embedded_weight';

/**
 * Defect categories catalogued across the client's 814-item master
 * (HANDOFF §2.3): 241 codes under six digits, 42 over thirteen, 75 damaged by
 * spreadsheet leading-zero loss, one negative.
 */
export type BarcodeDefect =
  | 'empty'
  | 'negative'
  | 'non_numeric'
  | 'too_short'
  | 'too_long'
  | 'leading_zero'
  | 'bad_check_digit';

const EAN13_SHAPE = /^[0-9]{13}$/;
const DIGITS_ONLY = /^[0-9]+$/;

/** Shortest code length the client's data treats as plausibly real (§2.3). */
const MIN_PLAUSIBLE_LENGTH = 6;

/**
 * GS1 modulo-10 check digit over the first twelve digits of an EAN-13.
 *
 * Odd positions weigh 1, even positions weigh 3, counting from the left
 * starting at position 1.
 */
export function ean13CheckDigit(first12: string): number {
  if (first12.length !== 12 || !DIGITS_ONLY.test(first12)) {
    throw new InvalidMasterData(
      'EAN-13 check digit requires exactly 12 digits',
      { first12 },
    );
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** True only for a well-formed EAN-13 whose check digit verifies. */
export function isValidEan13(code: string): boolean {
  if (!EAN13_SHAPE.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === code.charCodeAt(12) - 48;
}

/**
 * Every defect a code carries, for the cleanse report. Returns an empty array
 * for a clean code. Never throws — this runs over dirty data by design.
 */
export function classifyBarcode(code: string, symbology: Symbology = 'ean13'): BarcodeDefect[] {
  const defects: BarcodeDefect[] = [];

  if (code.length === 0) return ['empty'];

  const negative = code.startsWith('-');
  if (negative) defects.push('negative');

  const body = negative ? code.slice(1) : code;
  if (!DIGITS_ONLY.test(body)) {
    defects.push('non_numeric');
    return defects;
  }

  // Spreadsheet damage: a short code that begins with 0 lost its leading
  // digits to numeric coercion. A full-length code starting with 0 is a
  // legitimate zero-padded UPC-A and is not a defect.
  if (body.length < 13 && body.startsWith('0')) defects.push('leading_zero');

  if (body.length < MIN_PLAUSIBLE_LENGTH) defects.push('too_short');
  else if (body.length > 13) defects.push('too_long');

  if (symbology === 'ean13' && EAN13_SHAPE.test(code) && !isValidEan13(code)) {
    defects.push('bad_check_digit');
  }

  return defects;
}

export interface BarcodeRegistrationOptions {
  /**
   * Also reject codes whose GS1 check digit does not verify.
   *
   * Off by default so this module accepts exactly what `001_core.sql` accepts.
   * Turn it on for greenfield master data, not for migrating theirs.
   */
  strictCheckDigit?: boolean;
}

/**
 * The registration gate. Mirrors `barcode_no_negatives` and `barcode_shape`
 * from `001_core.sql`; throws rather than returning a flag because a rejected
 * barcode is a master-data error, not a validation result to be rendered.
 */
export function assertBarcodeRegistrable(
  code: string,
  symbology: Symbology = 'ean13',
  options: BarcodeRegistrationOptions = {},
): void {
  if (code.length === 0) {
    throw new InvalidMasterData('Barcode is empty', { code, defects: ['empty'] });
  }

  // CONSTRAINT barcode_no_negatives CHECK (code !~ '^-')
  if (code.startsWith('-')) {
    throw new InvalidMasterData(
      `Negative barcode rejected: ${code}`,
      { code, defects: classifyBarcode(code, symbology) },
    );
  }

  // CONSTRAINT barcode_shape CHECK (symbology <> 'ean13' OR code ~ '^[0-9]{13}$')
  if (symbology === 'ean13' && !EAN13_SHAPE.test(code)) {
    throw new InvalidMasterData(
      `EAN-13 barcode must be exactly 13 digits: ${code}`,
      { code, defects: classifyBarcode(code, symbology) },
    );
  }

  if (options.strictCheckDigit && symbology === 'ean13' && !isValidEan13(code)) {
    throw new InvalidMasterData(
      `EAN-13 check digit does not verify: ${code}`,
      { code, defects: classifyBarcode(code, symbology) },
    );
  }
}
