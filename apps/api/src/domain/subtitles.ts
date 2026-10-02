/**
 * Subtitle files (WebVTT and SubRip) read into lines with start and end times, so a reviewer can comment on one line and the app can
 * show the lines beside the video. Forgiving on purpose: files come from many tools, and a stray odd block must not hide the rest.
 */
export interface Cue {
  /** Its place among the cues of the file, from 0: what a comment on it refers to. */
  index: number;
  /** Seconds. */
  start: number;
  end: number;
  /** The words, with the markup taken out and lines joined by a line break. */
  text: string;
}

export interface ParsedSubtitles {
  cues: Cue[];
  /** Blocks that looked like cues but could not be read (a time that makes no sense), so the person can be told. */
  skipped: number;
  /** The file had more cues than are read. */
  truncated: boolean;
}

export const MAX_CUES = 20_000;

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const ARROW = new RegExp(`^\\s*(${TIME.source})\\s*-->\\s*(${TIME.source})`);

const seconds = (h: string | undefined, m: string, s: string, ms: string) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' };

/** Markup out, entities in: WebVTT's <i>, <b>, <v Name>, <c.class>, <00:01.000> and SubRip's <font> and {\an8}. */
function plain(line: string): string {
  return line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_, n: string) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ''))
    .trim();
}

export function parseSubtitles(input: string): ParsedSubtitles {
  // A byte-order mark at the start needs no handling of its own: trim() and \s both count it as white space.
  const text = input.replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  let skipped = 0;
  let truncated = false;
  for (const raw of blocks) {
    const lines = raw.split('\n').filter((l, i, all) => !(l.trim() === '' && (i === 0 || i === all.length - 1)));
    if (lines.length === 0) continue;
    const first = lines[0]!.trim();
    // Blocks that are not cues, even if a comment or a style rule happens to hold an arrow. (The WEBVTT header needs no check: with no
    // arrow in it, the block below is let go as "not a cue", and with one, it is the first cue written without the usual blank line.)
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;

    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) {
      // A number alone, or a lone line of words: not a cue. (A block with an index but no time is a broken one.)
      if (/^\d+$/.test(first) && lines.length > 1) skipped++;
      continue;
    }
    const m = ARROW.exec(lines[at]!);
    if (!m) { skipped++; continue; }
    // Groups: the whole first time is m[1], its parts m[2..5]; the second time is m[6], parts m[7..10].
    const start = seconds(m[2], m[3]!, m[4]!, m[5]!);
    const end = seconds(m[7], m[8]!, m[9]!, m[10]!);
    if (!(end >= start)) { skipped++; continue; }
    if (cues.length >= MAX_CUES) { truncated = true; break; }
    const words = lines.slice(at + 1).map(plain).filter((l) => l !== '').join('\n');
    cues.push({ index: cues.length, start, end, text: words });
  }
  return { cues, skipped, truncated };
}

/** The cue being shown at a moment, or null: the last one that has started and not yet ended. */
export function cueAt(cues: Cue[], t: number): Cue | null {
  let found: Cue | null = null;
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end || (c.start === c.end && t === c.start)) found = c;
  }
  return found;
}
