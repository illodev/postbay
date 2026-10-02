import { call, redact, retryAfterSeconds, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface MetaConfig {
  graphUrl: string;
  oauthUrl: string;
  version: string;
  appId: string;
  appSecret: string;
}

/** Meta words its failures as { error: { code, error_subcode, message, is_transient } }. */
export function classifyMeta(r: Reply): ConnectorError | null {
  const bodyError = r.body && typeof r.body === 'object' ? r.body.error : undefined;
  if (r.ok && !bodyError) return null;
  const e = (bodyError ?? {}) as { code?: number; error_subcode?: number; message?: string; error_user_msg?: string; is_transient?: boolean };
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const message = e.error_user_msg || e.message || `Meta answered ${r.status}`;
  const detail = redact(r.body);
  const opts = { httpStatus: r.status, detail };

  if (code === 190 || code === 102 || code === 10 || (code >= 200 && code <= 299) || r.status === 401) {
    return new ConnectorError('auth', `${message} (Meta no longer accepts this connection)`, opts);
  }
  // Business-use-case and app-level limits, and Instagram's own daily publishing cap.
  if ([4, 9, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014) || sub === 2207042) {
    return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: regainSeconds(r) ?? retryAfterSeconds(r.headers) ?? 900 });
  }
  // "Media not ready yet" and its kin come back as errors but succeed on a later try.
  if (e.is_transient === true || code === 1 || code === 2 || sub === 2207027 || r.status >= 500) {
    return new ConnectorError('transient', message, opts);
  }
  if (code === 100 || code === 368 || r.status === 400 || r.status === 404) {
    return new ConnectorError('file_rejected', message, opts);
  }
  return new ConnectorError('unknown', message, opts);
}

/** x-business-use-case-usage says, per object, how many minutes until access comes back. */
function regainSeconds(r: Reply): number | undefined {
  const raw = r.headers.get('x-business-use-case-usage');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, { estimated_time_to_regain_access?: number }[]>;
    const mins = Object.values(parsed).flat().map((u) => u.estimated_time_to_regain_access ?? 0);
    const max = Math.max(0, ...mins);
    return max > 0 ? max * 60 : undefined;
  } catch {
    return undefined;
  }
}

/** The Graph API, with the access token added to every call and failures turned into classified errors. */
export class MetaClient {
  constructor(readonly cfg: MetaConfig) {}

  url(path: string): string {
    return `${this.cfg.graphUrl}/${this.cfg.version}/${path.replace(/^\//, '')}`;
  }

  private check(r: Reply): any {
    const err = classifyMeta(r);
    if (err) throw err;
    return r.body;
  }

  async get<T = any>(path: string, token: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.check(await call(this.url(path), { query: { ...query, access_token: token } }));
  }

  async post<T = any>(path: string, token: string, form: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.check(await call(this.url(path), { method: 'POST', form: { ...form, access_token: token } }));
  }

  /** The messaging endpoints take their arguments as JSON (a recipient object, a message object), not as a form. */
  async postJson<T = any>(path: string, token: string, json: unknown): Promise<T> {
    return this.check(await call(this.url(path), { method: 'POST', json, query: { access_token: token } }));
  }

  async delete<T = any>(path: string, token: string): Promise<T> {
    return this.check(await call(this.url(path), { method: 'DELETE', query: { access_token: token } }));
  }

  /** A call to some other address Meta handed back (a Reels upload URL), authorised the way their upload hosts want. */
  async raw(url: string, token: string, headers: Record<string, string>): Promise<any> {
    return this.check(await call(url, { method: 'POST', headers: { authorization: `OAuth ${token}`, ...headers } }));
  }
}
