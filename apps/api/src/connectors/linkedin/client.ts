import { DateTime } from 'luxon';
import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  oauthUrl: string;
  tokenUrl: string;
  apiUrl: string;
  /** YYYYMM. Each version of the API lives about a year, and a request names the one it was written for. */
  version: string;
}

/** LinkedIn's call limits are per day (UTC), so that is when a limit that was hit is worth trying again. */
const secondsToMidnightUtc = (now = new Date()) =>
  Math.max(300, Math.ceil(DateTime.fromJSDate(now, { zone: 'utc' }).plus({ days: 1 }).startOf('day').diff(DateTime.fromJSDate(now, { zone: 'utc' }), 'seconds').seconds) + 60);

/** LinkedIn words failures as { status, code, message, serviceErrorCode }; token failures as { error, error_description }. */
export function classifyLinkedIn(r: Reply): ConnectorError | null {
  if (r.ok) return null;
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const message = String(body.message ?? body.error_description ?? body.error ?? `LinkedIn answered ${r.status}`);
  const opts = { httpStatus: r.status, detail: redact(r.body) };
  // A retired API version is ours to fix (LINKEDIN_VERSION), and retrying changes nothing: a person publishes this one.
  if (r.status === 426 || body.code === 'NONEXISTENT_VERSION') {
    return new ConnectorError('unsupported', `LinkedIn no longer accepts the API version this app is set to use (${message}). An administrator of the server has to set LINKEDIN_VERSION to a current one.`, opts);
  }
  if (r.status === 429) return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: retryAfterSeconds(r.headers) ?? secondsToMidnightUtc() });
  if (r.status === 401 || body.error === 'invalid_grant' || body.error === 'invalid_client' || body.serviceErrorCode === 65601 || body.serviceErrorCode === 65600) {
    return new ConnectorError('auth', `${message} (LinkedIn no longer accepts this connection)`, opts);
  }
  // 403 is a missing permission or product: nothing here will fix it by waiting.
  if (r.status === 403) return new ConnectorError('auth', `${message} (LinkedIn says this app or account is not allowed to do that)`, opts);
  if (r.status >= 500) return new ConnectorError('transient', message, opts);
  // A repeated post is refused with the address of the original in the message.
  const dup = /duplicate of (urn:li:\w+:\d+)/i.exec(message);
  if (dup) return new ConnectorError('file_rejected', message, { ...opts, detail: { ...(opts.detail as object), duplicateOf: dup[1] } });
  if (r.status === 400 || r.status === 404 || r.status === 409 || r.status === 413 || r.status === 422) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

export const duplicateOf = (err: unknown): string | undefined =>
  err instanceof ConnectorError ? (err.detail as { duplicateOf?: string } | undefined)?.duplicateOf : undefined;

export const urn = (s: string) => encodeURIComponent(s);

export class LinkedInClient {
  constructor(readonly cfg: LinkedInConfig) {}

  api(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }

  headers(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'linkedin-version': this.cfg.version, 'x-restli-protocol-version': '2.0.0' };
  }

  async request(path: string, token: string, o: CallOptions = {}): Promise<Reply> {
    const r = await call(this.api(path), { ...o, headers: { ...this.headers(token), ...(o.headers ?? {}) } });
    const err = classifyLinkedIn(r);
    if (err) throw err;
    return r;
  }

  async token(form: Record<string, string>): Promise<any> {
    const r = await call(this.cfg.tokenUrl, { method: 'POST', form: { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...form } });
    const err = classifyLinkedIn(r);
    if (err) throw err;
    return r.body;
  }
}
