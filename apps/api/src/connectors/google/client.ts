import { DateTime } from 'luxon';
import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  oauthUrl: string;
  tokenUrl: string;
  apiUrl: string;
}

/** YouTube's daily quota resets at midnight Pacific Time, so that is when a quota failure is worth retrying. */
export function secondsUntilQuotaReset(now = new Date()): number {
  const pt = DateTime.fromJSDate(now, { zone: 'America/Los_Angeles' });
  return Math.max(60, Math.ceil(pt.plus({ days: 1 }).startOf('day').diff(pt, 'seconds').seconds) + 60);
}

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded']);
const RATE = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const AUTH = new Set(['authError', 'forbidden', 'insufficientPermissions', 'youtubeSignupRequired', 'insufficientPermissions', 'unauthorized']);
const BLOCKED = new Set(['channelClosed', 'channelSuspended', 'channelNotFound']);

/** Google words API failures as { error: { code, message, errors: [{ reason }] } } and token failures as { error: "invalid_grant" }. */
export function classifyGoogle(r: Reply): ConnectorError | null {
  if (r.ok) return null;
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const detail = redact(r.body);
  const opts = { httpStatus: r.status, detail };

  // Token endpoint
  if (typeof body.error === 'string') {
    const msg = body.error_description || body.error;
    if (['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token'].includes(body.error)) {
      return new ConnectorError('auth', `Google no longer accepts this connection (${msg})`, opts);
    }
    return new ConnectorError(r.status >= 500 ? 'transient' : 'unknown', msg, opts);
  }

  const e = (body.error ?? {}) as { message?: string; errors?: { reason?: string }[]; status?: string };
  const reason = e.errors?.[0]?.reason ?? '';
  const message = e.message || `Google answered ${r.status}`;
  if (QUOTA.has(reason)) return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: secondsUntilQuotaReset() });
  if (RATE.has(reason) || r.status === 429) return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: retryAfterSeconds(r.headers) ?? 120 });
  if (r.status === 401 || AUTH.has(reason)) return new ConnectorError('auth', `${message} (Google no longer accepts this connection)`, opts);
  if (BLOCKED.has(reason)) return new ConnectorError('unsupported', message, opts);
  if (r.status >= 500) return new ConnectorError('transient', message, opts);
  if (r.status === 400 || r.status === 404 || r.status === 409) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

/** The YouTube Data API, with the bearer token added and failures turned into classified errors. */
export class GoogleClient {
  constructor(readonly cfg: GoogleConfig) {}

  api(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }

  async request(path: string, token: string, o: CallOptions = {}): Promise<Reply> {
    const r = await call(this.api(path), { ...o, headers: { authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
    const err = classifyGoogle(r);
    if (err) throw err;
    return r;
  }

  async delete(path: string, token: string, query: CallOptions['query'] = {}): Promise<void> {
    await this.request(path, token, { method: 'DELETE', query });
  }

  async get<T = any>(path: string, token: string, query: CallOptions['query'] = {}): Promise<T> {
    return (await this.request(path, token, { query })).body;
  }
}
