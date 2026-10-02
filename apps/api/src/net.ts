import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outgoing requests to addresses a person typed in (webhooks). The risk is a request that reaches something the person
 * should not be able to reach through the server: a cloud metadata service, the database, the storage service. The
 * address is checked where it is used, after the name has been resolved, so a name that points somewhere else a moment
 * later (DNS rebinding) does not get past it.
 *
 *  - Link-local addresses (169.254.0.0/16 is where cloud providers answer with credentials), unspecified, multicast and
 *    reserved ranges are never allowed.
 *  - Loopback and private ranges are allowed only when the deployment says so (a runner on the same machine or LAN).
 *  - In production, plain http is accepted only for those private addresses; anything public must be https.
 */
const NEVER = new BlockList();
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER.addSubnet('240.0.0.0', 4, 'ipv4');
NEVER.addAddress('::', 'ipv6');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addSubnet('ff00::', 8, 'ipv6');

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

export type AddressClass = 'public' | 'private' | 'never';

/** An IPv4-mapped IPv6 address (::ffff:10.0.0.1) is the IPv4 address it wraps. */
function unmap(ip: string): { ip: string; family: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return { ip: m[1]!, family: 'ipv4' };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return { ip: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 'ipv4' };
  }
  return { ip, family: isIP(ip) === 6 ? 'ipv6' : 'ipv4' };
}

export function classifyAddress(address: string): AddressClass {
  const { ip, family } = unmap(address.replace(/^\[|\]$/g, ''));
  if (NEVER.check(ip, family)) return 'never';
  if (PRIVATE.check(ip, family)) return 'private';
  return 'public';
}

export interface NetPolicy {
  /** Loopback and private ranges may be reached. */
  allowPrivate: boolean;
  /** Plain http to a public address is refused (production). */
  httpsForPublic: boolean;
}

/** Why an address is refused, or null when it may be used. */
export function refusal(address: string, scheme: string, policy: NetPolicy): string | null {
  const cls = classifyAddress(address);
  if (cls === 'never') return `${address} is not an address webhooks may be sent to (link-local, reserved or metadata range)`;
  if (cls === 'private' && !policy.allowPrivate) {
    return `${address} is on a private network, which this server does not allow webhooks to reach (set WEBHOOK_ALLOW_PRIVATE_NETWORKS=true to allow it)`;
  }
  if (cls === 'public' && scheme === 'http:' && policy.httpsForPublic) return 'A public address has to use https';
  return null;
}

/** Checks what can be checked without resolving a name: scheme, credentials, and an address written out in the URL. */
export function checkUrl(raw: string, policy: NetPolicy): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'That is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Only http and https addresses can receive webhooks' };
  if (url.username || url.password) return { error: 'Put credentials in the secret, not in the URL' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const why = refusal(host, url.protocol, policy);
    if (why) return { error: why };
  } else if (host.toLowerCase() === 'localhost' && !policy.allowPrivate) {
    return { error: 'localhost is on this machine, which this server does not allow webhooks to reach (set WEBHOOK_ALLOW_PRIVATE_NETWORKS=true to allow it)' };
  }
  return { url };
}

export interface PostResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The start of the answer, enough to tell what went wrong. */
  text: string;
}

/**
 * POSTs a body without following redirects, with the address policy applied to whatever the name resolves to at the
 * moment of connecting.
 */
export function post(url: URL, headers: Record<string, string>, body: string, policy: NetPolicy, timeoutMs = 10_000): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const why = refusal(host, url.protocol, policy);
      if (why) return reject(new PolicyError(why));
    }
    const lookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = addresses as dns.LookupAddress[];
        for (const a of list) {
          const why = refusal(a.address, url.protocol, policy);
          if (why) return cb(new PolicyError(`${hostname} resolves to ${why}`));
        }
        if (options.all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    }) as unknown as http.RequestOptions['lookup'];

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 4096) chunks.push(c);
          else res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8').slice(0, 2000) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No answer after ${Math.round(timeoutMs / 1000)} seconds`)));
    req.on('error', (err) => reject(err));
    req.end(body);
  });
}

/** A refusal by the address policy: not worth retrying, because retrying will not change what the address is. */
export class PolicyError extends Error {}
