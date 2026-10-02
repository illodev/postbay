// Same rules as the server's validators (apps/api/src/connectors/validate.ts), so the counters agree with what is enforced.
const HASHTAG = /(^|[\s(])#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|[\s(])@[\p{L}\p{N}_.]+/gu;

export const countHashtags = (text: string) => (text.match(HASHTAG) ?? []).length;
export const countMentions = (text: string) => (text.match(MENTION) ?? []).length;
/** Characters as a person counts them: an emoji is one, not two. */
export const countChars = (text: string) => Array.from(text).length;
/** What a person sees as one character: a flag or a family emoji is one, though it is several code points. Bluesky counts these. */
export function countGraphemes(text: string): number {
  if (typeof Intl.Segmenter !== 'function') return countChars(text);
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
  return n;
}
/** Length as the network counts it. */
export const countLength = (text: string, unit?: 'chars' | 'graphemes') => (unit === 'graphemes' ? countGraphemes(text) : countChars(text));

/** What a feed shows before "…more": the first `cutoff` characters, cut at the end of a word when there is one nearby. */
export function truncatePreview(text: string, cutoff: number): { shown: string; hidden: string } | null {
  const chars = Array.from(text);
  if (chars.length <= cutoff) return null;
  return { shown: chars.slice(0, cutoff).join(''), hidden: chars.slice(cutoff).join('') };
}
