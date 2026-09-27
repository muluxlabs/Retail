/**
 * Importing customers and suppliers from a spreadsheet: which column is which,
 * reading each row, and saying exactly what is wrong with it.
 *
 * Column headings are matched loosely ("Phone", "Tel", "Mobile" all work).
 * Checking against what is already in the system (and look-alike names) is
 * the server's job; this is the part that needs no database.
 */

export interface ColumnSpec<F extends string> {
  field: F;
  heading: string;
  aliases: string[];
  required: boolean;
  help: string;
  examples: string[];
}

export interface RowProblem {
  row: number;
  column: string | null;
  message: string;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function mapColumns<F extends string>(headings: string[], specs: ColumnSpec<F>[]): { byField: Map<F, string>; columns: { heading: string; field: F | null }[]; missing: ColumnSpec<F>[] } {
  const byField = new Map<F, string>();
  const columns = headings.map((h) => {
    const s = squash(h);
    const spec = specs.find((c) => squash(c.heading) === s || c.aliases.includes(s));
    if (spec !== undefined && !byField.has(spec.field)) byField.set(spec.field, h);
    return { heading: h, field: spec?.field ?? null };
  });
  return { byField, columns, missing: specs.filter((c) => c.required && !byField.has(c.field)) };
}

function moneyOrBad(v: string): number | null | 'bad' {
  const t = v.trim().replace(/^\$|^US\$|^USD\s*/i, '').replace(/,/g, '');
  if (t === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : 'bad';
}

function daysOrBad(v: string): number | null | 'bad' {
  const t = v.trim();
  if (t === '') return null;
  return /^\d{1,3}$/.test(t) && Number(t) <= 365 ? Number(t) : 'bad';
}

/** A phone number in one form, for comparing: digits only, a leading 0 read as the country code (+263). */
export function phoneKey(phone: string, country = '263'): string {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = country + d.slice(1);
  return d;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- customers ---------------------------------------------------------------------------------------------------

export type CustomerField = 'name' | 'phone' | 'email' | 'address' | 'idNumber' | 'creditLimit' | 'creditDays' | 'notes';

export const CUSTOMER_COLUMNS: ColumnSpec<CustomerField>[] = [
  { field: 'name', heading: 'Name', aliases: ['customername', 'customer', 'fullname', 'accountname'], required: true, help: 'The customer or business name.', examples: ['Mai Rudo Tuckshop', 'Joseph Sibanda'] },
  { field: 'phone', heading: 'Phone', aliases: ['phonenumber', 'tel', 'telephone', 'mobile', 'cell', 'cellphone', 'contactnumber'], required: false, help: 'One phone number. It identifies the customer: two customers cannot share one.', examples: ['0772 555 101', '+263 773 555 202'] },
  { field: 'email', heading: 'Email', aliases: ['emailaddress', 'mail'], required: false, help: 'Optional.', examples: ['rudo@example.com', ''] },
  { field: 'address', heading: 'Address', aliases: ['physicaladdress', 'location'], required: false, help: 'Optional.', examples: ['Stand 45, Riverside', ''] },
  { field: 'idNumber', heading: 'ID number', aliases: ['id', 'idno', 'nationalid', 'companyregistration', 'regno'], required: false, help: 'National ID or company registration, optional.', examples: ['63-123456A-78', ''] },
  { field: 'creditLimit', heading: 'Credit limit', aliases: ['limit', 'creditlimit', 'credit'], required: false, help: 'How much they may owe at once. Blank or 0: cash only. Credit given is raised for review.', examples: ['300.00', '0'] },
  { field: 'creditDays', heading: 'Days to pay', aliases: ['creditdays', 'terms', 'paymentdays', 'days'], required: false, help: 'Days after a sale on account that it must be paid. Default 30.', examples: ['30', ''] },
  { field: 'notes', heading: 'Notes', aliases: ['note', 'comments', 'remarks'], required: false, help: 'Optional.', examples: ['', ''] },
];

export interface CustomerRow {
  row: number;
  name: string;
  phone: string | null;
  phoneKey: string | null;
  email: string | null;
  address: string | null;
  idNumber: string | null;
  creditLimit: number;
  creditDays: number;
}

export function parseCustomerRows(rows: Record<string, string>[], headings: string[]): { records: (CustomerRow & { notes: string | null })[]; problems: RowProblem[]; columns: { heading: string; field: CustomerField | null }[] } {
  const { byField, columns, missing } = mapColumns(headings, CUSTOMER_COLUMNS);
  const problems: RowProblem[] = [];
  if (missing.length > 0) return { records: [], problems: [{ row: 1, column: null, message: `The heading row needs: ${missing.map((m) => m.heading).join(', ')}.` }], columns };
  const get = (r: Record<string, string>, f: CustomerField) => String(r[byField.get(f) ?? ''] ?? '').trim();
  const records: (CustomerRow & { notes: string | null })[] = [];
  const phones = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = i + 2;
    if (Object.values(r).every((v) => String(v ?? '').trim() === '')) return;
    const bad: RowProblem[] = [];
    const err = (f: CustomerField, message: string) => bad.push({ row, column: byField.get(f) ?? CUSTOMER_COLUMNS.find((c) => c.field === f)!.heading, message });
    const name = get(r, 'name');
    const phone = get(r, 'phone');
    const email = get(r, 'email');
    const limit = moneyOrBad(get(r, 'creditLimit'));
    const days = daysOrBad(get(r, 'creditDays'));
    if (name.length < 2) err('name', 'The name is missing.');
    if (name.length > 120) err('name', 'The name is longer than 120 characters.');
    const pk = phone === '' ? null : phoneKey(phone);
    if (phone !== '' && (pk === null || pk.length < 7 || pk.length > 15)) err('phone', `"${phone}" is not a phone number.`);
    if (email !== '' && !EMAIL.test(email)) err('email', `"${email}" is not an email address.`);
    if (limit === 'bad') err('creditLimit', `"${get(r, 'creditLimit')}" is not an amount (up to two decimals).`);
    if (days === 'bad') err('creditDays', `"${get(r, 'creditDays')}" is not a number of days from 0 to 365.`);
    if (pk !== null && bad.length === 0) {
      const first = phones.get(pk);
      if (first !== undefined) err('phone', `The same phone as row ${first}: one phone, one customer.`);
      else phones.set(pk, row);
    }
    if (bad.length > 0) {
      problems.push(...bad);
      return;
    }
    records.push({
      row, name, phone: phone || null, phoneKey: pk, email: email || null, address: get(r, 'address') || null, idNumber: get(r, 'idNumber') || null,
      creditLimit: limit === null || limit === 'bad' ? 0 : limit, creditDays: days === null || days === 'bad' ? 30 : days, notes: get(r, 'notes') || null,
    });
  });
  return { records, problems, columns };
}

// ---- suppliers ----------------------------------------------------------------------------------------------------

export type SupplierField = 'name' | 'contactPerson' | 'phone' | 'email' | 'address' | 'tin' | 'terms' | 'creditDays' | 'notes';

export const SUPPLIER_COLUMNS: ColumnSpec<SupplierField>[] = [
  { field: 'name', heading: 'Supplier name', aliases: ['name', 'supplier', 'company', 'companyname', 'vendor'], required: true, help: 'The supplier’s name. Two suppliers cannot share a name.', examples: ['Harvest Foods Ltd', 'Golden Crust Bakery'] },
  { field: 'contactPerson', heading: 'Contact person', aliases: ['contact', 'contactname', 'rep', 'salesrep'], required: false, help: 'Optional.', examples: ['Sales desk', 'Mr Ncube'] },
  { field: 'phone', heading: 'Phone', aliases: ['phonenumber', 'tel', 'telephone', 'mobile', 'cell'], required: false, help: 'Optional.', examples: ['+263 24 270 1111', '0772 000 222'] },
  { field: 'email', heading: 'Email', aliases: ['emailaddress', 'mail'], required: false, help: 'Optional.', examples: ['orders@harvest.example', ''] },
  { field: 'address', heading: 'Address', aliases: ['physicaladdress', 'location'], required: false, help: 'Optional.', examples: ['9 Industrial Road, Harare', ''] },
  { field: 'tin', heading: 'TIN / VAT number', aliases: ['tin', 'vat', 'vatnumber', 'taxnumber', 'bpnumber', 'bp'], required: false, help: 'Their tax number. Two suppliers cannot share one.', examples: ['2000123456', ''] },
  { field: 'terms', heading: 'Terms', aliases: ['paymentterms', 'payment'], required: false, help: 'credit, cash on delivery, or prepaid. Default: credit.', examples: ['credit', 'cash on delivery'] },
  { field: 'creditDays', heading: 'Days to pay', aliases: ['creditdays', 'days', 'paymentdays'], required: false, help: 'For credit terms: days after delivery that payment is due. Default 30.', examples: ['30', ''] },
  { field: 'notes', heading: 'Notes', aliases: ['note', 'comments', 'remarks'], required: false, help: 'Optional.', examples: ['', 'Delivers Tuesdays'] },
];

export interface SupplierRow {
  row: number;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tin: string | null;
  terms: 'credit' | 'cash_on_delivery' | 'prepaid';
  creditDays: number | null;
  notes: string | null;
}

function termsOrBad(v: string): SupplierRow['terms'] | null | 'bad' {
  const t = squash(v);
  if (t === '') return null;
  if (['credit', 'account', 'oncredit', 'onaccount', '30days', 'net30'].includes(t)) return 'credit';
  if (['cashondelivery', 'cod', 'cash', 'ondelivery', 'payondelivery'].includes(t)) return 'cash_on_delivery';
  if (['prepaid', 'prepay', 'upfront', 'payupfront', 'paidupfront', 'inadvance', 'advance', 'payinadvance'].includes(t)) return 'prepaid';
  return 'bad';
}

export function parseSupplierRows(rows: Record<string, string>[], headings: string[]): { records: SupplierRow[]; problems: RowProblem[]; columns: { heading: string; field: SupplierField | null }[] } {
  const { byField, columns, missing } = mapColumns(headings, SUPPLIER_COLUMNS);
  const problems: RowProblem[] = [];
  if (missing.length > 0) return { records: [], problems: [{ row: 1, column: null, message: `The heading row needs: ${missing.map((m) => m.heading).join(', ')}.` }], columns };
  const get = (r: Record<string, string>, f: SupplierField) => String(r[byField.get(f) ?? ''] ?? '').trim();
  const records: SupplierRow[] = [];
  const names = new Map<string, number>();
  const tins = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = i + 2;
    if (Object.values(r).every((v) => String(v ?? '').trim() === '')) return;
    const bad: RowProblem[] = [];
    const err = (f: SupplierField, message: string) => bad.push({ row, column: byField.get(f) ?? SUPPLIER_COLUMNS.find((c) => c.field === f)!.heading, message });
    const name = get(r, 'name');
    const email = get(r, 'email');
    const tin = get(r, 'tin').replace(/\s/g, '');
    const terms = termsOrBad(get(r, 'terms'));
    const days = daysOrBad(get(r, 'creditDays'));
    if (name.length < 2) err('name', 'The supplier name is missing.');
    if (name.length > 120) err('name', 'The name is longer than 120 characters.');
    if (email !== '' && !EMAIL.test(email)) err('email', `"${email}" is not an email address.`);
    if (terms === 'bad') err('terms', `"${get(r, 'terms')}": use credit, cash on delivery or prepaid.`);
    if (days === 'bad') err('creditDays', `"${get(r, 'creditDays')}" is not a number of days from 0 to 365.`);
    if (bad.length === 0) {
      const n = names.get(name.toLowerCase());
      if (n !== undefined) err('name', `The same supplier as row ${n}.`);
      const t = tin === '' ? undefined : tins.get(tin);
      if (t !== undefined) err('tin', `The same tax number as row ${t}.`);
      if (bad.length === 0) {
        names.set(name.toLowerCase(), row);
        if (tin !== '') tins.set(tin, row);
      }
    }
    if (bad.length > 0) {
      problems.push(...bad);
      return;
    }
    const t = terms === null || terms === 'bad' ? 'credit' : terms;
    records.push({
      row, name, contactPerson: get(r, 'contactPerson') || null, phone: get(r, 'phone') || null, email: email || null, address: get(r, 'address') || null,
      tin: tin || null, terms: t, creditDays: t === 'credit' ? (days === null || days === 'bad' ? 30 : days) : null, notes: get(r, 'notes') || null,
    });
  });
  return { records, problems, columns };
}
