/**
 * How X measures a post: every character counts one except those in the ranges below (Latin text and common punctuation), which
 * count one, and everything else (Chinese, Japanese, Korean, most emoji) which counts two; any address counts 23 whatever its length.
 * The limit is 280 of these. This is a faithful but small version of X's own rule: the result is checked again by X when posting.
 *
 * An address is not only what starts with http: X turns a bare domain into a link too ("example.com", "shop.example.es/menu"),
 * and counts and charges it as one. Like X's own rule (twitter-text), a bare domain on a generic top-level domain is a link, and one on
 * a two-letter country domain is a link when it has a path or a subdomain ("lumen.es" alone is not; "lumen.es/menu" and
 * "www.lumen.es" are). The list of generic domains here is the common ones, not all of them.
 */
const GENERIC_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'app', 'dev', 'io', 'ai', 'co', 'me', 'tv', 'ly', 'gg', 'xyz', 'online', 'site', 'store', 'shop',
  'tech', 'blog', 'news', 'club', 'live', 'link', 'page', 'cloud', 'digital', 'studio', 'design', 'agency', 'media', 'world', 'today', 'life', 'email',
  'eu', 'asia', 'travel', 'cafe', 'coffee', 'restaurant', 'menu', 'pizza', 'bar', 'wine', 'beer', 'art', 'music', 'fashion', 'fit', 'health', 'space',
];
const PROTOCOL_URL = /https?:\/\/[^\s]+/gi;
// A domain (labels of letters, digits and hyphens), an optional port and path, not glued to a word, an @ or another dot before it.
const BARE_DOMAIN = /(?<![\p{L}\p{N}@.\/_-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(:\d{1,5})?(\/[^\s]*)?/giu;

function isLinkedDomain(host: string, tld: string, path: string | undefined): boolean {
  const t = tld.toLowerCase();
  if (GENERIC_TLDS.includes(t)) return true;
  if (t.length !== 2) return false;
  return !!path || host.split('.').length > 2;
}

/** Every stretch of the text X would make into a link: addresses with http(s), and bare domains it links by itself. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  const rest = text.replace(PROTOCOL_URL, (u) => {
    out.push(u);
    return ' ';
  });
  for (const m of rest.matchAll(BARE_DOMAIN)) {
    const host = m[1]!.replace(/\.$/, '');
    if (isLinkedDomain(host, m[2]!, m[4])) out.push(m[0]);
  }
  return out;
}

const URL_RE = PROTOCOL_URL;
const LIGHT: [number, number][] = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];

export function weightedLength(text: string): number {
  let n = 0;
  let withoutUrls = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const link of linksIn(withoutUrls)) {
    withoutUrls = withoutUrls.replace(link, '');
    n += 23;
  }
  for (const ch of withoutUrls.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

export const hasLink = (text: string) => linksIn(text).length > 0;
