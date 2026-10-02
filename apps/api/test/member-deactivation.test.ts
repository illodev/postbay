import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendPendingEmails } from '../src/background.js';
import { sendPendingPush } from '../src/services/push.js';
import { createEnv, type Actor, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); brandUrl = `/api/brands/${env.brandId}`; });
afterAll(async () => { await env.close(); });

/** Someone new in the test brand (or another), with a session. */
async function person(label: string, role: string, brandId = env.brandId): Promise<Actor & { memberId: string }> {
  const email = `${label}@example.com`;
  const u = (await env.db.one<{ id: string }>('insert into app_user (email, name) values ($1,$2) returning id', [email, label]))!;
  const m = (await env.db.one<{ id: string }>('insert into member (user_id, brand_id, role) values ($1,$2,$3) returning id', [u.id, brandId, role]))!;
  const token = randomBytes(24).toString('base64url');
  await env.db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.id]);
  return { id: u.id, email, cookie: `sid=${token}`, memberId: m.id };
}
const memberId = async (userId: string) => (await env.db.one<{ id: string }>('select id from member where user_id = $1 and brand_id = $2', [userId, env.brandId]))!.id;
const url = (id: string, action: 'deactivate' | 'reactivate') => `/api/brands/${env.brandId}/members/${id}/${action}`;
let brandUrl: string;

describe('deactivating a member', () => {
  it('keeps them out of the brand, with a code that says why, until they are reactivated, and lists who did it and when', async () => {
    const ana = await person('ana', 'reviewer');
    expect((await env.call(ana, 'GET', brandUrl)).status).toBe(200);

    const off = await env.call(env.users.admin, 'POST', url(ana.memberId, 'deactivate'));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ id: ana.memberId, active: false, tokensRevoked: 0 });

    // Anything of the brand: refused, and said in the reader's language.
    const en = await env.call(ana, 'GET', brandUrl);
    expect(en.status).toBe(403);
    expect(en.body.error).toMatchObject({ code: 'member_deactivated', message: 'You have been deactivated in this brand: you cannot open it until an admin reactivates you' });
    const es = await env.callIn('es', ana, 'GET', `${brandUrl}/pieces`);
    expect(es.body.error).toMatchObject({ code: 'member_deactivated', message: 'Te han desactivado en esta marca: no puedes abrirla hasta que un administrador te reactive' });
    const { pieceId } = await env.makePiece(env.users.producer);
    expect((await env.call(ana, 'GET', `/api/pieces/${pieceId}`)).body.error.code).toBe('member_deactivated');
    // Someone who never belonged still does not learn the brand exists.
    const stranger = await person('stranger', 'reader');
    await env.db.query('delete from member where id = $1', [stranger.memberId]);
    expect((await env.call(stranger, 'GET', brandUrl)).status).toBe(404);

    // Their own page no longer offers the brand, and says where they were deactivated.
    const me = (await env.call(ana, 'GET', '/api/me')).body;
    expect(me.brands.some((b: any) => b.id === env.brandId)).toBe(false);
    expect(me.deactivated_in).toEqual([expect.objectContaining({ id: env.brandId, name: 'Test brand' })]);

    // The member list shows them as deactivated, by whom and when, after the active ones.
    const list = (await env.call(env.users.admin, 'GET', `${brandUrl}/members`)).body as any[];
    const row = list.find((m) => m.id === ana.memberId);
    expect(row).toMatchObject({ active: false, deactivated_by: 'admin', role: 'reviewer' });
    expect(new Date(row.deactivated_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(list.findIndex((m) => m.id === ana.memberId)).toBe(list.length - 1);
    expect(list.filter((m) => m.active).length).toBe(list.length - 1);

    // Twice is refused; reactivating lets them back with the same role.
    expect((await env.call(env.users.admin, 'POST', url(ana.memberId, 'deactivate'))).body.error.code).toBe('already_deactivated');
    const on = await env.call(env.users.admin, 'POST', url(ana.memberId, 'reactivate'));
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ active: true, role: 'reviewer', tokensStillRevoked: 0 });
    expect((await env.call(ana, 'GET', brandUrl)).status).toBe(200);
    expect((await env.call(env.users.admin, 'POST', url(ana.memberId, 'reactivate'))).body.error.code).toBe('not_deactivated');
    expect((await env.call(env.users.admin, 'GET', `${brandUrl}/members`)).body.find((m: any) => m.id === ana.memberId)).toMatchObject({ active: true, deactivated_at: null, deactivated_by: null });

    // Both steps are on record.
    const trail = await env.db.query(`select action, before, after from audit_event where entity = 'member' and entity_id = $1 order by id`, [ana.memberId]);
    expect(trail.map((t) => t.action)).toEqual(['member.deactivated', 'member.reactivated']);
    expect(trail[0]!.after).toMatchObject({ active: false, role: 'reviewer', email: 'ana@example.com' });
  });

  it('is for admins only, never of oneself, and someone already a member cannot be added again while deactivated', async () => {
    const bea = await person('bea', 'reader');
    for (const who of [env.users.approver, env.users.reviewer, env.users.producer]) {
      expect((await env.call(who, 'POST', url(bea.memberId, 'deactivate'))).status).toBe(403);
    }
    const tok = await env.call(env.users.admin, 'POST', `${brandUrl}/tokens`, { name: 'script' });
    expect((await env.call({ id: 't', email: 't', bearer: tok.body.token }, 'POST', url(bea.memberId, 'deactivate'))).status).toBe(403);
    const self = await env.call(env.users.admin, 'POST', url(await memberId(env.users.admin.id), 'deactivate'));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('cannot_deactivate_self');
    expect((await env.call(env.users.admin, 'POST', url('00000000-0000-0000-0000-000000000000', 'deactivate'))).status).toBe(404);

    expect((await env.call(env.users.admin, 'POST', url(bea.memberId, 'deactivate'))).status).toBe(200);
    const again = await env.call(env.users.admin, 'POST', `${brandUrl}/members`, { email: 'bea@example.com', role: 'reader' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'already_member', details: { deactivated: true } });
    expect(again.body.error.message).toContain('reactivate them');
  });

  it('never leaves the brand without an active admin: a deactivated admin does not count', async () => {
    // A brand of its own with two admins, who take each other out at the same moment: one of them is refused.
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Duo','UTC') returning id`, [env.workspaceId]))!.id;
    const carla = await person('carla', 'admin', other);
    const dani = await person('dani', 'admin', other);
    const at = (id: string) => `/api/brands/${other}/members/${id}/deactivate`;
    const [a, b] = await Promise.all([env.call(carla, 'POST', at(dani.memberId)), env.call(dani, 'POST', at(carla.memberId))]);
    expect([a.status, b.status]).toContain(200);
    const refused = [a, b].find((r) => r.status !== 200)!;
    // Refused either as the last active admin (both got in at once) or because its sender had just been deactivated.
    expect(['last_admin', 'member_deactivated']).toContain(refused.body.error.code);
    expect((await env.db.one<{ n: number }>(`select count(*)::int as n from member where brand_id = $1 and role = 'admin' and deactivated_at is null`, [other]))!.n).toBe(1);

    // In the test brand: with every other admin deactivated, admin cannot step down or leave, though deactivated admins exist.
    const eli = await person('eli', 'admin');
    const fran = await person('fran', 'admin');
    expect((await env.call(env.users.admin, 'POST', url(eli.memberId, 'deactivate'))).status).toBe(200);
    expect((await env.call(env.users.admin, 'POST', url(fran.memberId, 'deactivate'))).status).toBe(200);
    const adminMember = await memberId(env.users.admin.id);
    const demote = await env.call(env.users.admin, 'PATCH', `${brandUrl}/members/${adminMember}`, { role: 'approver' });
    expect(demote.body.error).toMatchObject({ code: 'last_admin', message: 'A brand needs at least one admin' });
    expect((await env.call(env.users.admin, 'DELETE', `${brandUrl}/members/${adminMember}`)).body.error.code).toBe('last_admin');
    // A deactivated admin can be demoted or removed: the active one stays.
    expect((await env.call(env.users.admin, 'PATCH', `${brandUrl}/members/${eli.memberId}`, { role: 'reviewer' })).status).toBe(200);
    expect((await env.call(env.users.admin, 'DELETE', `${brandUrl}/members/${fran.memberId}`)).status).toBe(200);
  });

  it('revokes the producer tokens they made for the brand, which stay revoked when they come back', async () => {
    const eva = await person('eva', 'admin');
    const made = await env.call(eva, 'POST', `${brandUrl}/tokens`, { name: "Eva's runner" });
    expect(made.status).toBe(201);
    const bot: Actor = { id: 'bot', email: 'bot', bearer: made.body.token };
    expect((await env.call(bot, 'GET', '/api/token')).status).toBe(200);

    const off = await env.call(env.users.admin, 'POST', url(eva.memberId, 'deactivate'));
    expect(off.body.tokensRevoked).toBe(1);
    expect((await env.call(bot, 'GET', '/api/token')).status).toBe(401);
    expect((await env.db.one(`select after from audit_event where action = 'token.revoked' and entity_id = $1`, [made.body.id]))!.after).toMatchObject({ reason: 'member_deactivated' });
    // Even a token whose revocation was lost (a change made in the database) does not work for a deactivated maker.
    await env.db.query('update api_token set revoked_at = null where id = $1', [made.body.id]);
    expect((await env.call(bot, 'GET', '/api/token')).status).toBe(401);
    await env.db.query('update api_token set revoked_at = now() where id = $1', [made.body.id]);

    const on = await env.call(env.users.admin, 'POST', url(eva.memberId, 'reactivate'));
    expect(on.body).toMatchObject({ active: true, role: 'admin', tokensStillRevoked: 1 });
    expect((await env.call(bot, 'GET', '/api/token')).status).toBe(401);
    expect((await env.call(eva, 'GET', `${brandUrl}/tokens`)).body.find((t: any) => t.id === made.body.id).revoked_at).not.toBeNull();
  });

  it('tells them nothing about the brand while deactivated, not even what was already waiting to be emailed, and keeps their history', async () => {
    const fede = await person('fede', 'approver');
    const { pieceId, variantId } = await env.makePiece(env.users.producer);
    const v1 = await env.newVersion(env.users.producer, variantId);
    // Something of theirs in the record before: a comment and an approval.
    const c = await env.call(fede, 'POST', `/api/versions/${v1.body.id}/comments`, { body: 'Nice cut' });
    expect(c.status).toBe(201);
    await env.call(fede, 'POST', `/api/comments/${c.body.id}/resolve`);
    expect((await env.approve(fede, v1.body.id)).status).toBe(201);
    while ((await sendPendingEmails(env.ctx)) > 0);
    await sendPendingPush(env.ctx);

    // A notification for them that has not been emailed yet when they are deactivated is never emailed.
    const v2 = await env.newVersion(env.users.producer, variantId);
    const waiting = await env.db.query(`select id from notification where user_id = $1 and payload->>'versionId' = $2`, [fede.id, v2.body.id]);
    expect(waiting).toHaveLength(1);
    env.mails.length = 0;
    expect((await env.call(env.users.admin, 'POST', url(fede.memberId, 'deactivate'))).status).toBe(200);
    while ((await sendPendingEmails(env.ctx)) > 0);
    expect(env.mails.some((m) => m.to === 'fede@example.com')).toBe(false);
    expect(env.mails.some((m) => m.to === 'approver@example.com')).toBe(true); // the others still get theirs

    // Nothing new is made for them, while the others are told.
    const v3 = await env.newVersion(env.users.producer, variantId);
    expect(await env.db.query(`select 1 from notification where user_id = $1 and payload->>'versionId' = $2`, [fede.id, v3.body.id])).toHaveLength(0);
    expect(await env.db.query(`select 1 from notification where user_id = $1 and payload->>'versionId' = $2`, [env.users.approver.id, v3.body.id])).toHaveLength(1);
    // The bell does not show the brand's older ones either.
    expect((await env.call(fede, 'GET', '/api/notifications')).body.items).toEqual([]);

    // Their comment and approval still carry their name for everyone else.
    const comments = (await env.call(env.users.reviewer, 'GET', `/api/versions/${v3.body.id}/comments?carried=true&status=resolved`)).body as any[];
    const old = (await env.call(env.users.reviewer, 'GET', `/api/versions/${v1.body.id}/comments`)).body as any[];
    expect([...comments, ...old].find((x) => x.id === c.body.id)?.author).toBe('fede');
    const version = (await env.call(env.users.reviewer, 'GET', `/api/versions/${v1.body.id}`)).body;
    expect(version.approvals).toEqual([expect.objectContaining({ approver: 'fede', decision: 'approve' })]);
    const audit = (await env.call(env.users.admin, 'GET', `${brandUrl}/audit?entity=version&entityId=${v1.body.id}`)).body as any[];
    expect(audit.find((a) => a.action === 'version.approved').actor).toBe('fede');

    // Back again: notified as before, and the bell shows the brand again.
    await env.call(env.users.admin, 'POST', url(fede.memberId, 'reactivate'));
    const v4 = await env.newVersion(env.users.producer, variantId);
    expect(await env.db.query(`select 1 from notification where user_id = $1 and payload->>'versionId' = $2`, [fede.id, v4.body.id])).toHaveLength(1);
    expect((await env.call(fede, 'GET', '/api/notifications')).body.items.length).toBeGreaterThan(0);
    expect(pieceId).toBeTruthy();
  });
});
