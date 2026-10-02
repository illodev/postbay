import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Actor, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

/** A person who already works for another workspace: a member there, with a session here. */
async function outsider(email: string, role = 'admin'): Promise<Actor> {
  const ws = (await env.db.one<{ id: string }>(`insert into workspace (name) values ($1) returning id`, [`Workspace of ${email}`]))!;
  const b = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,$2,'UTC') returning id`, [ws.id, `Brand of ${email}`]))!;
  const u = (await env.db.one<{ id: string }>('insert into app_user (email) values ($1) returning id', [email]))!;
  await env.db.query('insert into member (user_id, brand_id, role) values ($1,$2,$3)', [u.id, b.id, role]);
  const token = randomBytes(24).toString('base64url');
  await env.db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.id]);
  return { id: u.id, email, cookie: `sid=${token}` };
}
const isMember = async (userId: string) => !!(await env.db.one('select 1 from member where user_id = $1 and brand_id = $2', [userId, env.brandId]));
const add = (email: string, role = 'reviewer') => env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/members`, { email, role });
/** The emails to someone, once they have gone: an invitation is emailed after the answer, so it is waited for (two seconds at most). */
const mailTo = async (to: string) => {
  for (let i = 0; i < 200 && !env.mails.some((m) => m.to === to); i++) await new Promise((r) => setTimeout(r, 10));
  return env.mails.filter((m) => m.to === to);
};

describe('adding a person to a brand', () => {
  it('adds someone new, or someone already in this workspace, straight away, as before', async () => {
    const fresh = await add('Newcomer@Example.com');
    expect(fresh.status).toBe(201);
    expect(fresh.body).toMatchObject({ invited: false, role: 'reviewer', brand_id: env.brandId });
    // Someone of this workspace, in another of its brands.
    const sister = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Sister','UTC') returning id`, [env.workspaceId]))!;
    const colleague = (await env.db.one<{ id: string }>(`insert into app_user (email) values ('colleague@example.com') returning id`))!;
    await env.db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'approver')`, [colleague.id, sister.id]);
    expect((await add('colleague@example.com', 'reader')).status).toBe(201);
    expect(await isMember(colleague.id)).toBe(true);
    expect((await add('colleague@example.com')).body.error.code).toBe('already_member');
  });

  it('asks someone from another workspace first: they are emailed, and nothing changes until they accept, as themselves', async () => {
    const them = await outsider('lead@elsewhere.test');
    env.mails.length = 0;
    const r = await add('Lead@Elsewhere.test', 'approver');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ invited: true, invitation: { email: 'lead@elsewhere.test', role: 'approver' } });
    expect(await isMember(them.id)).toBe(false);
    const [mail] = await mailTo('lead@elsewhere.test');
    expect(mail!.text).toContain('admin@example.com invited you to Test brand (Test workspace) as approver');
    expect(mail!.text).toContain('Nothing changes until you accept');

    // The brand's admins see it waiting; the person sees it on /api/me and in their own list.
    const waiting = (await env.call(env.users.admin, 'GET', `/api/brands/${env.brandId}/invitations`)).body;
    expect(waiting).toEqual([expect.objectContaining({ id: r.body.invitation.id, email: 'lead@elsewhere.test', role: 'approver', invited_by: 'admin@example.com' })]);
    expect((await env.call(env.users.approver, 'GET', `/api/brands/${env.brandId}/invitations`)).status).toBe(403);
    expect((await env.call(them, 'GET', '/api/me')).body.invitations).toHaveLength(1);
    const mine = (await env.call(them, 'GET', '/api/invitations')).body;
    expect(mine).toEqual([expect.objectContaining({ brand: 'Test brand', workspace: 'Test workspace', role: 'approver' })]);

    // Nobody else can answer for them: not another person, not a producer token.
    const id = r.body.invitation.id as string;
    expect((await env.call(env.users.reviewer, 'POST', `/api/invitations/${id}/accept`)).status).toBe(404);
    const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'script' });
    expect((await env.call({ id: 't', email: 't', bearer: tok.body.token }, 'POST', `/api/invitations/${id}/accept`)).status).toBe(403);
    expect(await isMember(them.id)).toBe(false);

    // They accept: a member with the role they were offered, and both steps are on record.
    const ok = await env.call(them, 'POST', `/api/invitations/${id}/accept`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ answer: 'accepted', role: 'approver' });
    expect((await env.db.one('select role from member where user_id = $1 and brand_id = $2', [them.id, env.brandId]))!.role).toBe('approver');
    const trail = await env.db.query(`select action, after from audit_event where brand_id = $1 and action in ('member.invited','member.added') and (after->>'email') = 'lead@elsewhere.test' order by id`, [env.brandId]);
    expect(trail.map((t) => [t.action, t.after.via ?? null])).toEqual([['member.invited', null], ['member.added', 'invitation']]);
    expect((await env.call(them, 'POST', `/api/invitations/${id}/accept`)).status).toBe(404); // once
    expect((await env.call(them, 'GET', '/api/invitations')).body).toEqual([]);
  });

  it('can be declined, cancelled, or left to expire, and is never sent twice at once', async () => {
    const them = await outsider('maybe@elsewhere.test', 'reviewer');
    const first = await add('maybe@elsewhere.test');
    expect(first.status).toBe(202);
    expect((await add('maybe@elsewhere.test')).body.error.code).toBe('already_invited');

    // Cancelled by the brand: it can no longer be accepted.
    expect((await env.call(env.users.admin, 'DELETE', `/api/brands/${env.brandId}/invitations/${first.body.invitation.id}`)).status).toBe(200);
    expect((await env.call(them, 'POST', `/api/invitations/${first.body.invitation.id}/accept`)).status).toBe(404);

    // Declined by the person.
    const second = await add('maybe@elsewhere.test');
    expect(second.status).toBe(202);
    expect((await env.call(them, 'POST', `/api/invitations/${second.body.invitation.id}/decline`)).body.answer).toBe('declined');
    expect(await isMember(them.id)).toBe(false);

    // Expired: it cannot be accepted, and does not stand in the way of a new one.
    const third = await add('maybe@elsewhere.test');
    await env.db.query(`update member_invitation set expires_at = now() - interval '1 second' where id = $1`, [third.body.invitation.id]);
    expect((await env.call(them, 'POST', `/api/invitations/${third.body.invitation.id}/accept`)).status).toBe(404);
    expect((await env.call(env.users.admin, 'GET', `/api/brands/${env.brandId}/invitations`)).body.some((i: any) => i.id === third.body.invitation.id)).toBe(false);
    const fourth = await add('maybe@elsewhere.test');
    expect(fourth.status).toBe(202);
    expect((await env.db.one('select answer from member_invitation where id = $1', [third.body.invitation.id]))!.answer).toBe('expired');
    expect(await isMember(them.id)).toBe(false);
  });
});
