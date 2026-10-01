import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyDuePublications, sendPendingEmails } from '../src/background.js';
import { createEnv, inDays, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

async function scheduledPublication() {
  const { users, makePiece, newVersion, approve, call, accounts } = env;
  const { variantId } = await makePiece(users.producer);
  const v = await newVersion(users.producer, variantId);
  await approve(users.approver, v.body.id, [accounts.instagram]);
  const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: accounts.instagram, scheduledAt: inDays(3) });
  return pub.body.id as string;
}

describe('notifications', () => {
  it('tells reviewers and approvers about a new version, but not the person who uploaded it', async () => {
    const { users, db, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    await newVersion(users.producer, variantId);
    const who = await db.query(`select distinct user_id from notification where kind = 'version.uploaded'`);
    const ids = who.map((r) => r.user_id);
    expect(ids).toContain(users.reviewer.id);
    expect(ids).toContain(users.approver.id);
    expect(ids).not.toContain(users.producer.id);
    expect(ids).not.toContain(users.reader.id);
  });

  it('lists a person\'s notifications and marks them read', async () => {
    const { users, call } = env;
    const list = await call(users.reviewer, 'GET', '/api/notifications');
    expect(list.body.unread).toBeGreaterThan(0);
    expect(list.body.items[0].kind).toBe('version.uploaded');
    await call(users.reviewer, 'POST', '/api/notifications/read', {});
    expect((await call(users.reviewer, 'GET', '/api/notifications')).body.unread).toBe(0);
  });

  it('emails what has not been sent yet, once', async () => {
    const { mails } = env;
    const before = mails.length;
    const sent = await sendPendingEmails(env.ctx);
    expect(sent).toBeGreaterThan(0);
    expect(mails.length).toBe(before + sent);
    expect(mails.some((m) => m.subject.includes('A new version is ready for review'))).toBe(true);
    expect(await sendPendingEmails(env.ctx)).toBe(0);
  });
});

describe('assisted publishing reminders', () => {
  it('announces a due publication to the approvers once, and not while the brand is paused', async () => {
    const { db, users, brandId } = env;
    const id = await scheduledPublication();
    expect(await notifyDuePublications(env.ctx)).toBe(0); // not due yet

    await db.query(`update brand set paused = true where id = $1`, [brandId]);
    await db.query(`update publication set scheduled_at = now() - interval '1 minute' where id = $1`, [id]);
    expect(await notifyDuePublications(env.ctx)).toBe(0); // paused

    await db.query(`update brand set paused = false where id = $1`, [brandId]);
    expect(await notifyDuePublications(env.ctx)).toBe(1);
    expect(await notifyDuePublications(env.ctx)).toBe(0); // once
    const who = await db.query(`select user_id from notification where kind = 'publication.due'`);
    expect(who.map((r) => r.user_id).sort()).toEqual([users.admin.id, users.approver.id, users.approver2.id].sort());
  });
});
