// Same rules as the server's validators (apps/api/src/connectors/validate.ts), so the counters agree with what is enforced.
const HASHTAG = /(^|[\s(])#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|[\s(])@[\p{L}\p{N}_.]+/gu;

export const countHashtags = (text: string) => (text.match(HASHTAG) ?? []).length;
export const countMentions = (text: string) => (text.match(MENTION) ?? []).length;
/** Characters as a person counts them: an emoji is one, not two. */
export const countChars = (text: string) => Array.from(text).length;

/** What a feed shows before "…more": the first `cutoff` characters, cut at the end of a word when there is one nearby. */
export function truncatePreview(text: string, cutoff: number): { shown: string; hidden: string } | null {
  const chars = Array.from(text);
  if (chars.length <= cutoff) return null;
  return { shown: chars.slice(0, cutoff).join(''), hidden: chars.slice(cutoff).join('') };
}
