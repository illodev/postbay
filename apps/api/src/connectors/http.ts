import { ConnectorError } from './types.js';

export interface Reply {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON when the body is JSON, the text otherwise, null when empty. */
  body: any;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string | number | boolean | undefined>;
  body?: BodyInit | null;
  duplex?: 'half';
  timeoutMs?: number;
}

/**
 * One HTTP call. A reply with an error status is returned for the connector to read (each network words its errors its own
 * way); only a call that never got an answer (no connection, a timeout) throws, as a transient failure.
 */
export async function call(url: string, o: CallOptions = {}): Promise<Reply> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: BodyInit | null | undefined = o.body;
  if (o.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(o.form)) if (v !== undefined) f.set(k, String(v));
    body = f.toString();
  }
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(u, { method: o.method ?? 'GET', headers, body, signal: timeout, ...(o.duplex ? { duplex: o.duplex } : {}) } as RequestInit);
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : `could not connect (${(err as Error).message})`;
    throw new ConnectorError('transient', `${u.host} ${reason}`, { detail: { url: redactUrl(u.toString()) } });
  }
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, ok: res.ok, headers: res.headers, body: parsed };
}

const SECRET_KEY = /token|secret|authorization|password|code_verifier|^code$/i;
const SECRET_PARAM = /(access_token|client_secret|fb_exchange_token|refresh_token|input_token)=[^&\s"]+/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAM, '$1=[removed]');
}

/** A copy of a network's answer that is safe to store and show: no tokens, no secrets, no signed query strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redactUrl(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[removed]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function retryAfterSeconds(headers: Headers): number | undefined {
  const h = headers.get('retry-after');
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
