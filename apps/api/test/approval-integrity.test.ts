import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalStorage } from '../src/storage/local.js';
import { createEnv, type Actor, type Env } from './helpers.js';

/**
 * What was approved is what goes out: the files as they are stored, the title and the AI label, and nothing a producer does after
 * the approval changes it or takes it off the calendar.
 */
let env: Env;
let yt: string, ig: string;
let token: Actor;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  yt = await env.connect('youtube');
  ig = await env.connect('instagram');
  const t = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  token = { id: t.body.id, email: 'agent', bearer: t.body.token };
  await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_cost_per_piece: 5, max_cost_per_month: 500 } });
});
afterAll(async () => { await env.close(); });

const MIN = 60_000;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
const row = async (id: string) => (await env.db.one('select * from publication where id = $1', [id]))!;
const file = (name = 'clip.mp4') => [{ name, mime: 'video/mp4', kind: 'video', data: Buffer.from(`take ${randomUUID()}`) }];

async function approvedPiece(o: { title?: string; aiGenerated?: boolean; account?: string; format?: string } = {}) {
  const { users, call } = env;
  const p = await call(users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: o.title ?? 'Spring menu', kind: 'video', aiGenerated: o.aiGenerated ?? false });
  const variant = await call(users.producer, 'POST', `/api/pieces/${p.body.id}/variants`, { format: o.format ?? '16:9' });
  const v = await env.newVersion(users.producer, variant.body.id, file());
  expect(v.status).toBe(201);
  expect((await env.approve(users.approver, v.body.id, [o.account ?? yt])).body.review_state).toBe('approved');
  return { pieceId: p.body.id as string, variantId: variant.body.id as string, versionId: v.body.id as string };
}
const schedule = (versionId: string, extra: Record<string, unknown> = {}) =>
  env.call(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, { accountId: yt, scheduledAt: at(2 * 60 * MIN).toISOString(), text: 'A longer look', ...extra });

describe('what goes out with the files is what was approved', () => {
  it('sends the approved title and AI label, whatever a producer changes after the approval', async () => {
    const { pieceId, versionId } = await approvedPiece({ title: 'Spring menu', aiGenerated: true });
    // After the approval, a producer renames the piece and tries to take the AI label away.
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { title: 'Something else entirely' })).status).toBe(200);
    const off = await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { aiGenerated: false });
    expect(off.status).toBe(403);
    expect((await env.db.one('select ai_generated from piece where id = $1', [pieceId]))!.ai_generated).toBe(true);

    const pub = await schedule(versionId);
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(pub.body).toMatchObject({ title: 'Spring menu', ai_generated: true });
    env.clock.set(new Date(pub.body.prepare_at));
    await env.settle();
    const video = env.google.videos.get((await row(pub.body.id)).handle.videoId)!;
    expect(video.snippet.title).toBe('Spring menu');
    expect(video.status.containsSyntheticMedia).toBe(true);
  });

  it('still adds an AI label set after the approval, and lets an approver take one away', async () => {
    const { pieceId, versionId } = await approvedPiece({ title: 'Autumn menu', aiGenerated: false });
    const pub = await schedule(versionId);
    // Adding the label is always allowed, and it goes out even though the approval did not have it.
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { aiGenerated: true })).status).toBe(200);
    env.clock.set(new Date(pub.body.prepare_at));
    await env.settle();
    expect(env.google.videos.get((await row(pub.body.id)).handle.videoId)!.status.containsSyntheticMedia).toBe(true);
    // A token cannot take it away either; an approver can.
    expect((await env.call(token, 'PATCH', `/api/pieces/${pieceId}`, { aiGenerated: false })).status).toBe(403);
    expect((await env.call(env.users.approver, 'PATCH', `/api/pieces/${pieceId}`, { aiGenerated: false })).status).toBe(200);
  });

  it('lets an approver set the title that goes out on the publication itself', async () => {
    const { versionId } = await approvedPiece({ title: 'Winter menu' });
    const pub = await schedule(versionId);
    const changed = await env.call(env.users.approver, 'PATCH', `/api/publications/${pub.body.id}`, { title: 'Winter menu, the long cut' });
    expect(changed.body.title).toBe('Winter menu, the long cut');
    expect((await env.call(env.users.producer, 'PATCH', `/api/publications/${pub.body.id}`, { title: 'Mine' })).status).toBe(403);
  });
});

describe('editing a piece', () => {
  it('changes only what is sent: a new title keeps the brief and the AI label', async () => {
    const p = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'Draft', kind: 'video', brief: 'Keep this', aiGenerated: true });
    const edited = await env.call(env.users.producer, 'PATCH', `/api/pieces/${p.body.id}`, { title: 'Better title' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Better title', brief: 'Keep this', ai_generated: true });
  });
});

describe('discarding a piece', () => {
  it('is a producer\'s only while nothing is approved or scheduled; after that it is an approver\'s', async () => {
    const { pieceId: draft } = await (async () => {
      const p = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'Draft', kind: 'video' });
      return { pieceId: p.body.id as string };
    })();
    expect((await env.call(env.users.producer, 'POST', `/api/pieces/${draft}/discard`)).status).toBe(200);

    const { pieceId, versionId } = await approvedPiece();
    for (const who of [env.users.producer, token]) {
      const r = await env.call(who, 'POST', `/api/pieces/${pieceId}/discard`);
      expect(r.status).toBe(403);
    }
    const pub = await schedule(versionId);
    expect((await env.call(token, 'POST', `/api/pieces/${pieceId}/discard`)).status).toBe(403);
    expect((await row(pub.body.id)).status).toBe('scheduled'); // the calendar is untouched
    expect((await env.call(env.users.approver, 'POST', `/api/pieces/${pieceId}/discard`)).status).toBe(200);
    expect((await row(pub.body.id)).status).toBe('cancelled');
  });
});

describe('who uploaded what is being decided on', () => {
  it('names the token and the person who made it, and the approval\'s record keeps it', async () => {
    const made = await env.makePiece(token, 'video', '9:16');
    expect((await env.call(token, 'POST', `/api/pieces/${made.pieceId}/agent-runs`, { trigger: 'manual' })).status).toBe(201);
    const v = await env.newVersion(token, made.variantId, file());
    expect(v.status).toBe(201);
    const shown = await env.call(env.users.reviewer, 'GET', `/api/versions/${v.body.id}`);
    expect(shown.body.uploaded_by).toEqual({ kind: 'token', id: token.id, name: 'Agent runner', created_by: { id: env.users.admin.id, name: 'admin' } });

    // The person who made the token is not its author: approving depends only on permissions (the owner's decision).
    const approved = await env.approve(env.users.admin, v.body.id, [ig]);
    expect(approved.status).toBe(201);
    const audit = await env.db.one(`select after from audit_event where action = 'version.approved' and entity_id = $1`, [v.body.id]);
    expect(audit!.after.uploaded_by).toMatchObject({ kind: 'token', name: 'Agent runner', created_by: { id: env.users.admin.id } });

    const byPerson = await approvedPiece();
    expect((await env.call(env.users.reviewer, 'GET', `/api/versions/${byPerson.versionId}`)).body.uploaded_by).toMatchObject({ kind: 'user', id: env.users.producer.id });
  });
});

describe('scheduling while a new version arrives', () => {
  it('waits for a version being closed at the same moment, and then refuses the one it replaced', async () => {
    const { variantId, versionId } = await approvedPiece();
    // Someone is closing a new version of this variant right now: its transaction holds the variant.
    const client = await env.db.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from variant where id = $1 for update', [variantId]);
      let settled = false;
      const pending = schedule(versionId).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // scheduling waits for it
      await client.query(`update version set review_state = 'superseded' where id = $1`, [versionId]);
      await client.query('commit');
      const r = await pending;
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('not_approved');
    } finally {
      client.release();
    }
  });
});

describe('the stored files themselves', () => {
  const replace = async (versionId: string) => {
    const a = (await env.db.one('select storage_key from asset where version_id = $1', [versionId]))!;
    await writeFile((env.ctx.storage as LocalStorage).localPath(a.storage_key), Buffer.from('a different file'));
  };

  it('are checked again on approving, scheduling and publishing: a file replaced in storage stops counting', async () => {
    const { users, makePiece, newVersion, approve } = env;
    const fresh = await makePiece(users.producer, 'video', '9:16');
    const v = await newVersion(users.producer, fresh.variantId, file());
    await replace(v.body.id);
    const refused = await approve(users.approver, v.body.id, [ig]);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('fingerprint_mismatch');

    const ok = await approvedPiece({ account: ig, format: '9:16' });
    const pub = await env.call(users.approver, 'POST', `/api/versions/${ok.versionId}/publications`, { accountId: ig, scheduledAt: at(2 * 60 * MIN).toISOString(), text: 'x' });
    expect(pub.status).toBe(201);
    await replace(ok.versionId);
    const again = await env.call(users.approver, 'POST', `/api/versions/${ok.versionId}/publications`, { accountId: ig, scheduledAt: at(3 * 60 * MIN).toISOString(), text: 'x' });
    expect(again.body.error.code).toBe('fingerprint_mismatch');
    env.clock.set(new Date(pub.body.prepare_at));
    await env.settle();
    expect(await row(pub.body.id)).toMatchObject({ status: 'on_hold', hold_reason: 'The stored files no longer match the approved ones' });
    expect(env.meta.callsTo(/^222\/media$/)).toHaveLength(0);
  });
});
