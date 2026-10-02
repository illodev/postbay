import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

/** These rules live in the database, so they hold even for someone who skips the API. */
describe('database guarantees', () => {
  async function approvedVersion() {
    const { users, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id);
    return v.body.id as string;
  }

  it('does not let a version change, except its review state', async () => {
    const id = await approvedVersion();
    await expect(env.db.query(`update version set notes = 'sneaky edit' where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(env.db.query(`update version set fingerprint = $2 where id = $1`, [id, 'f'.repeat(64)])).rejects.toThrow(/immutable/);
    await expect(env.db.query(`delete from version where id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await expect(env.db.query(`update version set review_state = 'superseded' where id = $1`, [id])).resolves.toBeDefined();
  });

  it('does not let the files of a version be swapped or removed', async () => {
    const id = await approvedVersion();
    await expect(env.db.query(`update asset set sha256 = $2 where version_id = $1`, [id, 'e'.repeat(64)])).rejects.toThrow(/append-only/);
    await expect(env.db.query(`delete from asset where version_id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('does not let approvals be edited or deleted', async () => {
    const id = await approvedVersion();
    await expect(env.db.query(`update approval set approved_fingerprint = $2 where version_id = $1`, [id, 'd'.repeat(64)])).rejects.toThrow(/append-only/);
    await expect(env.db.query(`delete from approval where version_id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('keeps the audit log append-only', async () => {
    await approvedVersion();
    await expect(env.db.query(`update audit_event set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`delete from audit_event`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`truncate audit_event`)).rejects.toThrow(/append-only/);
  });

  it('detects files that no longer match the fingerprint and refuses to approve them', async () => {
    const { users, makePiece, newVersion, approve, db } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    // Someone with database superuser rights disables the guard and swaps a file's hash.
    await db.query('alter table asset disable trigger asset_append_only');
    await db.query(`update asset set sha256 = $2 where version_id = $1`, [v.body.id, 'c'.repeat(64)]);
    await db.query('alter table asset enable trigger asset_append_only');
    const r = await approve(users.approver, v.body.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('fingerprint_mismatch');
  });
});

describe('tampering after approval', () => {
  it('stops scheduling and publishing if the stored files stop matching the approved fingerprint', async () => {
    const { users, call, makePiece, newVersion, approve, accounts, db } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id, [accounts.instagram]);
    const when = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: accounts.instagram, scheduledAt: when });
    expect(pub.status).toBe(201);

    await db.query('alter table asset disable trigger asset_append_only');
    await db.query(`update asset set sha256 = $2 where version_id = $1`, [v.body.id, 'b'.repeat(64)]);
    await db.query('alter table asset enable trigger asset_append_only');

    const later = new Date(Date.now() + 6 * 86_400_000).toISOString();
    expect((await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: accounts.instagram, scheduledAt: later })).body.error.code).toBe('not_approved');
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, {})).body.error.code).toBe('not_approved');
  });
});

describe('isolation and access', () => {
  it('does not reveal brands, pieces or versions to people outside them', async () => {
    const { db, call, users, makePiece, newVersion, workspaceId, brandId } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);

    // A second brand with its own admin: everything in the first one must look like it does not exist.
    const other = (await db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Other','UTC') returning id`, [workspaceId]))!;
    const u = (await db.one(`insert into app_user (email) values ('outsider@example.com') returning id`))!;
    await db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'admin')`, [u.id, other.id]);
    const { createHash } = await import('node:crypto');
    await db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update('outsider-token').digest('hex'), u.id]);
    const outsider = { id: u.id as string, email: 'outsider@example.com', cookie: 'sid=outsider-token' };

    for (const [method, url] of [
      ['GET', `/api/brands/${brandId}`],
      ['GET', `/api/brands/${brandId}/pieces`],
      ['GET', `/api/pieces/${pieceId}`],
      ['GET', `/api/versions/${v.body.id}`],
      ['GET', `/api/versions/${v.body.id}/comments`],
      ['GET', `/api/brands/${brandId}/calendar?from=2030-01-01&to=2030-01-31`],
    ] as const) {
      const r = await call(outsider, method, url);
      expect(r.status, url).toBe(404);
    }
    expect((await call(outsider, 'POST', `/api/versions/${v.body.id}/approvals`, { decision: 'approve', accountIds: [env.accounts.instagram] })).status).toBe(404);
    expect((await call(outsider, 'POST', `/api/brands/${brandId}/pieces`, { title: 'x', kind: 'video' })).status).toBe(404);
    // Malformed ids are rejected before they reach the database.
    expect((await call(users.admin, 'GET', `/api/pieces/not-a-uuid`)).status).toBe(400);
  });

  it('needs a session and the anti-forgery header', async () => {
    const { app, users, brandId } = env;
    expect((await env.call(null, 'GET', `/api/brands/${brandId}`)).status).toBe(401);
    const noHeader = await app.inject({
      method: 'POST', url: `/api/brands/${brandId}/pieces`, headers: { cookie: users.admin.cookie! }, payload: { title: 'x', kind: 'video' },
    });
    expect(noHeader.statusCode).toBe(403);
    const read = await app.inject({ method: 'GET', url: `/api/brands/${brandId}`, headers: { cookie: users.admin.cookie! } });
    expect(read.statusCode).toBe(200);
  });

  it('keeps at least one admin per brand', async () => {
    const { call, users, brandId, db } = env;
    const members = await call(users.admin, 'GET', `/api/brands/${brandId}/members`);
    const admin = members.body.find((m: any) => m.role === 'admin');
    expect((await call(users.admin, 'PATCH', `/api/brands/${brandId}/members/${admin.id}`, { role: 'reviewer' })).body.error.code).toBe('last_admin');
    expect((await call(users.admin, 'DELETE', `/api/brands/${brandId}/members/${admin.id}`)).body.error.code).toBe('last_admin');
    expect((await call(users.approver, 'GET', `/api/brands/${brandId}/members`)).status).toBe(403);
    // Adding a second admin makes the change possible.
    const added = await call(users.admin, 'POST', `/api/brands/${brandId}/members`, { email: 'New.Admin@Example.com', role: 'admin' });
    expect(added.status).toBe(201);
    expect((await call(users.admin, 'PATCH', `/api/brands/${brandId}/members/${admin.id}`, { role: 'reviewer' })).status).toBe(200);
    await db.query(`update member set role = 'admin' where id = $1`, [admin.id]);
  });

  it('does not let a role change between brands: a person can be admin in one and reader in another', async () => {
    const { db, call, users, workspaceId } = env;
    const other = (await db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Second','UTC') returning id`, [workspaceId]))!;
    await db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'reader')`, [users.admin.id, other.id]);
    expect((await call(users.admin, 'GET', `/api/brands/${other.id}`)).body.role).toBe('reader');
    expect((await call(users.admin, 'PATCH', `/api/brands/${other.id}`, { name: 'Renamed' })).status).toBe(403);
    const me = await call(users.admin, 'GET', '/api/me');
    expect(me.body.brands.map((b: any) => b.role).sort()).toEqual(['admin', 'reader']);
  });
});

describe('producer tokens', () => {
  it('shows the token once, stores only its hash, and gives producer powers in one brand only', async () => {
    const { call, users, brandId, db, workspaceId, makePiece, newVersion, approve } = env;
    expect((await call(users.approver, 'POST', `/api/brands/${brandId}/tokens`, { name: 'agent' })).status).toBe(403);
    const created = await call(users.admin, 'POST', `/api/brands/${brandId}/tokens`, { name: 'agent' });
    expect(created.status).toBe(201);
    const token: string = created.body.token;
    expect(token).toMatch(/^est_/);
    const stored = await db.one('select token_hash from api_token where id = $1', [created.body.id]);
    expect(stored!.token_hash).not.toContain(token);
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await call(users.admin, 'GET', `/api/brands/${brandId}/tokens`)).body)).not.toContain(token);

    const agent = { id: created.body.id as string, email: 'agent', bearer: token };
    // A token produces…
    const { variantId, pieceId } = await makePiece(agent);
    const v = await newVersion(agent, variantId);
    expect(v.status).toBe(201);
    expect(v.body.author_token_id).toBe(agent.id);
    // …but never approves, schedules or manages.
    expect((await approve(agent, v.body.id)).status).toBe(403);
    expect((await call(agent, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: env.accounts.instagram, scheduledAt: '2031-01-01T10:00:00Z' })).status).toBe(403);
    expect((await call(agent, 'GET', `/api/brands/${brandId}/members`)).status).toBe(403);
    expect((await call(agent, 'GET', `/api/me`)).status).toBe(403);
    // An approver can approve what the agent made (the agent has no person behind it that could be the same approver).
    expect((await approve(users.approver, v.body.id)).status).toBe(201);

    // Another brand does not know it exists.
    const other = (await db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Elsewhere','UTC') returning id`, [workspaceId]))!;
    expect((await call(agent, 'GET', `/api/brands/${other.id}/pieces`)).status).toBe(404);
    expect((await call(agent, 'GET', `/api/pieces/${pieceId}`)).status).toBe(200);

    // Revoked or expired tokens stop working.
    await call(users.admin, 'DELETE', `/api/brands/${brandId}/tokens/${created.body.id}`);
    expect((await call(agent, 'GET', `/api/pieces/${pieceId}`)).status).toBe(401);
    const second = await call(users.admin, 'POST', `/api/brands/${brandId}/tokens`, { name: 'short' });
    await db.query(`update api_token set expires_at = now() - interval '1 second' where id = $1`, [second.body.id]);
    expect((await call({ id: '', email: '', bearer: second.body.token }, 'GET', `/api/pieces/${pieceId}`)).status).toBe(401);
  });

  it('stops working when whoever made it leaves the brand or stops being its admin, however that happens', async () => {
    const { call, users, brandId, db } = env;
    const memberOf = async (userId: string) => (await db.one<{ id: string }>('select id from member where user_id = $1 and brand_id = $2', [userId, brandId]))!.id;
    const tokenBy = async (who: typeof users.admin) => {
      await db.query(`update member set role = 'admin' where user_id = $1 and brand_id = $2`, [who.id, brandId]);
      const t = await call(who, 'POST', `/api/brands/${brandId}/tokens`, { name: `made by ${who.email}` });
      expect(t.status).toBe(201);
      const bearer = { id: t.body.id as string, email: 'agent', bearer: t.body.token as string };
      expect((await call(bearer, 'GET', '/api/token')).status).toBe(200);
      return bearer;
    };

    // Made a reviewer by another admin: the token is revoked, and the audit log says why.
    const demoted = await tokenBy(users.approver);
    expect((await call(users.admin, 'PATCH', `/api/brands/${brandId}/members/${await memberOf(users.approver.id)}`, { role: 'approver' })).body.tokensRevoked).toBe(1);
    expect((await call(demoted, 'GET', '/api/token')).status).toBe(401);
    expect((await db.one(`select after from audit_event where action = 'token.revoked' and entity_id = $1`, [demoted.id]))!.after).toMatchObject({ reason: 'no_longer_admin' });

    // Removed from the brand.
    const removed = await tokenBy(users.approver2);
    expect((await call(users.admin, 'DELETE', `/api/brands/${brandId}/members/${await memberOf(users.approver2.id)}`)).status).toBe(200);
    expect((await call(removed, 'GET', '/api/token')).status).toBe(401);
    expect((await db.one('select revoked_at from api_token where id = $1', [removed.id]))!.revoked_at).not.toBeNull();
    await db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'approver')`, [users.approver2.id, brandId]);

    // Changed behind the API's back: checked every time the token is used, so it stops anyway.
    const bypassed = await tokenBy(users.reviewer);
    await db.query(`update member set role = 'reviewer' where user_id = $1 and brand_id = $2`, [users.reviewer.id, brandId]);
    expect((await call(bypassed, 'GET', '/api/token')).status).toBe(401);
    await db.query(`update member set role = 'admin' where user_id = $1 and brand_id = $2`, [users.reviewer.id, brandId]);
    expect((await call(bypassed, 'GET', '/api/token')).status).toBe(200); // still the same token, not revoked: its maker is an admin again
    await db.query(`update member set role = 'reviewer' where user_id = $1 and brand_id = $2`, [users.reviewer.id, brandId]);

    // An admin who stays an admin keeps theirs, and the list says who made each one.
    const kept = await tokenBy(users.admin);
    expect((await call(kept, 'GET', '/api/token')).status).toBe(200);
    const list = (await call(users.admin, 'GET', `/api/brands/${brandId}/tokens`)).body as { id: string; created_by_email: string }[];
    expect(list.find((t) => t.id === kept.id)!.created_by_email).toBe('admin@example.com');
  });
});
