import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time codes from an authenticator app: TOTP (RFC 6238) over HMAC-SHA1 with 30-second steps and six digits, the settings
 * every authenticator app uses by default. Written out here so the sign-in has no dependency to keep up to date.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const DIGITS = 6;

/** RFC 4648 base32, without padding: how authenticator apps take a secret typed by hand. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, as the base32 text a person would type. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** RFC 4226's HOTP for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

/**
 * The step a code is good for, or null. The step before and the one after are accepted too, for clocks that are a little off. A
 * step at or before `lastStep` is refused, so the same code cannot be used twice, even within its half-minute.
 */
export function verifyCode(secretBase32: string, code: string, now: Date, lastStep = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepAt(now);
  let found: number | null = null;
  // Every candidate is compared, whatever the first answer, so the time taken says nothing about which one matched.
  for (const step of [current - 1, current, current + 1]) {
    const a = Buffer.from(hotp(secret, step));
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b) && step > lastStep) found = found === null || step > found ? step : found;
  }
  return found;
}

/** The address an authenticator app reads (from a QR code, or by tapping it on the phone itself). */
export function otpauthUrl(account: string, issuer: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** A one-time recovery code, like `K7QD2-M5ZXA`: ten letters and digits, easy to read out and write down. */
export function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** What is compared and hashed: case and dashes do not matter when a person types one. */
export const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const looksLikeRecoveryCode = (code: string) => /^[A-Z2-7]{10}$/.test(normalizeRecoveryCode(code));
