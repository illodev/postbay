import { createHmac, timingSafeEqual } from 'node:crypto';

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks that a delivery comes from the studio: the signature is HMAC-SHA256 over "<timestamp>.<body>" with the webhook's
 * secret, and the timestamp has to be recent, so a captured delivery cannot be replayed later. Any of the secrets may
 * match (for the minutes while one is being replaced by another).
 */
export function verifySignature(
  secrets: string[],
  headers: Record<string, string | string[] | undefined>,
  body: string,
  nowMs: number,
  toleranceSeconds = 300,
): Verdict {
  const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
  const timestamp = one(headers['x-studio-timestamp']);
  const signature = one(headers['x-studio-signature']);
  if (!timestamp || !signature) return { ok: false, reason: 'missing signature headers' };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'timestamp too old or too far ahead' };
  const given = /^v1=([0-9a-f]{64})$/.exec(signature)?.[1];
  if (!given) return { ok: false, reason: 'bad signature format' };
  const givenBuf = Buffer.from(given, 'hex');
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
    if (timingSafeEqual(expected, givenBuf)) return { ok: true };
  }
  return { ok: false, reason: 'signature does not match' };
}
