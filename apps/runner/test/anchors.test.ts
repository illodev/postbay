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

describe('telling the agent what a reviewer drew', () => {
  it('adds the shapes, where they are and their colour, after the place', () => {
    const text = describeAnchor({
      type: 'time', t: 14, drawing: [
        { type: 'rect', x: 0.4, y: 0.55, w: 0.2, h: 0.15, color: 'yellow' },
        { type: 'arrow', x1: 0.9, y1: 0.1, x2: 0.62, y2: 0.4, color: 'red' },
        { type: 'path', points: [[0.1, 0.2], [0.2, 0.3], [0.15, 0.25]] },
      ],
    });
    expect(text).toBe(
      'Video, at 0:14.0 (14 seconds), with a drawing on the frame: a yellow rectangle 40–60% from the left and 55–70% from the top; '
      + 'a red arrow pointing at 62% from the left and 40% from the top (from 90%, 10%); a yellow freehand line over 10–20% from the left and 20–30% from the top',
    );
    expect(describeAnchor({ type: 'region', page: 2, x: 0.5, y: 0.25, w: 0, h: 0, drawing: [{ type: 'arrow', x1: 0, y1: 0, x2: 0.5, y2: 0.25 }] }))
      .toBe('Page 2, a point 50% from the left and 25% from the top, with a drawing on the page: a yellow arrow pointing at 50% from the left and 25% from the top (from 0%, 0%)');
  });

  it('says nothing more when nothing was drawn, and keeps a long drawing short', () => {
    expect(describeAnchor({ type: 'time', t: 3.5, drawing: [] })).toBe('Video, at 0:03.5 (3.5 seconds)');
    const many = Array.from({ length: 9 }, () => ({ type: 'arrow' as const, x1: 0, y1: 0, x2: 1, y2: 1 }));
    expect(describeAnchor({ type: 'time', t: 1, drawing: many })).toMatch(/, and 3 more$/);
  });
});
