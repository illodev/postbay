import { createHash } from 'node:crypto';
import type { NetPolicy } from '../../net.js';
import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface BlueskyConfig {
  /** The server accounts live on when a person does not say otherwise. */
  pdsUrl: string;
  /** Where videos are processed. */
  videoUrl: string;
  /**
   * The rules for a server a person typed instead of the configured one (webhooks' rules, net.ts): https, a public address unless
   * private networks are allowed, no redirects. The configured servers are the deployment's own choice and are not held to it.
   */
  policy?: NetPolicy;
}

/** A did:web for a host, as the video service and the servers name each other (a port's colon is written %3A). */
export const didWebOf = (url: string) => `did:web:${new URL(url).host.replace(':', '%3A')}`;

/** Where the account's repository really lives, from a DID document: its #atproto_pds service. */
export function pdsEndpointOf(didDoc: unknown): string | undefined {
  const services = (didDoc as { service?: { id?: string; type?: string; serviceEndpoint?: unknown }[] } | undefined)?.service;
  const pds = services?.find((s) => s.id === '#atproto_pds' || s.id?.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer');
  return typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint : undefined;
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';

/**
 * A record key in the shape Bluesky expects for posts (a TID: microseconds since 1970 and a 10-bit clock id, in a base32 that
 * sorts). Made from a moment and a seed so the same post gets the same key every time it is tried: a step repeated after a lost
 * answer writes the same record instead of a second post. The seed also spreads posts made for the same minute apart.
 */
export function tidFor(at: Date, seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  const jitterMicros = BigInt(h.readUInt32BE(0) % 1_000_000);
  const clockId = BigInt(h.readUInt16BE(4) & 1023);
  let v = ((BigInt(at.getTime()) * 1000n + jitterMicros) << 10n) | clockId;
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = S32[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

/** The expiry of a session token, which is a JWT. */
export function jwtExpiry(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** Bluesky words its failures as { error: "ExpiredToken", message }. */
export function classifyBluesky(r: Reply): ConnectorError | null {
  if (r.ok) return null;
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const code = String(body.error ?? '');
  const message = String(body.message ?? `Bluesky answered ${r.status}`);
  const opts = { httpStatus: r.status, detail: redact(r.body) };
  if (r.status === 429 || code === 'RateLimitExceeded') {
    const reset = Number(r.headers.get('ratelimit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.max(30, Math.ceil(reset - Date.now() / 1000)) : retryAfterSeconds(r.headers) ?? 600;
    return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: wait });
  }
  // A token that ran out between our clock and theirs is renewed on the next look: not a lost connection.
  if (code === 'ExpiredToken') return new ConnectorError('transient', message, opts);
  if (r.status === 401 || ['InvalidToken', 'AuthenticationRequired', 'AccountTakedown', 'AccountDeactivated', 'Forbidden'].includes(code) || r.status === 403) {
    return new ConnectorError('auth', `${message} (Bluesky no longer accepts this connection)`, opts);
  }
  if (r.status >= 500) return new ConnectorError('transient', message, opts);
  if (r.status === 400 || r.status === 404 || r.status === 413) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** XRPC calls to an account's server (and to the video service), with the session token added and failures classified. */
export class BlueskyClient {
  constructor(readonly cfg: BlueskyConfig) {}

  /** A server this deployment chose (the default server, the video service), as opposed to one a person typed. */
  configured(base: string): boolean {
    return [this.cfg.pdsUrl, this.cfg.videoUrl].some((c) => originOf(c) === originOf(base));
  }

  async xrpc<T = any>(base: string, nsid: string, o: CallOptions & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = o;
    const r = await call(`${base.replace(/\/$/, '')}/xrpc/${nsid}`, {
      method: o.json !== undefined || o.body ? 'POST' : 'GET',
      ...rest,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.headers ?? {}) },
      ...(this.configured(base) ? {} : { guard: this.cfg.policy ?? { allowPrivate: false, httpsForPublic: true } }),
    });
    const err = classifyBluesky(r);
    if (err) throw err;
    return r.body;
  }
}
