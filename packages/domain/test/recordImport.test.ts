import { describe, expect, it } from 'vitest';

import { mapColumns, parseCustomerRows, parseSupplierRows, phoneKey, SUPPLIER_COLUMNS } from '../src/index.js';

describe('customer rows', () => {
  const H = ['Name', 'Phone', 'Credit limit', 'Days to pay'];
  it('reads a customer, defaults to cash only and 30 days', () => {
    const r = parseCustomerRows([{ Name: 'Mai Rudo Tuckshop', Phone: '0772 555 101', 'Credit limit': '', 'Days to pay': '' }], H);
    expect(r.problems).toEqual([]);
    expect(r.records[0]).toMatchObject({ name: 'Mai Rudo Tuckshop', phone: '0772 555 101', phoneKey: '263772555101', creditLimit: 0, creditDays: 30 });
  });

  it('treats 0772…, +263 772… and 00263 772… as one phone', () => {
    expect(phoneKey('0772 555 101')).toBe(phoneKey('+263 772-555-101'));
    expect(phoneKey('00263772555101')).toBe('263772555101');
  });

  it('refuses the same phone twice in one file, and bad values, by row and column', () => {
    const r = parseCustomerRows(
      [
        { Name: 'A Moyo', Phone: '0772 111 222', 'Credit limit': '100', 'Days to pay': '30' },
        { Name: 'B Moyo', Phone: '+263772111222', 'Credit limit': '', 'Days to pay': '' },
        { Name: 'C Dube', Phone: 'call me', 'Credit limit': '1.234', 'Days to pay': '400' },
        { Name: '', Phone: '', 'Credit limit': '', 'Days to pay': '' },
        { Name: 'X', Phone: '', 'Credit limit': '', 'Days to pay': '' },
      ],
      H,
    );
    expect(r.records.map((x) => x.name)).toEqual(['A Moyo']);
    expect(r.problems.map((p) => [p.row, p.column])).toEqual([
      [3, 'Phone'],
      [4, 'Phone'],
      [4, 'Credit limit'],
      [4, 'Days to pay'],
      [6, 'Name'],
    ]);
  });

  it('understands other headings, and says which are missing', () => {
    const r = parseCustomerRows([{ 'Customer Name': 'Tendai', Mobile: '0773 000 111' }], ['Customer Name', 'Mobile']);
    expect(r.records[0]).toMatchObject({ name: 'Tendai', phone: '0773 000 111' });
    expect(parseCustomerRows([{ Colour: 'red' }], ['Colour']).problems[0]!.message).toContain('Name');
  });
});

describe('supplier rows', () => {
  const H = ['Supplier name', 'TIN / VAT number', 'Terms', 'Days to pay'];
  it('reads terms in the words people use', () => {
    const r = parseSupplierRows(
      [
        { 'Supplier name': 'Harvest Foods', 'TIN / VAT number': '2000 123 456', Terms: 'Credit', 'Days to pay': '45' },
        { 'Supplier name': 'Golden Crust', 'TIN / VAT number': '', Terms: 'COD', 'Days to pay': '' },
        { 'Supplier name': 'Crystal Beverages', 'TIN / VAT number': '', Terms: 'pay upfront', 'Days to pay': '' },
        { 'Supplier name': 'Delta', 'TIN / VAT number': '', Terms: '', 'Days to pay': '' },
      ],
      H,
    );
    expect(r.problems).toEqual([]);
    expect(r.records.map((x) => [x.terms, x.creditDays, x.tin])).toEqual([
      ['credit', 45, '2000123456'],
      ['cash_on_delivery', null, null],
      ['prepaid', null, null],
      ['credit', 30, null],
    ]);
  });

  it('refuses the same supplier or tax number twice, and unknown terms', () => {
    const r = parseSupplierRows(
      [
        { 'Supplier name': 'Harvest Foods', 'TIN / VAT number': '111', Terms: '', 'Days to pay': '' },
        { 'Supplier name': 'HARVEST FOODS', 'TIN / VAT number': '', Terms: '', 'Days to pay': '' },
        { 'Supplier name': 'Other Foods', 'TIN / VAT number': '111', Terms: '', 'Days to pay': '' },
        { 'Supplier name': 'Weird Terms', 'TIN / VAT number': '', Terms: 'when we feel like it', 'Days to pay': '' },
      ],
      H,
    );
    expect(r.records.map((x) => x.name)).toEqual(['Harvest Foods']);
    expect(r.problems.map((p) => [p.row, p.column])).toEqual([
      [3, 'Supplier name'],
      [4, 'TIN / VAT number'],
      [5, 'Terms'],
    ]);
  });

  it('maps headings loosely', () => {
    const m = mapColumns(['Vendor', 'VAT', 'Payment terms', 'Colour'], SUPPLIER_COLUMNS);
    expect(m.byField.get('name')).toBe('Vendor');
    expect(m.byField.get('tin')).toBe('VAT');
    expect(m.byField.get('terms')).toBe('Payment terms');
    expect(m.columns.find((c) => c.heading === 'Colour')!.field).toBeNull();
  });
});
