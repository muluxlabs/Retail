import { describe, expect, it } from 'vitest';

import { checkCredit, CreditLimitExceeded } from '../src/index.js';

describe('charging a sale to a customer account', () => {
  it('allows a charge up to the limit exactly', () => {
    expect(() => checkCredit('Mai Tendai', 30_000, 50_000, 20_000)).not.toThrow();
  });

  it('refuses a charge one cent over, saying how much room is left', () => {
    try {
      checkCredit('Mai Tendai', 30_000, 50_000, 20_001);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(CreditLimitExceeded);
      const err = e as CreditLimitExceeded;
      expect(err.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect(err.detail).toMatchObject({ owed: 300, limit: 500, available: 200, charge: 200.01 });
      expect(err.message).toContain('at most 200.00 more');
    }
  });

  it('a customer with no credit limit is cash only', () => {
    expect(() => checkCredit('Cash Only', 0, 0, 100)).toThrow(/not allowed credit/);
  });

  it('a customer already over their limit (it was lowered) can still pay cash: nothing charged, nothing refused', () => {
    expect(() => checkCredit('Over', 60_000, 50_000, 0)).not.toThrow();
  });
});
