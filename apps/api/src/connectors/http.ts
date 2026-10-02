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

/** One exchange with a network, as the self-check records it: what was asked and answered, with every secret removed. */
export interface Exchange {
  at: string;
  method: string;
  url: string;
  status: number | null;
  ms: number;
  request?: unknown;
  response?: unknown;
  error?: string;
}

let tap: ((e: Exchange) => void) | null = null;
/** Whoever sets a tap sees every call this process makes, until it sets null. Only the self-check does, to record a real run. */
export function setTap(fn: ((e: Exchange) => void) | null): void {
  tap = fn;
}

/**
 * A body is recorded only if it is small and not a file: a transcript is for reading, not for replaying. Secrets are removed, and an
 * address inside it loses its query string, because that is where a signed upload or download address keeps its signature.
 */
function recordable(value: unknown): unknown {
  const r = JSON.parse(JSON.stringify(redact(value)) ?? 'null', (_k, v) => {
    if (typeof v !== 'string' || !/^https?:\/\/\S+$/.test(v)) return v;
    const q = v.indexOf('?');
    return q === -1 ? v : `${v.slice(0, q)}?[query removed]`;
  });
  const text = JSON.stringify(r);
  return text && text.length > 6000 ? `${text.slice(0, 6000)}…[cut]` : r;
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
  const started = Date.now();
  const record = (e: Partial<Exchange>) => {
    if (!tap) return;
    try {
      const requestBody = o.json !== undefined ? o.json : o.form ?? (typeof body === 'string' ? body : body ? '[a file or a stream]' : undefined);
      tap({ at: new Date(started).toISOString(), method: o.method ?? 'GET', url: redactUrl(u.toString()), status: null, ms: Date.now() - started, request: requestBody === undefined ? undefined : recordable(requestBody), ...e });
    } catch {
      // Recording must never change what a call does.
    }
  };
  let res: Response;
  try {
    res = await fetch(u, { method: o.method ?? 'GET', headers, body, signal: timeout, ...(o.duplex ? { duplex: o.duplex } : {}) } as RequestInit);
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : `could not connect (${(err as Error).message})`;
    record({ error: `${u.host} ${reason}` });
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
  record({ status: res.status, response: parsed === null ? undefined : recordable(parsed) });
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
