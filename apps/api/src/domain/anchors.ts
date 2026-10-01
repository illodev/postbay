import { z } from 'zod';

const unit = z.number().min(0).max(1);

/** Where a comment is anchored: an instant or span of video, or a point or rectangle on a page. */
export const anchorSchema = z.union([
  z
    .object({
      type: z.literal('time'),
      t: z.number().min(0),
      t_end: z.number().min(0).optional(),
      /** Which video of a carousel; without it, the first one. */
      position: z.number().int().min(0).optional(),
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
    })
    .refine((a) => a.x + a.w <= 1.0001 && a.y + a.h <= 1.0001, { message: 'the region falls outside the page' }),
]);

export type Anchor = z.infer<typeof anchorSchema>;
