import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface XConfig {
  clientId: string;
  clientSecret: string;
  oauthUrl: string;
  apiUrl: string;
}

/** X words failures as { title, detail, type, status } or { errors: [{ code, message }] }; token failures as { error, error_description }. */
export function classifyX(r: Reply): ConnectorError | null {
  if (r.ok) return null;
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const message = String(body.detail ?? body.error_description ?? body.errors?.[0]?.message ?? body.title ?? body.error ?? `X answered ${r.status}`);
  const title = String(body.title ?? body.type ?? body.error ?? '');
  const opts = { httpStatus: r.status, detail: redact(r.body) };
  if (r.status === 429) {
    const reset = Number(r.headers.get('x-rate-limit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.max(30, Math.ceil(reset - Date.now() / 1000)) : retryAfterSeconds(r.headers) ?? 900;
    return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: wait });
  }
  // X is pay-per-use: with the balance gone every call is refused until someone tops it up, which is not a lost connection.
  if (r.status === 402 || /credits|usagecap|payment/i.test(title) || /credits|usage cap/i.test(message)) {
    return new ConnectorError('unsupported', `X refused the call because the account has no credit left: ${message}. Top up the balance in the X developer console.`, opts);
  }
  if (r.status === 401 || body.error === 'invalid_grant' || body.error === 'invalid_token' || body.error === 'invalid_client') {
    return new ConnectorError('auth', `${message} (X no longer accepts this connection)`, opts);
  }
  if (r.status >= 500) return new ConnectorError('transient', message, opts);
  if (r.status === 403 && /duplicate/i.test(message)) return new ConnectorError('file_rejected', message, { ...opts, detail: { ...(opts.detail as object), duplicate: true } });
  if (r.status === 403) return new ConnectorError('auth', `${message} (X says this app is not allowed to do that)`, opts);
  if (r.status === 400 || r.status === 404 || r.status === 413 || r.status === 422) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

export const isDuplicate = (err: unknown) => err instanceof ConnectorError && (err.detail as { duplicate?: boolean } | undefined)?.duplicate === true;

export class XClient {
  constructor(readonly cfg: XConfig) {}

  api(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }

  async request<T = any>(path: string, token: string, o: CallOptions = {}): Promise<T> {
    const r = await call(this.api(path), { ...o, headers: { authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
    const err = classifyX(r);
    if (err) throw err;
    return r.body;
  }

  /** The token endpoint: a confidential app identifies itself with its id and secret. */
  async token(form: Record<string, string>): Promise<any> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const r = await call(this.api('/2/oauth2/token'), { method: 'POST', form, headers: { authorization: `Basic ${basic}` } });
    const err = classifyX(r);
    if (err) throw err;
    return r.body;
  }
}
