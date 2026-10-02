import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSlotAlerts } from '../src/services/slots.js';
import { createEnv, type Actor, type Env } from './helpers.js';

/**
 * A piece made for a slot is scheduled at that slot when it is approved, unless the approver unticks it, and the version says
 * beforehand what would happen. Always after a person's approval: nothing here schedules what is not approved.
 */
let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const ZONE = 'Europe/Madrid';
let n = 0;
/** A manual account of its own, so each test's slots and calendar do not meet the others'. */
async function account(network = 'instagram') {
  const name = `@acc${++n}`;
  return (await env.db.one<{ id: string }>(`insert into social_account (brand_id, network, external_id, display_name) values ($1,$2,$3,$3) returning id`, [env.brandId, network, name]))!.id;
}
/** A weekly slot on the weekday `daysAhead` days from today (in the brand's zone), and that occurrence. */
async function slot(accountId: string, daysAhead: number, time = '19:00', label = 'Reel de la semana') {
  const day = DateTime.now().setZone(ZONE).plus({ days: daysAhead });
  const r = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/slots`, { accountId, weekday: day.weekday, localTime: time, label });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const at = DateTime.fromISO(`${day.toISODate()}T${time}`, { zone: ZONE });
  return { id: r.body.id as string, at: at.toUTC().toISO()!, local: at };
}
/** A video piece made for a slot occurrence, with one version in review. */
async function slotPiece(link: { id: string; at: string } | null, as: Actor = env.users.producer) {
  const p = await env.call(as, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'For the slot', kind: 'video', ...(link ? { slot: link } : {}) });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const v = await env.call(as, 'POST', `/api/pieces/${p.body.id}/variants`, { format: '9:16' });
  const ver = await env.newVersion(env.users.producer, v.body.id);
  expect(ver.status, JSON.stringify(ver.body)).toBe(201);
  return { pieceId: p.body.id as string, variantId: v.body.id as string, versionId: ver.body.id as string };
}
const pubsOf = (versionId: string) => env.db.query('select * from publication where version_id = $1 order by created_at', [versionId]);

describe('a piece made for a slot', () => {
  it('says beforehand what approving it will schedule, and schedules it there when approved, by the approver, with the text they gave', async () => {
    const ig = await account();
    const s = await slot(ig, 3);
    const { pieceId, versionId } = await slotPiece({ id: s.id, at: s.at });
    expect((await env.call(env.users.reviewer, 'GET', `/api/pieces/${pieceId}`)).body.slot).toMatchObject({ id: s.id, label: 'Reel de la semana', removed: false, account: { id: ig } });

    const en = (await env.call(env.users.approver, 'GET', `/api/versions/${versionId}`)).body;
    expect(en.slot_schedule).toMatchObject({
      ready: true, code: null, reason: null, slot: { id: s.id, label: 'Reel de la semana' }, account: { id: ig, network: 'instagram' },
      at: new Date(s.at).toISOString(), day: s.local.toISODate(), time: '19:00', timezone: ZONE,
      summary: `It will be scheduled on ${s.local.setLocale('en-GB').toFormat('cccc d')} at 19:00 on ${en.slot_schedule.account.display_name} (slot "Reel de la semana")`,
    });
    const es = (await env.callIn('es', env.users.approver, 'GET', `/api/versions/${versionId}`)).body;
    expect(es.slot_schedule.summary).toBe(`Se programará el ${s.local.setLocale('es').toFormat('cccc d')} a las 19:00 en ${en.slot_schedule.account.display_name} (hueco «Reel de la semana»)`);
    expect(en.auto_fill_slots).toBe(false);

    const r = await env.approve(env.users.approver, versionId, [ig], { scheduleText: 'Nuevo menú, esta semana', scheduleFirstComment: '#menu' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ review_state: 'approved', slot_schedule: { scheduled: true, at: new Date(s.at).toISOString(), publication: { status: 'scheduled', scheduled_by: 'person' } } });
    const [pub] = await pubsOf(versionId);
    expect(pub).toMatchObject({ social_account_id: ig, slot_id: s.id, scheduled_by: 'person', created_by: env.users.approver.id, text: 'Nuevo menú, esta semana', first_comment: '#menu', manual: true });
    expect(new Date(pub!.scheduled_at).toISOString()).toBe(new Date(s.at).toISOString());
    // On record as the approver's scheduling, and the calendar shows the slot filled by it.
    expect((await env.db.one(`select actor_user_id, after from audit_event where action = 'publication.scheduled' and entity_id = $1`, [pub!.id]))).toMatchObject({ actor_user_id: env.users.approver.id, after: { scheduled_by: 'person', slot_id: s.id } });
    const cal = (await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/calendar?from=${s.local.toISODate()}&to=${s.local.toISODate()}`)).body;
    expect(cal.slots.find((x: any) => x.id === s.id)).toMatchObject({ filled: true });
    expect(cal.publications.find((x: any) => x.id === pub!.id)).toMatchObject({ scheduled_by: 'person', scheduled_by_name: 'approver', slot_id: s.id });
    // Asked again, it says it is there already.
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${versionId}`)).body.slot_schedule).toMatchObject({ ready: false, code: 'already_scheduled', publication_id: pub!.id });
  });

  it('is not scheduled when the approver unticks it, nor when it was not approved for the slot\'s account, and the answer says why', async () => {
    const ig = await account();
    const other = await account();
    const s = await slot(ig, 4);
    const a = await slotPiece({ id: s.id, at: s.at });
    const unticked = await env.approve(env.users.approver, a.versionId, [ig], { autoSchedule: false });
    expect(unticked.body).toMatchObject({ review_state: 'approved', slot_schedule: { scheduled: false, code: 'unticked', reason: 'Whoever approved it chose not to schedule it' } });
    expect(await pubsOf(a.versionId)).toHaveLength(0);
    expect((await env.db.one('select auto_schedule from approval where version_id = $1', [a.versionId]))!.auto_schedule).toBe(false);

    const b = await slotPiece({ id: s.id, at: s.at });
    const elsewhere = await env.callIn('es', env.users.approver, 'POST', `/api/versions/${b.versionId}/approvals`, { decision: 'approve', accountIds: [other] });
    expect(elsewhere.body.slot_schedule).toMatchObject({ scheduled: false, code: 'account_not_approved' });
    expect(elsewhere.body.slot_schedule.reason).toMatch(/^No se ha aprobado para @acc\d+, la cuenta del hueco$/);
    expect(await pubsOf(b.versionId)).toHaveLength(0);
  });

  it('is not scheduled when the slot\'s time has passed, the brand is paused, the day is blocked or the slot is taken', async () => {
    const ig = await account();
    // An occurrence of last week.
    const past = await slot(ig, -7, '10:00', 'Lunes');
    const a = await slotPiece({ id: past.id, at: past.at });
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${a.versionId}`)).body.slot_schedule).toMatchObject({ ready: false, code: 'time_passed', summary: null });
    expect((await env.approve(env.users.approver, a.versionId, [ig])).body.slot_schedule).toMatchObject({ scheduled: false, code: 'time_passed', reason: "The slot's time has passed: schedule it yourself at another time" });

    const s = await slot(ig, 5, '12:00', '');
    const b = await slotPiece({ id: s.id, at: s.at });
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: true });
    expect((await env.approve(env.users.approver, b.versionId, [ig])).body.slot_schedule.code).toBe('brand_paused');
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: false });

    const c = await slotPiece({ id: s.id, at: s.at });
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day: s.local.toISODate(), reason: 'Fiesta' });
    expect((await env.approve(env.users.approver, c.versionId, [ig])).body.slot_schedule).toMatchObject({ code: 'blocked_date', reason: `Nothing is published on ${s.local.toISODate()} (Fiesta)` });
    await env.call(env.users.approver, 'DELETE', `/api/brands/${env.brandId}/blocked-dates/${s.local.toISODate()}`);

    // Someone schedules something else on that account at that time: the slot is taken.
    const d = await slotPiece(null);
    await env.approve(env.users.approver, d.versionId, [ig]);
    expect((await env.call(env.users.approver, 'POST', `/api/versions/${d.versionId}/publications`, { accountId: ig, scheduledAt: s.at })).status).toBe(201);
    const e = await slotPiece({ id: s.id, at: s.at });
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${e.versionId}`)).body.slot_schedule.code).toBe('slot_taken');
    expect((await env.approve(env.users.approver, e.versionId, [ig])).body.slot_schedule).toMatchObject({ scheduled: false, code: 'slot_taken' });
    // Each of these is approved all the same: the scheduling never makes an approval fail.
    for (const x of [a, b, c, e]) expect((await env.db.one('select review_state from version where id = $1', [x.versionId]))!.review_state).toBe('approved');
    expect(await env.db.query(`select 1 from publication where slot_id is not null and social_account_id = $1`, [ig])).toHaveLength(0);
  });

  it('waits for every approval the brand needs, and any approver can untick it', async () => {
    await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { required_approvals: 2 } });
    try {
      const ig = await account();
      const s = await slot(ig, 6, '18:30');
      const a = await slotPiece({ id: s.id, at: s.at });
      expect((await env.approve(env.users.approver, a.versionId, [ig])).body).toMatchObject({ review_state: 'in_review', slot_schedule: { scheduled: false, code: 'awaiting_approvals' } });
      expect((await env.approve(env.users.approver2, a.versionId, [ig], { scheduleText: 'from the second' })).body.slot_schedule).toMatchObject({ scheduled: true });
      expect((await pubsOf(a.versionId))[0]).toMatchObject({ created_by: env.users.approver2.id, text: 'from the second' });

      const b = await slotPiece({ id: s.id, at: DateTime.fromISO(s.at).plus({ weeks: 1 }).toUTC().toISO()! });
      await env.approve(env.users.approver, b.versionId, [ig], { autoSchedule: false });
      expect((await env.approve(env.users.approver2, b.versionId, [ig])).body.slot_schedule.code).toBe('unticked');
    } finally {
      await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { required_approvals: 1 } });
    }
  });

  it('takes only a real occurrence of a slot of the brand, and can be unlinked', async () => {
    const ig = await account();
    const s = await slot(ig, 2);
    const wrongTime = DateTime.fromISO(s.at).plus({ minutes: 30 }).toUTC().toISO()!;
    const wrongDay = DateTime.fromISO(s.at).plus({ days: 1 }).toUTC().toISO()!;
    for (const at of [wrongTime, wrongDay]) {
      const r = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'x', kind: 'video', slot: { id: s.id, at } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_slot');
    }
    const none = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'x', kind: 'video', slot: { id: '00000000-0000-0000-0000-000000000000', at: s.at } });
    expect(none.body.error).toMatchObject({ code: 'invalid_slot', message: 'That slot does not belong to this brand' });
    const { pieceId, versionId } = await slotPiece(null);
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${versionId}`)).body.slot_schedule).toBeNull();
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { slot: { id: s.id, at: s.at } })).body).toMatchObject({ slot_id: s.id });
    expect((await env.call(env.users.approver, 'GET', `/api/versions/${versionId}`)).body.slot_schedule.ready).toBe(true);
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { slot: null })).body).toMatchObject({ slot_id: null, slot_at: null });
    // A slot removed after the piece was made for it: the piece says so, and approving it schedules nothing.
    const t = await slot(ig, 2, '08:00');
    const linked = await slotPiece({ id: t.id, at: t.at });
    await env.call(env.users.admin, 'DELETE', `/api/brands/${env.brandId}/slots/${t.id}`);
    expect((await env.call(env.users.reviewer, 'GET', `/api/pieces/${linked.pieceId}`)).body.slot).toMatchObject({ removed: true, account: null });
    expect((await env.approve(env.users.approver, linked.versionId, [ig])).body.slot_schedule).toMatchObject({ scheduled: false, code: 'slot_removed' });
  });

  it('is linked to its slot by itself when an agent makes it in a run started by slot.needs_content', async () => {
    await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_cost_per_piece: 5, max_cost_per_month: 50, slot_alert_days: 3 } });
    const ig = await account();
    const s = await slot(ig, 2, '20:00', 'Empty slot');
    await scanSlotAlerts(env.ctx);
    const ev = (await env.db.one<{ id: string; data: any }>(`select id, data from event where type = 'slot.needs_content' and data->'slot'->>'id' = $1`, [s.id]))!;
    expect(new Date(ev.data.slot.at).toISOString()).toBe(new Date(s.at).toISOString());
    const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Runner' });
    const bot: Actor = { id: 'bot', email: 'bot', bearer: tok.body.token };
    const run = await env.call(bot, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'slot.needs_content', eventId: ev.id });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const piece = await env.call(bot, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'Made for the empty slot', kind: 'video' });
    expect(piece.body).toMatchObject({ slot_id: s.id });
    expect(new Date(piece.body.slot_at).toISOString()).toBe(new Date(s.at).toISOString());
    // Outside such a run, a token's piece is made for nothing in particular.
    await env.call(bot, 'POST', `/api/agent-runs/${run.body.id}/finish`, { outcome: 'aborted' });
    expect((await env.call(bot, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'Later', kind: 'video' })).body.slot_id).toBeNull();
  });
});
