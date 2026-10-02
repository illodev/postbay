import { z } from 'zod';

const unit = z.number().min(0).max(1);

/** The colours a reviewer can draw with: a few, named, so a person or an agent reading the anchor knows what each means. */
export const DRAWING_COLOURS = ['yellow', 'red', 'green', 'blue', 'white'] as const;
/** At most this many shapes in one drawing, and this many points in all its strokes: a sketch, not a picture. */
export const DRAWING_MAX_SHAPES = 30;
export const DRAWING_MAX_POINTS = 2000;

const colour = z.enum(DRAWING_COLOURS).default('yellow');

/**
 * A shape drawn over the frame or the page, in fractions of it (0..1 from the top-left corner), so it fits any screen size:
 * a freehand stroke, a rectangle or an arrow (from its tail to its head).
 */
export const shapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'), points: z.array(z.tuple([unit, unit])).min(2).max(500), color: colour }),
  z
    .object({ type: z.literal('rect'), x: unit, y: unit, w: unit, h: unit, color: colour })
    .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, { message: 'the rectangle falls outside the frame' }),
  z.object({ type: z.literal('arrow'), x1: unit, y1: unit, x2: unit, y2: unit, color: colour }),
]);

export const drawingSchema = z
  .array(shapeSchema)
  .min(1)
  .max(DRAWING_MAX_SHAPES)
  .refine((shapes) => shapes.reduce((n, s) => n + (s.type === 'path' ? s.points.length : 2), 0) <= DRAWING_MAX_POINTS, {
    message: `a drawing has at most ${DRAWING_MAX_POINTS} points`,
  });

export type Shape = z.infer<typeof shapeSchema>;

/**
 * Where a comment is anchored: an instant or span of video, or a point or rectangle on a page. Either can carry a drawing over
 * the frame or the page (what the reviewer sketched while writing the comment).
 */
export const anchorSchema = z.union([
  z
    .object({
      type: z.literal('time'),
      t: z.number().min(0),
      t_end: z.number().min(0).optional(),
      /** Which video of a carousel; without it, the first one. */
      position: z.number().int().min(0).optional(),
      /** A comment on one line of the subtitles: which subtitle file and which line of it. The times and the words are filled in from the file. */
      track: z.number().int().min(0).optional(),
      cue: z.number().int().min(0).optional(),
      cue_text: z.string().max(1000).optional(),
      drawing: drawingSchema.optional(),
    })
    .refine((a) => a.t_end === undefined || a.t_end >= a.t, { message: 't_end must be greater than or equal to t' }),
  z
    .object({
      type: z.literal('region'),
      page: z.number().int().min(1),
      x: unit,
      y: unit,
      w: unit.default(0),
      h: unit.default(0),
      drawing: drawingSchema.optional(),
    })
    .refine((a) => a.x + a.w <= 1.0001 && a.y + a.h <= 1.0001, { message: 'the region falls outside the page' }),
]);

export type Anchor = z.infer<typeof anchorSchema>;
