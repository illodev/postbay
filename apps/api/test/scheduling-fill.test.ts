import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slotFits } from '../src/domain/slotfit.js';
import { fillFreeSlots } from '../src/services/scheduling.js';
import { createEnv, type Env } from './helpers.js';

/**
 * A brand that fills its free slots (rules.auto_fill_slots): approved versions that were never scheduled go into the next free weekly
 * slots of an account they were approved for, by the studio, and whoever approved them is told. Never what is not approved.
 */
let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const ZONE = 'Europe/Madrid';
let n = 0;
async function account(network = 'instagram') {
  const name = `@fill${++n}`;
  return (await env.db.one<{ id: string }>(`insert into social_account (brand_id, network, external_id, display_name) values ($1,$2,$3,$3) returning id`, [env.brandId, network, name]))!.id;
}
async function slot(accountId: string, daysAhead: number, time = '19:00', label = '') {
  const day = DateTime.now().setZone(ZONE).plus({ days: daysAhead });
  const r = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/slots`, { accountId, weekday: day.weekday, localTime: time, label });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const at = DateTime.fromISO(`${day.toISODate()}T${time}`, { zone: ZONE });
  return { id: r.body.id as string, at: at.toUTC().toISO()!, local: at, day: at.toISODate()! };
}
/** An approved version of a new piece, for these accounts. */
async function approved(accounts: string[], o: { kind?: string; format?: string; extra?: Record<string, unknown>; file?: { kind: string; name: string; mime: string } } = {}) {
  const { pieceId, variantId } = await env.makePiece(env.users.producer, o.kind ?? 'video', o.format ?? '9:16');
  const v = await env.newVersion(env.users.producer, variantId, o.file ? [o.file] : undefined);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const a = await env.approve(env.users.approver, v.body.id, accounts, o.extra ?? {});
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return { pieceId, variantId, versionId: v.body.id as string };
}
const pubsOf = (versionId: string) => env.db.query('select * from publication where version_id = $1 order by created_at', [versionId]);
const setFill = (on: boolean) => env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { auto_fill_slots: on } });

describe('which networks a free slot takes a piece on', () => {
  it('never a story, a format the network does not take as it is, or a network that needs a setting chosen each time', () => {
    expect(slotFits('instagram', 'video', '9:16')).toBe(true);
    expect(slotFits('instagram', 'carousel', 'carousel')).toBe(true);
    expect(slotFits('instagram', 'video', '16:9')).toBe(false);
    expect(slotFits('instagram', 'story', '9:16')).toBe(false);
    expect(slotFits('youtube', 'video', '16:9')).toBe(true);
    expect(slotFits('youtube', 'post', '1:1')).toBe(false);
    expect(slotFits('linkedin', 'pdf', 'document')).toBe(true);
    expect(slotFits('facebook', 'pdf', 'document')).toBe(false);
    expect(slotFits('tiktok', 'video', '9:16')).toBe(false);
    expect(slotFits('pinterest', 'post', '1:1')).toBe(false);
  });
});

describe('filling free slots', () => {
  it('is off by default, and once on takes only what is approved from then on', async () => {
    const ig = await account();
    await slot(ig, 3);
    const before = await approved([ig]);
    expect(await fillFreeSlots(env.ctx)).toBe(0);
    const on = await setFill(true);
    expect(on.body.rules).toMatchObject({ auto_fill_slots: true });
    expect(new Date(on.body.rules.auto_fill_since).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await fillFreeSlots(env.ctx)).toBe(0);
    expect(await pubsOf(before.versionId)).toHaveLength(0);
    // The version's page says the brand fills its slots.
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${before.versionId}`)).body.auto_fill_slots).toBe(true);
  });

  it('puts an approved version into the earliest free slot of an account it was approved for, as the studio, and tells its approver', async () => {
    const ig = await account();
    const late = await slot(ig, 5, '19:00', 'Reel');
    const early = await slot(ig, 2, '12:00', 'Midday');
    const v = await approved([ig], { extra: { scheduleText: 'Spring menu' } });
    expect(await fillFreeSlots(env.ctx)).toBe(1);
    const [pub] = await pubsOf(v.versionId);
    expect(pub).toMatchObject({ social_account_id: ig, slot_id: early.id, scheduled_by: 'auto', created_by: null, created_by_token: null, text: 'Spring menu', status: 'scheduled' });
    expect(new Date(pub!.scheduled_at).toISOString()).toBe(new Date(early.at).toISOString());
    expect(late.id).toBeTruthy();
    // On record as the studio's (no person, no token), and told to whoever approved it.
    expect(await env.db.one(`select actor_user_id, actor_token_id, after from audit_event where action = 'publication.scheduled' and entity_id = $1`, [pub!.id]))
      .toMatchObject({ actor_user_id: null, actor_token_id: null, after: { scheduled_by: 'auto', slot_id: early.id } });
    const told = (await env.call(env.users.approver, 'GET', '/api/notifications')).body.items.find((x: any) => x.kind === 'publication.auto_scheduled');
    expect(told.payload).toMatchObject({ publicationId: pub!.id, versionId: v.versionId, slot: 'Midday', message: expect.stringContaining(`Slot "Midday" of @fill`) });
    expect(told.payload.message).toContain(`${early.day} at 12:00`);
    expect(await env.db.query(`select 1 from notification where kind = 'publication.auto_scheduled' and user_id = $1`, [env.users.producer.id])).toHaveLength(0);
    // The calendar says who scheduled it.
    const cal = (await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/calendar?from=${early.day}&to=${early.day}`)).body;
    expect(cal.publications.find((x: any) => x.id === pub!.id)).toMatchObject({ scheduled_by: 'auto', scheduled_by_name: null });
    // Never twice: the version has its publication.
    expect(await fillFreeSlots(env.ctx)).toBe(0);
  });

  it('matches the piece to a network that takes it, one per slot, the oldest approval first, and a piece made for a slot only to that slot', async () => {
    const ig = await account('instagram');
    const yt = await account('youtube');
    const igSlot = await slot(ig, 2, '09:00');
    const ytSlot = await slot(yt, 3, '09:00');
    // 16:9 goes to YouTube, not to the earlier Instagram slot.
    const wide = await approved([ig, yt], { format: '16:9' });
    // Two vertical videos for one Instagram slot a week: this week's and next week's occurrences, the first approved first.
    const first = await approved([ig]);
    const second = await approved([ig]);
    // A story and a vertical video approved for a TikTok account are never put in.
    const tt = await account('tiktok');
    await slot(tt, 2, '10:00');
    const story = await approved([ig], { kind: 'story' });
    const tiktok = await approved([tt]);
    expect(await fillFreeSlots(env.ctx)).toBe(3);
    const at = async (v: string) => {
      const [p] = await pubsOf(v);
      return p ? `${p.slot_id === igSlot.id ? 'ig' : p.slot_id === ytSlot.id ? 'yt' : p.slot_id}@${new Date(p.scheduled_at).toISOString()}` : null;
    };
    expect(await at(wide.versionId)).toBe(`yt@${new Date(ytSlot.at).toISOString()}`);
    expect(await at(first.versionId)).toBe(`ig@${new Date(igSlot.at).toISOString()}`);
    expect(await at(second.versionId)).toBe(`ig@${DateTime.fromISO(igSlot.at).setZone(ZONE).plus({ weeks: 1 }).toUTC().toISO()}`.replace(/\.\d{3}Z$/, '.000Z'));
    expect(await pubsOf(story.versionId)).toHaveLength(0);
    expect(await pubsOf(tiktok.versionId)).toHaveLength(0);

    // A piece made for a slot waits for that slot (next week's, its own being taken), even with another free one earlier.
    const ig2 = await account('instagram');
    const own = await slot(ig2, 4, '18:00', 'Own');
    await slot(ig2, 2, '08:00', 'Earlier');
    const p = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'For its slot', kind: 'video', slot: { id: own.id, at: DateTime.fromISO(own.at).minus({ weeks: 1 }).toUTC().toISO() } });
    const variant = await env.call(env.users.producer, 'POST', `/api/pieces/${p.body.id}/variants`, { format: '9:16' });
    const ver = await env.newVersion(env.users.producer, variant.body.id);
    const ok = await env.approve(env.users.approver, ver.body.id, [ig2]);
    expect(ok.body.slot_schedule.code).toBe('time_passed');
    expect(await fillFreeSlots(env.ctx)).toBe(1);
    expect((await pubsOf(ver.body.id))[0]).toMatchObject({ slot_id: own.id });
  });

  it('never on a blocked day, a slot already taken, or while the brand is paused; never what an approver unticked or a person cancelled', async () => {
    const ig = await account();
    const s = await slot(ig, 2, '17:00');
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day: s.day, reason: 'Strike' });
    const a = await approved([ig]);
    expect(await fillFreeSlots(env.ctx)).toBe(1);
    // The blocked day is skipped: next week's occurrence instead.
    expect(DateTime.fromJSDate((await pubsOf(a.versionId))[0]!.scheduled_at).setZone(ZONE).toISODate()).toBe(s.local.plus({ weeks: 1 }).toISODate());
    await env.call(env.users.approver, 'DELETE', `/api/brands/${env.brandId}/blocked-dates/${s.day}`);

    // A person scheduled something there: taken.
    const mine = await approved([ig]);
    expect((await env.call(env.users.approver, 'POST', `/api/versions/${mine.versionId}/publications`, { accountId: ig, scheduledAt: s.at })).status).toBe(201);
    const b = await approved([ig], { extra: { autoSchedule: false } });
    expect(await fillFreeSlots(env.ctx)).toBe(0); // nothing free within reach for b, and b said no anyway
    expect(await pubsOf(b.versionId)).toHaveLength(0);

    // A version whose publication a person cancelled is not put back.
    const ig3 = await account();
    await slot(ig3, 3, '11:00');
    const c = await approved([ig3]);
    expect(await fillFreeSlots(env.ctx)).toBe(1);
    const [pub] = await pubsOf(c.versionId);
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${pub!.id}/cancel`)).status).toBe(200);
    expect(await fillFreeSlots(env.ctx)).toBe(0);
    expect(await pubsOf(c.versionId)).toHaveLength(1);

    // Paused: nothing at all.
    const ig4 = await account();
    await slot(ig4, 3, '13:00');
    const d = await approved([ig4]);
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: true });
    expect(await fillFreeSlots(env.ctx)).toBe(0);
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: false });
    expect(await fillFreeSlots(env.ctx)).toBe(1);
    expect(await pubsOf(d.versionId)).toHaveLength(1);
  });

  it('never fills one slot twice, even with two sweeps at once', async () => {
    const ig = await account();
    const s = await slot(ig, 3, '21:00');
    // Its only occurrences within reach are this week's and next week's: three candidates, two slots.
    const vs = [await approved([ig]), await approved([ig]), await approved([ig])];
    const [x, y] = await Promise.all([fillFreeSlots(env.ctx), fillFreeSlots(env.ctx)]);
    expect(x + y).toBe(2);
    const rows = await env.db.query(`select scheduled_at from publication where slot_id = $1 and status = 'scheduled' order by scheduled_at`, [s.id]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => new Date(r.scheduled_at).toISOString())).size).toBe(2);
    expect((await Promise.all(vs.map((v) => pubsOf(v.versionId)))).filter((p) => p.length).length).toBe(2);
    // Switching it off stops it, and switching it on again starts from then.
    const off = await setFill(false);
    expect(off.body.rules).toMatchObject({ auto_fill_slots: false, auto_fill_since: null });
  });
});
