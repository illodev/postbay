import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { PolicyError, refusal, type NetPolicy } from '../net.js';
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
  /**
   * For an address a person typed (a Bluesky server of their own) rather than one this deployment configured: the call is made only
   * to an address the policy allows (checked after the name is resolved, at the moment of connecting), redirects are not followed,
   * and the body has to be in memory. The same rules as the webhooks' (net.ts).
   */
  guard?: NetPolicy;
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
    res = o.guard
      ? await guardedFetch(u, { method: o.method ?? 'GET', headers, body, timeoutMs: o.timeoutMs ?? 60_000 }, o.guard)
      : await fetch(u, { method: o.method ?? 'GET', headers, body, signal: timeout, ...(o.duplex ? { duplex: o.duplex } : {}) } as RequestInit);
  } catch (err) {
    if (err instanceof PolicyError) {
      record({ error: `${u.host} refused: ${err.message}` });
      throw new ConnectorError('unsupported', `This server will not connect to ${u.host}: ${err.message}`, { detail: { url: redactUrl(u.toString()) } });
    }
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : `could not connect (${(err as Error).message})`;
    record({ error: `${u.host} ${reason}` });
    throw new ConnectorError('transient', `${u.host} ${reason}`, { detail: { url: redactUrl(u.toString()) } });
  }
  if (o.guard && res.status >= 300 && res.status < 400) {
    record({ status: res.status, error: 'redirect not followed' });
    throw new ConnectorError('unsupported', `${u.host} answered with a redirect (${res.status}), which this server does not follow for an address a person typed`, { httpStatus: res.status });
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

const GUARDED_MAX_BYTES = 16 * 1024 * 1024;

/**
 * fetch() for an address a person typed: node's own client, so the resolved address can be checked when connecting (a name that
 * points somewhere else a moment later does not get past it), no redirects, and an answer of bounded size.
 */
function guardedFetch(u: URL, o: { method: string; headers: Record<string, string>; body: BodyInit | null | undefined; timeoutMs: number }, policy: NetPolicy): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new PolicyError(`${u.protocol} addresses are not allowed`));
    if (u.username || u.password) return reject(new PolicyError('an address with credentials in it is not allowed'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const why = refusal(host, u.protocol, policy);
      if (why) return reject(new PolicyError(why));
    }
    let payload: Buffer | undefined;
    if (typeof o.body === 'string') payload = Buffer.from(o.body);
    else if (o.body instanceof Uint8Array) payload = Buffer.from(o.body);
    else if (o.body instanceof ArrayBuffer) payload = Buffer.from(o.body);
    else if (o.body !== undefined && o.body !== null) return reject(new PolicyError('only a body held in memory can be sent to an address a person typed'));
    const lookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = addresses as dns.LookupAddress[];
        for (const a of list) {
          const why = refusal(a.address, u.protocol, policy);
          if (why) return cb(new PolicyError(`${hostname} resolves to ${why}`));
        }
        if (options.all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    }) as unknown as http.RequestOptions['lookup'];
    const lib = u.protocol === 'https:' ? https : http;
    // A connection of its own each time (agent: false), so every call is checked where it connects, never a pooled socket.
    const req = lib.request(u, {
      method: o.method, lookup, timeout: o.timeoutMs, agent: false,
      headers: { ...o.headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > GUARDED_MAX_BYTES) { res.destroy(new Error('the answer is too large')); return; }
        chunks.push(c);
      });
      res.on('error', (err) => reject(err));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const status = res.statusCode ?? 0;
        // A Response cannot carry a body with these statuses.
        const empty = status === 204 || status === 304 || (status >= 100 && status < 200);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status || 502, headers: h }));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', (err) => reject(err));
    req.end(payload);
  });
}

/**
 * Secrets are found by their shape, not by a list of the names the networks happened to use when this was written (a Bluesky
 * session is `accessJwt`, Meta's is `access_token`, an OAuth `state` in an address is as good as a password for a few minutes):
 *  - a key that names a credential has its value removed, whatever the value looks like;
 *  - a value that looks like a JWT is removed wherever it is;
 *  - an address that is signed (it carries a signature, a policy or an expiry in its query) loses every query value, because a
 *    signed address IS the credential; any other address loses the values of the parameters whose names name a credential.
 */
const SECRET_KEY = /token|secret|authori[sz]ation|password|passwd|jwt|cookie|session|credential|signature|api[_-]?key|code_verifier|^code$|^sig$|^key$|^policy$/i;
/** In an address, an OAuth `state` is a credential too (in a body, `state` is a job's or a post's, worth keeping). */
const SECRET_PARAM = new RegExp(`${SECRET_KEY.source}|^state$`, 'i');
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** Query parameters that only a signed address carries (S3, Google Cloud Storage, Azure, CloudFront, Meta's CDN, this app's own media links). */
const SIGNED_PARAM = /^(x-amz-[a-z-]+|x-goog-[a-z-]+|signature|sig|sv|se|sp|sr|skoid|policy|key-pair-id|expires|exp|oh|oe|_nc_[a-z_]+|token|hmac|hash)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`]+/g;

function redactOneUrl(raw: string): string {
  const q = raw.indexOf('?');
  if (q === -1) return raw;
  const hashAt = raw.indexOf('#', q);
  const query = raw.slice(q + 1, hashAt === -1 ? undefined : hashAt);
  const pairs = query.split('&').filter(Boolean).map((part) => {
    const eq = part.indexOf('=');
    let name = eq === -1 ? part : part.slice(0, eq);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep it as written */ }
    return { name, raw: part, hasValue: eq !== -1 };
  });
  const signed = pairs.some((p) => SIGNED_PARAM.test(p.name));
  const kept = pairs.map((p) => {
    if (!p.hasValue) return p.raw;
    const value = p.raw.slice(p.raw.indexOf('=') + 1);
    let decoded = value;
    try { decoded = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { /* keep it as written */ }
    return signed || SECRET_PARAM.test(p.name) || new RegExp(JWT.source).test(decoded) ? `${p.raw.slice(0, p.raw.indexOf('='))}=[removed]` : p.raw;
  });
  return `${raw.slice(0, q)}?${kept.join('&')}`;
}

/** An address, or a text with addresses in it, with every secret in it removed (see above). */
export function redactUrl(text: string): string {
  return text.replace(URL_IN_TEXT, (u) => redactOneUrl(u)).replace(JWT, '[removed]');
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
