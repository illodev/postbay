import { describe, expect, it } from 'vitest';
import { anchorSchema } from '../src/domain/anchors.js';
import { fingerprintOf } from '../src/domain/fingerprint.js';
import { derivePieceState } from '../src/domain/review.js';
import { PERMISSIONS, ROLES, can } from '../src/domain/roles.js';
import { daysBetween, isoWeekday, localDay, moveToDay, zonedInstant } from '../src/domain/time.js';

const h = (c: string) => c.repeat(64);

describe('fingerprint', () => {
  const base = [
    { kind: 'video', position: 0, sha256: h('a') },
    { kind: 'cover', position: 0, sha256: h('b') },
  ];

  it('does not depend on the order the files are listed in', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf([...base].reverse()));
  });

  it('changes if one byte of one file changes', () => {
    const changed = [{ ...base[0]!, sha256: h('c') }, base[1]!];
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(base));
  });

  it('changes if the role or the position of a file changes', () => {
    expect(fingerprintOf([{ ...base[0]!, position: 1 }, base[1]!])).not.toBe(fingerprintOf(base));
    expect(fingerprintOf([base[0]!, { ...base[1]!, kind: 'image' }])).not.toBe(fingerprintOf(base));
  });

  it('is a sha256 hex string', () => {
    expect(fingerprintOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('roles', () => {
  it('only approvers and admins can approve or schedule', () => {
    for (const role of ROLES) {
      const expected = role === 'approver' || role === 'admin';
      expect(can(role, 'version.approve')).toBe(expected);
      expect(can(role, 'publication.schedule')).toBe(expected);
    }
  });

  it('producers can reply and resolve but not start comments, request changes or touch accounts', () => {
    expect(can('producer', 'comment.reply')).toBe(true);
    expect(can('producer', 'comment.resolve')).toBe(true);
    expect(can('producer', 'comment.create')).toBe(false);
    expect(can('producer', 'version.request_changes')).toBe(false);
    expect(can('producer', 'brand.manage')).toBe(false);
  });

  it('approvers and admins can upload, which is why nobody may approve their own upload', () => {
    expect(ROLES.filter((r) => can(r, 'version.upload'))).toEqual(['admin', 'approver', 'producer']);
  });

  it('readers can only look', () => {
    expect([...PERMISSIONS.reader]).toEqual(['brand.view']);
  });

  it('only admins manage the brand', () => {
    expect(ROLES.filter((r) => can(r, 'brand.manage'))).toEqual(['admin']);
  });
});

describe('piece state', () => {
  it('is draft with no versions', () => expect(derivePieceState(false, [])).toBe('draft'));
  it('is approved only when every variant is approved', () => {
    expect(derivePieceState(false, ['approved', 'approved'])).toBe('approved');
    expect(derivePieceState(false, ['approved', 'in_review'])).toBe('in_review');
    expect(derivePieceState(false, ['approved', 'changes_requested'])).toBe('changes_requested');
  });
  it('ignores superseded versions and wins with discarded', () => {
    expect(derivePieceState(false, ['superseded', 'in_review'])).toBe('in_review');
    expect(derivePieceState(true, ['approved'])).toBe('discarded');
  });
});

describe('time', () => {
  it('keeps 19:00 local across the spring clock change in Madrid', () => {
    // 2027-03-28 is the last Sunday of March: clocks go forward at 02:00.
    expect(zonedInstant('2027-03-27', '19:00', 'Europe/Madrid').toISOString()).toBe('2027-03-27T18:00:00.000Z');
    expect(zonedInstant('2027-03-29', '19:00', 'Europe/Madrid').toISOString()).toBe('2027-03-29T17:00:00.000Z');
  });

  it('keeps 19:00 local across the autumn clock change', () => {
    expect(zonedInstant('2026-10-24', '19:00', 'Europe/Madrid').toISOString()).toBe('2026-10-24T17:00:00.000Z');
    expect(zonedInstant('2026-10-26', '19:00', 'Europe/Madrid').toISOString()).toBe('2026-10-26T18:00:00.000Z');
  });

  it('moves a post to another day keeping the local hour', () => {
    const at = zonedInstant('2027-03-27', '19:00', 'Europe/Madrid');
    expect(moveToDay(at, '2027-03-29', 'Europe/Madrid').toISOString()).toBe('2027-03-29T17:00:00.000Z');
  });

  it('works out the local day, not the UTC day', () => {
    expect(localDay(new Date('2027-01-10T23:30:00Z'), 'Europe/Madrid')).toBe('2027-01-11');
    expect(localDay(new Date('2027-01-10T23:30:00Z'), 'America/Los_Angeles')).toBe('2027-01-10');
  });

  it('lists days and ISO weekdays', () => {
    expect(daysBetween('2027-02-27', '2027-03-02')).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
    expect(isoWeekday('2027-03-01')).toBe(1); // Monday
  });
});

describe('anchors', () => {
  it('accepts a moment, a span and a region', () => {
    expect(anchorSchema.safeParse({ type: 'time', t: 12.4 }).success).toBe(true);
    expect(anchorSchema.safeParse({ type: 'time', t: 12, t_end: 15 }).success).toBe(true);
    expect(anchorSchema.safeParse({ type: 'region', page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 }).success).toBe(true);
  });
  it('rejects a span that ends before it starts and a region that leaves the page', () => {
    expect(anchorSchema.safeParse({ type: 'time', t: 12, t_end: 3 }).success).toBe(false);
    expect(anchorSchema.safeParse({ type: 'region', page: 1, x: 0.8, y: 0.1, w: 0.5, h: 0.1 }).success).toBe(false);
    expect(anchorSchema.safeParse({ type: 'region', page: 0, x: 0, y: 0 }).success).toBe(false);
  });
});
