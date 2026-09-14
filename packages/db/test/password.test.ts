/**
 * Password policy and hashing.
 *
 * These exist because the first version of `checkPasswordStrength` compared
 * only the whole normalised string against its banned list, so "password" was
 * refused while "password12" was accepted. That is the shape nearly every weak
 * password takes, and nothing caught it until a real one was set by hand.
 */

import { describe, expect, it } from 'vitest';

import {
  checkPasswordStrength,
  generateTemporaryPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/password.js';

const EMAIL = 'admin@retailops.local';

describe('password policy', () => {
  it('rejects a banned word with digits appended', () => {
    // The exact failure that got through: the product name plus 1234.
    for (const weak of ['retail@1234', 'retail1234', 'Retail@1234', 'password12', 'Welcome2026']) {
      const result = checkPasswordStrength(weak, EMAIL);
      expect(result.ok, `${weak} should be refused`).toBe(false);
    }
  });

  it('rejects a password built mostly from the system name', () => {
    expect(checkPasswordStrength('retailops1', EMAIL).ok).toBe(false);
    expect(checkPasswordStrength('myretailops', EMAIL).ok).toBe(false);
  });

  it('rejects predictable keyboard and counting runs', () => {
    expect(checkPasswordStrength('helm1234port', EMAIL).ok).toBe(false);
    expect(checkPasswordStrength('zebraqwertyfig', EMAIL).ok).toBe(false);
  });

  it('rejects anything containing the account email or organisation', () => {
    expect(checkPasswordStrength('admin-tractor-9', EMAIL).ok).toBe(false);
    expect(checkPasswordStrength('retailops-tractor', EMAIL).ok).toBe(false);
  });

  it('rejects short and repetitive passwords', () => {
    expect(checkPasswordStrength('short1', EMAIL).ok).toBe(false);
    expect(checkPasswordStrength('aaaaaaaaaa', EMAIL).ok).toBe(false);
  });

  it('accepts long unpredictable passwords', () => {
    for (const good of [
      'Gwelutshena-Ledger-88',
      'Kana-Mission-2026',
      'purple tractor mango',
      'tnu2-HTgt-k2dWtN',
    ]) {
      const result = checkPasswordStrength(good, EMAIL);
      expect(result.ok, `${good} should be accepted`).toBe(true);
    }
  });

  it('accepts every generated temporary password', () => {
    // An administrator handing out a password the system would then refuse
    // would be a maddening bug to hit in front of a branch manager.
    for (let i = 0; i < 200; i += 1) {
      const generated = generateTemporaryPassword();
      expect(checkPasswordStrength(generated, EMAIL).ok, generated).toBe(true);
    }
  });
});

describe('password hashing', () => {
  it('verifies a correct password and refuses a wrong one', async () => {
    const hash = await hashPassword('Gwelutshena-Ledger-88');
    expect(await verifyPassword('Gwelutshena-Ledger-88', hash)).toBe(true);
    expect(await verifyPassword('Gwelutshena-Ledger-89', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('purple tractor mango');
    const b = await hashPassword('purple tractor mango');
    expect(a).not.toBe(b);
    expect(await verifyPassword('purple tractor mango', a)).toBe(true);
    expect(await verifyPassword('purple tractor mango', b)).toBe(true);
  });

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('purple tractor mango');
    expect(hash).not.toContain('purple');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('fails closed on a malformed or tampered stored hash', async () => {
    // A corrupt row must refuse the login, not crash the route.
    for (const broken of ['', 'not-a-hash', 'scrypt$bad$8$1$AAAA$AAAA', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything at all', broken)).toBe(false);
    }
  });

  it('refuses absurd stored parameters rather than exhausting memory', async () => {
    const hostile = `scrypt$99999999$99$99$${Buffer.from('salt').toString('base64')}$AAAA`;
    expect(await verifyPassword('anything at all', hostile)).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', async () => {
    expect(needsRehash(await hashPassword('purple tractor mango'))).toBe(false);
    expect(needsRehash('scrypt$16384$8$1$AAAA$AAAA')).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });
});
