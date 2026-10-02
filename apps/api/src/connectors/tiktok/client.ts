import { call, redact, retryAfterSeconds, type CallOptions, type Reply } from '../http.js';
import { ConnectorError } from '../types.js';

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  oauthUrl: string;
  apiUrl: string;
}

const RATE = new Set(['rate_limit_exceeded', 'spam_risk_too_many_posts', 'spam_risk_too_many_pending_share']);
const AUTH = new Set(['access_token_invalid', 'access_token_expired', 'scope_not_authorized', 'scope_permission_missed', 'invalid_grant', 'invalid_client']);
const UNSUPPORTED = new Set(['spam_risk_user_banned_from_posting', 'reached_active_user_cap', 'unaudited_client_can_only_post_to_private_accounts', 'url_ownership_unverified', 'privacy_level_option_mismatch']);
const REJECTED = new Set([
  'invalid_param', 'invalid_file_upload', 'file_format_check_failed', 'duration_check_failed', 'frame_rate_check_failed', 'picture_size_check_failed',
  'video_pull_failed', 'photo_pull_failed', 'invalid_publish_id', 'publish_id_not_found',
]);

/**
 * TikTok answers { data, error: { code, message, log_id } } and says "ok" in error.code when nothing is wrong, sometimes with
 * a success status even when something is. Token failures come as { error, error_description }.
 */
export function classifyTikTok(r: Reply): ConnectorError | null {
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const code = String(typeof body.error === 'object' && body.error ? body.error.code ?? '' : body.error ?? '');
  if (r.ok && (!code || code === 'ok')) return null;
  const message = String((typeof body.error === 'object' && body.error ? body.error.message : body.error_description) ?? `TikTok answered ${r.status}`);
  const opts = { httpStatus: r.status, detail: redact(r.body) };
  if (RATE.has(code) || r.status === 429) return new ConnectorError('rate_limit', message, { ...opts, retryAfterSec: retryAfterSeconds(r.headers) ?? 3600 });
  if (AUTH.has(code) || r.status === 401) return new ConnectorError('auth', `${message} (TikTok no longer accepts this connection)`, opts);
  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    return new ConnectorError('unsupported', `TikTok has not audited this app yet, so it only accepts private posts: ${message}`, opts);
  }
  if (code === 'url_ownership_unverified') {
    return new ConnectorError('unsupported', `TikTok only downloads pictures from a domain verified in its developer portal, and the media domain is not: ${message}`, opts);
  }
  if (UNSUPPORTED.has(code)) return new ConnectorError('unsupported', message, opts);
  if (REJECTED.has(code)) return new ConnectorError('file_rejected', message, opts);
  if (code === 'internal_error' || r.status >= 500) return new ConnectorError('transient', message, opts);
  if (r.status === 400 || r.status === 404 || r.status === 413) return new ConnectorError('file_rejected', message, opts);
  return new ConnectorError('unknown', message, opts);
}

export class TikTokClient {
  constructor(readonly cfg: TikTokConfig) {}

  api(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }

  async request<T = any>(path: string, token: string, o: CallOptions = {}): Promise<T> {
    const r = await call(this.api(path), { ...o, headers: { authorization: `Bearer ${token}`, ...(o.headers ?? {}) } });
    const err = classifyTikTok(r);
    if (err) throw err;
    return r.body;
  }

  async token(form: Record<string, string>): Promise<any> {
    const r = await call(this.api('/v2/oauth/token/'), { method: 'POST', form: { client_key: this.cfg.clientKey, client_secret: this.cfg.clientSecret, ...form } });
    const err = classifyTikTok(r);
    if (err) throw err;
    return r.body;
  }
}
