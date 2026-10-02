import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface BlueskyConfig {
  /** The server accounts live on when a person does not say otherwise. */
  pdsUrl: string;
  /** Where videos are processed. */
  videoUrl: string;
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

/** XRPC calls to an account's server (and to the video service), with the session token added and failures classified. */
export class BlueskyClient {
  constructor(readonly cfg: BlueskyConfig) {}

  async xrpc<T = any>(base: string, nsid: string, o: CallOptions & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = o;
    const r = await call(`${base.replace(/\/$/, '')}/xrpc/${nsid}`, {
      method: o.json !== undefined || o.body ? 'POST' : 'GET',
      ...rest,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.headers ?? {}) },
    });
    const err = classifyBluesky(r);
    if (err) throw err;
    return r.body;
  }
}
