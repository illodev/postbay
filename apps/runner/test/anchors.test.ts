import { describe, expect, it } from 'vitest';
import { describeAnchor } from '../src/workspace.js';

describe('telling the agent where a comment points', () => {
  it('says a moment, a span, a page point and a page area as before', () => {
    expect(describeAnchor(null)).toMatch(/^General/);
    expect(describeAnchor({ type: 'time', t: 3.5 })).toBe('Video, at 0:03.5 (3.5 seconds)');
    expect(describeAnchor({ type: 'time', t: 3.5, t_end: 5 })).toBe('Video, from 0:03.5 to 0:05.0 (3.5–5 seconds)');
    expect(describeAnchor({ type: 'region', page: 2, x: 0.5, y: 0.25, w: 0, h: 0 })).toBe('Page 2, a point 50% from the left and 25% from the top');
  });

  it('says which subtitle line a comment is about, and what the line says, so the agent edits that line', () => {
    const text = describeAnchor({ type: 'time', t: 3.5, t_end: 5, cue: 1, track: 0, cue_text: 'Our flat white is back' });
    expect(text).toBe('Subtitle line 2 of subtitle file 1, from 0:03.5 to 0:05.0 (3.5–5 seconds), which says: "Our flat white is back"');
    expect(describeAnchor({ type: 'time', t: 1, t_end: 2, cue: 0, track: 1, cue_text: 'Two\nlines' })).toContain('subtitle file 2');
    expect(describeAnchor({ type: 'time', t: 1, t_end: 2, cue: 0, track: 1, cue_text: 'Two\nlines' })).toContain('"Two / lines"');
    expect(describeAnchor({ type: 'time', t: 1, cue: 4 })).toBe('Subtitle line 5 of subtitle file 1, at 0:01.0 (1–1 seconds)');
  });
});
