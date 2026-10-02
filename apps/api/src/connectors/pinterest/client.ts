import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface PinterestConfig {
  appId: string;
  appSecret: string;
  oauthUrl: string;
  apiUrl: string;
}

/** Pinterest words failures as { code, message }; token failures the same way, sometimes with { error }. */
export function classifyPinterest(r: Reply): ConnectorError | null {
  if (r.ok) return null;
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const message = String(body.message ?? body.error_description ?? body.error ?? `Pinterest answered ${r.status}`);
  const opts = { httpStatus: r.status, detail: redact(r.body) };
  if (r.status === 429) {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: retryAfterSeconds(r.headers) ?? (Number.isFinite(reset) && reset > 0 ? reset : 900) });
  }
  if (r.status === 401 || body.error === 'invalid_grant' || body.error === 'invalid_client') {
    return new ConnectorError('auth', `${message} (Pinterest no longer accepts this connection)`, opts);
  }
  if (r.status === 403) return new ConnectorError('auth', `${message} (Pinterest says this app or account is not allowed to do that)`, opts);
  if (r.status >= 500) return new ConnectorError('transient', message, opts);
  if (r.status === 400 || r.status === 404 || r.status === 409 || r.status === 413 || r.status === 422) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

export class PinterestClient {
  constructor(readonly cfg: PinterestConfig) {}

  api(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }

  async request<T = any>(path: string, token: string, o: CallOptions = {}): Promise<T> {
    const r = await call(this.api(path), { ...o, headers: { authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
    const err = classifyPinterest(r);
    if (err) throw err;
    return r.body;
  }

  /** The token endpoint: the app identifies itself with its id and secret. */
  async token(form: Record<string, string>): Promise<any> {
    const basic = Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString('base64');
    const r = await call(this.api('/v5/oauth/token'), { method: 'POST', form, headers: { authorization: `Basic ${basic}` } });
    const err = classifyPinterest(r);
    if (err) throw err;
    return r.body;
  }
}
