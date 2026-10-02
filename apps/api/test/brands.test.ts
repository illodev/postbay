import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

describe('creating a brand from the app', () => {
  it('lets an admin create a brand in the same workspace, and makes them its only admin', async () => {
    const r = await env.call(env.users.admin, 'POST', '/api/brands', { fromBrandId: env.brandId, name: 'Personal', timezone: 'Europe/Madrid', locale: 'en' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Personal', timezone: 'Europe/Madrid', locale: 'en', role: 'admin' });
    const row = await env.db.one<{ workspace_id: string }>('select workspace_id from brand where id = $1', [r.body.id]);
    expect(row!.workspace_id).toBe(env.workspaceId);
    const members = await env.db.query<{ user_id: string; role: string }>('select user_id, role from member where brand_id = $1', [r.body.id]);
    expect(members).toEqual([{ user_id: env.users.admin.id, role: 'admin' }]);
    const me = await env.call(env.users.admin, 'GET', '/api/me');
    expect(me.body.brands.map((b: { name: string }) => b.name)).toContain('Personal');
    const audited = await env.db.one('select 1 from audit_event where action = $1 and brand_id = $2', ['brand.created_sibling', env.brandId]);
    expect(audited).toBeTruthy();
  });

  it('refuses anyone who is not an admin of the brand they start from', async () => {
    for (const who of ['approver', 'reviewer', 'producer', 'reader'] as const) {
      const r = await env.call(env.users[who], 'POST', '/api/brands', { fromBrandId: env.brandId, name: `Not by ${who}`, timezone: 'UTC' });
      expect(r.status).toBe(403);
    }
    expect(await env.db.one(`select 1 from brand where name like 'Not by %'`)).toBeNull();
  });

  it('checks the time zone and the name', async () => {
    expect((await env.call(env.users.admin, 'POST', '/api/brands', { fromBrandId: env.brandId, name: 'X', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await env.call(env.users.admin, 'POST', '/api/brands', { fromBrandId: env.brandId, name: '  ', timezone: 'UTC' })).status).toBe(400);
  });
});
