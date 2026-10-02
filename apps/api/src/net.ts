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
 *  - Link-local addresses (169.254.0.0/16 is where most cloud providers answer with credentials), the other addresses cloud
 *    providers put their metadata services on, unspecified, multicast and reserved ranges are never allowed.
 *  - Loopback and private ranges are allowed only when the deployment says so (a runner on the same machine or LAN).
 *  - In production, plain http is accepted only for those private addresses; anything public must be https.
 *  - An IPv6 address that carries an IPv4 one (IPv4-mapped and -compatible, NAT64, 6to4, Teredo) is judged by both, and the
 *    stricter answer wins: a NAT64 gateway would turn 64:ff9b::a9fe:a9fe into a request to 169.254.169.254.
 */
const NEVER = new BlockList();
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local: AWS, GCP (metadata.google.internal), Azure, DigitalOcean, OpenStack, Tencent
NEVER.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments, not a destination; Oracle Cloud's 192.0.0.192 is here
NEVER.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud metadata (inside 100.64.0.0/10, which is otherwise only private)
NEVER.addAddress('168.63.129.16', 'ipv4'); // Azure's platform endpoint (WireServer), which hands VM configuration out
NEVER.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER.addSubnet('240.0.0.0', 4, 'ipv4');
NEVER.addAddress('::', 'ipv6');
NEVER.addAddress('fd00:ec2::254', 'ipv6'); // AWS instance metadata over IPv6 (inside fc00::/7, which is otherwise only private)
NEVER.addAddress('fd20:ce::254', 'ipv6'); // Google Cloud metadata over IPv6
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
const RANK: Record<AddressClass, number> = { public: 0, private: 1, never: 2 };

/** The eight 16-bit groups of an IPv6 address (an IPv4 tail and :: included), or null if it is not one. */
function groups6(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, ''); // a zone id says which interface, not where
  if (isIP(s) !== 6) return null;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const all = [...left, ...fill, ...right].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => g >= 0 && g <= 0xffff) ? all : null;
}

const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 addresses an IPv6 address stands for, by the ways of carrying one that a route could actually take. */
function embeddedV4(g: number[]): string[] {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (translated) and ::a.b.c.d (the old "compatible" form, but not :: or ::1)
  if (zero(0, 5) && g[5] === 0xffff) return [v4(g[6]!, g[7]!)];
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return [v4(g[6]!, g[7]!)];
  if (zero(0, 6) && (g[6] !== 0 || g[7]! > 1)) return [v4(g[6]!, g[7]!)];
  // NAT64: the well-known prefix 64:ff9b::/96 and the local-use 64:ff9b:1::/48 (as a /96, its usual shape)
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return [v4(g[6]!, g[7]!)];
  // 6to4: 2002:AABB:CCDD::/48 is A.B.C.D
  if (g[0] === 0x2002) return [v4(g[1]!, g[2]!)];
  // Teredo: 2001:0:<server>:<flags>:<port>:<client, inverted>
  if (g[0] === 0x2001 && g[1] === 0) return [v4(g[2]!, g[3]!), v4(~g[6]! & 0xffff, ~g[7]! & 0xffff)];
  return [];
}

function classifyV4(ip: string): AddressClass {
  if (NEVER.check(ip, 'ipv4')) return 'never';
  if (PRIVATE.check(ip, 'ipv4')) return 'private';
  return 'public';
}

export function classifyAddress(address: string): AddressClass {
  const ip = address.replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) return classifyV4(ip);
  const g = groups6(ip);
  if (!g) return 'never'; // not an address at all: nothing to send to
  const canonical = g.map((x) => x.toString(16)).join(':');
  let cls: AddressClass = NEVER.check(canonical, 'ipv6') ? 'never' : PRIVATE.check(canonical, 'ipv6') ? 'private' : 'public';
  for (const inner of embeddedV4(g)) {
    const c = classifyV4(inner);
    if (RANK[c] > RANK[cls]) cls = c;
  }
  return cls;
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
export function post(url: URL, headers: Record<string, string>, body: string | Buffer, policy: NetPolicy, timeoutMs = 10_000): Promise<PostResult> {
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
