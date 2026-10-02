import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, hotp, looksLikeRecoveryCode, newRecoveryCode, newSecret, normalizeRecoveryCode, otpauthUrl, stepAt, verifyCode,
} from '../src/auth/totp.js';

// The RFCs' own test secret: the ASCII string "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('matches the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
  });

  it('reads what a person types: lower case, spaces and dashes', () => {
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow(); // 1 is not in the alphabet
  });

  it('makes a 160-bit secret that is different every time', () => {
    const a = newSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(newSecret()).not.toBe(a);
  });
});

describe('the code', () => {
  it('is RFC 4226\'s HOTP for the ten values of its appendix', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('is RFC 6238\'s TOTP at its appendix times (the last six of its eight digits)', () => {
    const cases: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
    for (const [seconds, code] of cases) expect(hotp(RFC_SECRET, stepAt(new Date(seconds * 1000)))).toBe(code);
  });

  it('is accepted at its own time and a step either side, and no further', () => {
    const at = new Date(1234567890 * 1000);
    const code = hotp(RFC_SECRET, stepAt(at));
    expect(verifyCode(RFC_SECRET_B32, code, at)).toBe(stepAt(at));
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() + 30_000))).toBe(stepAt(at));
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() - 30_000))).toBe(stepAt(at));
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() + 60_000))).toBeNull(); // two steps off is too far
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() - 60_000))).toBeNull();
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() + 90_000))).toBeNull();
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() - 90_000))).toBeNull();
  });

  it('works once: a step already used is refused, even within its half-minute', () => {
    const at = new Date(1234567890 * 1000);
    const code = hotp(RFC_SECRET, stepAt(at));
    const step = verifyCode(RFC_SECRET_B32, code, at)!;
    expect(verifyCode(RFC_SECRET_B32, code, at, step)).toBeNull();
    expect(verifyCode(RFC_SECRET_B32, code, new Date(at.getTime() + 20_000), step)).toBeNull();
    // The next code is fine.
    const next = hotp(RFC_SECRET, step + 1);
    expect(verifyCode(RFC_SECRET_B32, next, new Date(at.getTime() + 31_000), step)).toBe(step + 1);
  });

  it('refuses anything that is not six digits, without trying', () => {
    const at = new Date(1234567890 * 1000);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６', '00000a']) expect(verifyCode(RFC_SECRET_B32, bad, at)).toBeNull();
  });

  it('refuses a code made from another secret', () => {
    const at = new Date(1234567890 * 1000);
    const other = newSecret();
    expect(verifyCode(other, hotp(RFC_SECRET, stepAt(at)), at)).toBeNull();
  });
});

describe('what the authenticator app is given', () => {
  it('is an otpauth address with the secret, the issuer and the defaults every app uses', () => {
    const url = new URL(otpauthUrl('ana@example.com', 'Content Studio', RFC_SECRET_B32));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Content Studio:ana@example.com');
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET_B32);
    expect(url.searchParams.get('issuer')).toBe('Content Studio');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('look like K7QD2-M5ZXA, are different each time, and are read without caring for case or the dash', () => {
    const a = newRecoveryCode();
    expect(a).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(newRecoveryCode()).not.toBe(a);
    expect(normalizeRecoveryCode(a.toLowerCase())).toBe(a.replace('-', ''));
    expect(looksLikeRecoveryCode(a)).toBe(true);
    expect(looksLikeRecoveryCode(a.toLowerCase().replace('-', ' '))).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
    expect(looksLikeRecoveryCode('')).toBe(false);
  });
});
