import { describe, expect, it } from 'vitest';
import { MAX_CUES, cueAt, parseSubtitles } from '../src/domain/subtitles.js';

describe('WebVTT', () => {
  it('reads the cues of an ordinary file, with or without ids and hours', () => {
    const r = parseSubtitles(`WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello there

second
00:04.000 --> 00:06.250 align:start position:10%
How are you?
Fine, thanks.

01:02:03.004 --> 01:02:05.000
An hour in
`);
    expect(r).toEqual({
      cues: [
        { index: 0, start: 1, end: 3.5, text: 'Hello there' },
        { index: 1, start: 4, end: 6.25, text: 'How are you?\nFine, thanks.' },
        { index: 2, start: 3723.004, end: 3725, text: 'An hour in' },
      ],
      skipped: 0, truncated: false,
    });
  });

  it('leaves out the header, notes, styles and regions, and takes markup out of the words', () => {
    const r = parseSubtitles(`WEBVTT - a title
Kind: captions
Language: en

NOTE this is a comment
spanning two lines

STYLE
::cue { color: red }

REGION
id:fred

00:00.000 --> 00:02.000
<v Ana>Hello &amp; <i>welcome</i> to <b>the</b> <c.yellow>show</c> &lt;3</v>

00:02.000 --> 00:03.000
<00:02.100>Karaoke <00:02.500>words&nbsp;here
`);
    expect(r.cues.map((c) => c.text)).toEqual(['Hello & welcome to the show <3', 'Karaoke words here']);
    expect(r.skipped).toBe(0);
  });
});

describe('what is not a cue', () => {
  it('lets a note, a style or a region hold something that looks like a time without turning it into a line', () => {
    const r = parseSubtitles(`WEBVTT

NOTE
00:00.000 --> 00:01.000 this is a comment about the next line

STYLE
/* 00:00.000 --> 00:01.000 */
::cue { color: red }

REGION
id:a --> b

00:02.000 --> 00:03.000
The only line
`);
    expect(r.cues).toEqual([{ index: 0, start: 2, end: 3, text: 'The only line' }]);
    expect(r.skipped).toBe(0);
  });

  it('reads a first cue written right under the header, and a file that starts with a byte-order mark', () => {
    expect(parseSubtitles('WEBVTT\n00:01.000 --> 00:02.000\nUnder the header').cues.map((c) => c.text)).toEqual(['Under the header']);
    expect(parseSubtitles('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nWith a mark').cues).toEqual([{ index: 0, start: 1, end: 2, text: 'With a mark' }]);
    expect(parseSubtitles('\uFEFF00:01.000 --> 00:02.000\nNo header, with a mark').cues.map((c) => c.text)).toEqual(['No header, with a mark']);
  });

  it('counts a block that has an arrow but no readable time as skipped, and goes on', () => {
    const r = parseSubtitles('WEBVTT\n\n00:01 --> 00:02\nno milliseconds\n\nsoon --> later\nwords\n\n00:03.000 --> 00:04.000\nfine');
    expect(r.cues).toEqual([{ index: 0, start: 3, end: 4, text: 'fine' }]);
    expect(r.skipped).toBe(2);
  });

  it('drops the lines of a cue that say nothing once the markup is gone, but keeps the others in order', () => {
    const r = parseSubtitles('WEBVTT\n\n00:00.000 --> 00:01.000\nFirst\n   \n<i></i>\n{\\an8}\nLast');
    expect(r.cues[0]!.text).toBe('First\nLast');
  });
});

describe('SubRip', () => {
  it('reads the numbered blocks with comma times and takes its styling out', () => {
    const r = parseSubtitles('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n{\\an8}<font color="#fff">Top line</font>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\nlines\r\n');
    expect(r.cues).toEqual([
      { index: 0, start: 1, end: 2.5, text: 'Top line' },
      { index: 1, start: 3, end: 4, text: 'Two\nlines' },
    ]);
  });

  it('copes with short milliseconds, many blank lines, and no final newline', () => {
    const r = parseSubtitles('1\n00:00:01,5 --> 00:00:02,25\nA\n\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nB');
    expect(r.cues).toEqual([{ index: 0, start: 1.5, end: 2.25, text: 'A' }, { index: 1, start: 3, end: 4, text: 'B' }]);
  });
});

describe('what it does with a file that is not right', () => {
  it('skips a cue whose end is before its start, and counts it, and keeps the rest numbered by what was kept', () => {
    const r = parseSubtitles('WEBVTT\n\n00:05.000 --> 00:01.000\nbackwards\n\n00:06.000 --> 00:07.000\nfine\n\n1\nnot a time at all\n');
    expect(r.cues).toEqual([{ index: 0, start: 6, end: 7, text: 'fine' }]);
    expect(r.skipped).toBe(2);
  });

  it('gives nothing for empty input, and for words that are not subtitles', () => {
    expect(parseSubtitles('')).toEqual({ cues: [], skipped: 0, truncated: false });
    expect(parseSubtitles('just some text\n\nin two paragraphs').cues).toEqual([]);
  });

  it('keeps a cue with no words (some tools make them) and numbers it, so line numbers match what people see', () => {
    const r = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\n\n00:03.000 --> 00:04.000\nWords');
    expect(r.cues.map((c) => c.text)).toEqual(['', 'Words']);
  });

  it('stops at a limit and says so', () => {
    const many = `WEBVTT\n\n${Array.from({ length: MAX_CUES + 5 }, (_, i) => `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:${String(i % 60).padStart(2, '0')}.500\nline ${i}`).join('\n\n')}`;
    const r = parseSubtitles(many);
    expect(r.cues).toHaveLength(MAX_CUES);
    expect(r.truncated).toBe(true);
  });

  it('reads numeric character references, and refuses one that is not a character', () => {
    const r = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\ncaf&#233; &#99999999; ok');
    expect(r.cues[0]!.text).toBe('café  ok');
  });
});

describe('which line is on screen', () => {
  const cues = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:03.000\nA\n\n00:02.000 --> 00:04.000\nB\n\n00:06.000 --> 00:07.000\nC').cues;
  it('is the last one that has started and not ended', () => {
    expect(cueAt(cues, 0.5)).toBeNull();
    expect(cueAt(cues, 1)?.text).toBe('A');
    expect(cueAt(cues, 2.5)?.text).toBe('B'); // two overlap: the later one
    expect(cueAt(cues, 3.5)?.text).toBe('B');
    expect(cueAt(cues, 4)).toBeNull(); // an end is not part of it
    expect(cueAt(cues, 6.5)?.text).toBe('C');
    expect(cueAt(cues, 99)).toBeNull();
  });

  it('shows a line that lasts no time at the very moment it is at, and at no other', () => {
    const flash = parseSubtitles('WEBVTT\n\n00:05.000 --> 00:05.000\nBlink').cues;
    expect(cueAt(flash, 5)?.text).toBe('Blink');
    expect(cueAt(flash, 4.999)).toBeNull();
    expect(cueAt(flash, 5.001)).toBeNull();
  });
});
