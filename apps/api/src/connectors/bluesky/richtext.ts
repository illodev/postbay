/** Bluesky counts a post's length in graphemes (what a person sees as one character), not in UTF-16 units. */
export function graphemes(text: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: ({ $type: 'app.bsky.richtext.facet#link'; uri: string } | { $type: 'app.bsky.richtext.facet#tag'; tag: string } | { $type: 'app.bsky.richtext.facet#mention'; did: string })[];
}

const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).length;

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_]{1,64})/gu;
const MENTION_RE = /(^|\s)@([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+)/g;

/** Handles mentioned in a text, without the @. */
export function mentionedHandles(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[2]!))];
}

/**
 * Bluesky does not turn a link, a hashtag or a mention in the text into anything by itself: each has to be pointed at with a
 * "facet" that gives the bytes (UTF-8) it covers. `resolved` maps handles to their ids; a mention that is not in it stays plain text.
 */
export function facetsFor(text: string, resolved: Record<string, string> = {}): Facet[] {
  const out: Facet[] = [];
  const at = (index: number, len: number) => ({ byteStart: byteLength(text.slice(0, index)), byteEnd: byteLength(text.slice(0, index + len)) });
  for (const m of text.matchAll(URL_RE)) {
    // Punctuation that ends a sentence is not part of the address.
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    out.push({ index: at(m.index!, url.length), features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index! + m[1]!.length;
    out.push({ index: at(start, m[2]!.length + 1), features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2]! }] });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const did = resolved[m[2]!];
    if (!did) continue;
    const start = m.index! + m[1]!.length;
    out.push({ index: at(start, m[2]!.length + 1), features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
  }
  return out.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
