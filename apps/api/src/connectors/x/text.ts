/**
 * How X measures a post: every character counts one except those in the ranges below (Latin text and common punctuation), which
 * count one, and everything else (Chinese, Japanese, Korean, most emoji) which counts two; any address counts 23 whatever its length.
 * The limit is 280 of these. This is a faithful but small version of X's own rule: the result is checked again by X when posting.
 */
const URL_RE = /https?:\/\/[^\s]+/g;
const LIGHT: [number, number][] = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];

export function weightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

export const hasLink = (text: string) => /https?:\/\/\S+/.test(text);
