import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPendingEmails } from '../src/background.js';
import { KIND_LIST, KINDS, notifyRoles, notifyUsers, type NotifyKind } from '../src/services/notify.js';
import { getPreferences, sendPendingPush, vapidKeys } from '../src/services/push.js';
import { sendPendingSlack, slackMessage } from '../src/services/slack.js';
import { createEnv, type Env } from './helpers.js';
import { FakePushService } from './fakes/push.js';
import { FakeSlack } from './fakes/slack.js';

const slack = new FakeSlack();
const push = new FakePushService();
let env: Env;
let pieceId: string;
let pieceTitle: string;
beforeAll(async () => {
  await slack.start();
  await push.start();
  env = await createEnv({ TOKEN_KEY: Buffer.alloc(32, 5).toString('base64'), SLACK_HOOK_HOST: new URL(slack.url).host });
  const p = await env.makePiece(env.users.producer);
  pieceId = p.pieceId;
  pieceTitle = (await env.db.one<{ title: string }>('select title from piece where id = $1', [pieceId]))!.title;
});
afterAll(async () => { await env.close(); await slack.stop(); await push.stop(); });

const hookUrl = (name = 'T0001/B0001/abcdEFGH') => `${slack.url}/services/${name}`;
const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;
const ids = async (email: string) => (await env.db.one<{ id: string }>('select id from app_user where email = $1', [email]))!.id;

beforeEach(async () => {
  await env.db.query('delete from notification');
  await env.db.query('delete from push_subscription');
  await env.db.query('delete from slack_hook');
  await env.db.query(`update app_user set notify_prefs = '{}'`);
  slack.posts.length = 0;
  slack.gone.clear();
  slack.failures.length = 0;
  push.received.length = 0;
  push.gone.clear();
  push.failures.length = 0;
  push.vapidProblems.length = 0;
  env.mails.length = 0;
});

async function subscribeBrowser(email: 'approver@example.com' | 'admin@example.com' | 'reviewer@example.com', name?: string) {
  const b = push.browser(name);
  const actor = Object.values(env.users).find((u) => u.email === email)!;
  const r = await env.call(actor, 'POST', '/api/push/subscriptions', { ...b.subscription, userAgent: 'test browser' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return b;
}
const event = (kind: NotifyKind = 'version.uploaded', extra: Record<string, unknown> = {}) =>
  notifyRoles(env.db, env.brandId, ['approver', 'admin'], kind, { pieceId, ...extra }, null);

describe('what each person wants', () => {
  it('starts with email for everything and push for what needs them, and says what each kind is called', async () => {
    const r = await env.call(env.users.approver, 'GET', '/api/notifications/preferences');
    expect(r.status).toBe(200);
    expect(r.body.emailKinds).toEqual(KIND_LIST);
    expect(r.body.pushKinds).toEqual(KIND_LIST.filter((k) => KINDS[k].push));
    expect(r.body.pushKinds).toContain('publication.failed');
    expect(r.body.pushKinds).not.toContain('publication.published'); // good news does not buzz a phone
    expect(r.body.pushDevices).toBe(0);
    expect(r.body.kinds.find((k: { kind: string }) => k.kind === 'version.uploaded').label).toBe('A new version is ready for review');
  });

  it('keeps what a person chooses, for themselves only, and refuses a kind that does not exist', async () => {
    const put = await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: ['publication.failed'], pushKinds: ['version.uploaded', 'comment.created'] });
    expect(put.status).toBe(200);
    expect(put.body.emailKinds).toEqual(['publication.failed']);
    expect(put.body.pushKinds).toEqual(['version.uploaded', 'comment.created']);
    expect((await env.call(env.users.approver, 'GET', '/api/notifications/preferences')).body.emailKinds).toEqual(['publication.failed']);
    expect((await env.call(env.users.admin, 'GET', '/api/notifications/preferences')).body.emailKinds).toEqual(KIND_LIST); // somebody else's are untouched
    expect((await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: ['not.a.kind'], pushKinds: [] })).status).toBe(400);
    expect((await env.call(null, 'GET', '/api/notifications/preferences')).status).toBe(401);
  });

  it('can switch every kind off, by email and by push', async () => {
    await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: [], pushKinds: [] });
    const p = await getPreferences(env.ctx, await ids('approver@example.com'));
    expect(p.emailKinds).toEqual([]);
    expect(p.pushKinds).toEqual([]);
  });
});

describe('email follows the choice', () => {
  it('does not email a kind somebody turned off, but still emails the others, and the bell is untouched', async () => {
    await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: ['publication.failed'], pushKinds: [] });
    await event('version.uploaded');
    await event('publication.failed');
    await sendPendingEmails(env.ctx);
    const toApprover = env.mails.filter((m) => m.to === 'approver@example.com');
    expect(toApprover).toHaveLength(1);
    expect(toApprover[0]!.subject).toBe('[Test brand] A post could not be published');
    expect(toApprover[0]!.text).toContain(`Piece: ${pieceTitle}`);
    expect(toApprover[0]!.text).toContain(`/pieces/${pieceId}`);
    expect(env.mails.filter((m) => m.to === 'admin@example.com')).toHaveLength(2); // the admin kept the default
    const bell = await env.db.query(`select 1 from notification where user_id = $1`, [await ids('approver@example.com')]);
    expect(bell).toHaveLength(2);
  });
});

describe('browsers', () => {
  it('makes the deployment\'s signing key once, even when many ask at the same moment, keeps it sealed, and gives only the public half to a signed-in person', async () => {
    await env.db.query(`delete from app_secret where name = 'vapid'`);
    const keys = await Promise.all(Array.from({ length: 12 }, () => vapidKeys(env.ctx)));
    expect(new Set(keys.map((k) => k.publicKey)).size).toBe(1);
    expect(new Set(keys.map((k) => k.privateKey)).size).toBe(1);
    const a = await env.call(env.users.reviewer, 'GET', '/api/push/key');
    expect(a.status).toBe(200);
    expect(Buffer.from(a.body.publicKey, 'base64url')).toHaveLength(65);
    expect(keys[0]!.publicKey).toBe(a.body.publicKey);
    expect((await vapidKeys(env.ctx)).publicKey).toBe(a.body.publicKey); // and it is the same tomorrow
    const sealed = (await env.db.one<{ value_sealed: Buffer }>(`select value_sealed from app_secret where name = 'vapid'`))!.value_sealed;
    expect(sealed.toString('latin1')).not.toContain(keys[0]!.privateKey);
    expect(sealed.toString('hex')).not.toContain(Buffer.from(keys[0]!.privateKey, 'base64url').toString('hex'));
    expect(JSON.stringify(a.body)).not.toContain(keys[0]!.privateKey);
    expect((await env.call(null, 'GET', '/api/push/key')).status).toBe(401);
  });

  it('remembers a browser for the person who subscribed, moves it if someone else subscribes the same one, and forgets it on request', async () => {
    const b = push.browser();
    expect((await env.call(env.users.approver, 'POST', '/api/push/subscriptions', b.subscription)).status).toBe(200);
    expect((await env.call(env.users.approver, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(1);
    expect((await env.call(env.users.admin, 'POST', '/api/push/subscriptions', b.subscription)).status).toBe(200); // a shared computer
    expect((await env.call(env.users.approver, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(0);
    expect((await env.call(env.users.admin, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(1);
    expect((await env.call(env.users.approver, 'POST', '/api/push/unsubscribe', { endpoint: b.endpoint })).status).toBe(200);
    expect((await env.call(env.users.admin, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(1); // not hers to remove
    await env.call(env.users.admin, 'POST', '/api/push/unsubscribe', { endpoint: b.endpoint });
    expect((await env.call(env.users.admin, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(0);
  });

  it('refuses a subscription whose keys are the wrong shape, or whose address the server must not reach', async () => {
    const good = push.browser().subscription;
    const bad = [
      { ...good, keys: { ...good.keys, p256dh: 'AAAA' } },
      { ...good, keys: { ...good.keys, auth: 'AAAA' } },
      { ...good, endpoint: 'http://169.254.169.254/latest/meta-data/' },
      { ...good, endpoint: 'not a url' },
      { endpoint: good.endpoint },
    ];
    for (const b of bad) expect((await env.call(env.users.approver, 'POST', '/api/push/subscriptions', b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    expect((await env.call(null, 'POST', '/api/push/subscriptions', good)).status).toBe(401);
    expect((await env.call(env.users.approver, 'GET', '/api/notifications/preferences')).body.pushDevices).toBe(0);
  });
});

describe('push messages', () => {
  it('reach the browser of each person the event is for, readable only there, and are sent once', async () => {
    const approver = await subscribeBrowser('approver@example.com');
    const admin = await subscribeBrowser('admin@example.com');
    await event('version.uploaded');
    expect(await sendPendingPush(env.ctx)).toBe(2);
    const msg = push.messagesFor(approver);
    expect(msg).toEqual([{ title: '[Test brand] A new version is ready for review', body: `Piece: ${pieceTitle}`, url: `http://app.test/pieces/${pieceId}`, tag: `version.uploaded:${pieceId}` }]);
    expect(push.messagesFor(admin)).toHaveLength(1);
    expect(() => admin.decrypt(push.received.find((r) => r.path === new URL(approver.endpoint).pathname)!.body)).toThrow(); // not readable by the other
    expect(push.vapidProblems).toEqual([]);
    expect(await sendPendingPush(env.ctx)).toBe(0);
    expect(push.received).toHaveLength(2);
    expect((await env.db.query('select 1 from notification where pushed_at is null'))).toHaveLength(0);
  });

  it('go to every browser a person has, and a browser the push service has dropped is forgotten while the others still get it', async () => {
    const phone = await subscribeBrowser('approver@example.com', 'phone');
    const laptop = await subscribeBrowser('approver@example.com', 'laptop');
    push.gone.add('/push/laptop');
    await notifyUsers(env.db, env.brandId, [await ids('approver@example.com')], 'publication.failed', { pieceId }, null);
    expect(await sendPendingPush(env.ctx)).toBe(1);
    expect(push.messagesFor(phone)).toHaveLength(1);
    expect(push.messagesFor(laptop)).toHaveLength(0);
    const left = await env.db.query('select endpoint from push_subscription');
    expect(left.map((r) => r.endpoint)).toEqual([phone.endpoint]);
  });

  it('are not sent to someone with no browser, or for a kind they do not want, and are not looked at again', async () => {
    await subscribeBrowser('admin@example.com');
    await env.call(env.users.admin, 'PUT', '/api/notifications/preferences', { emailKinds: KIND_LIST, pushKinds: ['publication.failed'] });
    await event('version.uploaded'); // admin has a browser but turned this off; the approver has none
    expect(await sendPendingPush(env.ctx)).toBe(0);
    expect(push.received).toHaveLength(0);
    expect(await env.db.query('select 1 from notification where pushed_at is null')).toHaveLength(0);
    await event('publication.failed');
    expect(await sendPendingPush(env.ctx)).toBe(1);
  });

  it('are tried again with growing waits when the push service cannot take them, and given up on after a few tries', async () => {
    const b = await subscribeBrowser('approver@example.com');
    await notifyUsers(env.db, env.brandId, [await ids('approver@example.com')], 'publication.failed', { pieceId }, null);
    push.failures.push({ match: () => true, status: 503, body: 'try later', times: 100 });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await sendPendingPush(env.ctx)).toBe(0);
      const n = (await env.db.one<{ push_tries: number; push_next_at: Date | null; pushed_at: Date | null }>('select push_tries, push_next_at, pushed_at from notification'))!;
      expect(n.push_tries).toBe(i + 1);
      if (i < 4) {
        expect(n.pushed_at).toBeNull();
        waits.push(Math.round((new Date(n.push_next_at!).getTime() - Date.now()) / 1000));
        // Not tried before it is due…
        const calls = push.calls.length;
        await sendPendingPush(env.ctx);
        expect(push.calls.length).toBe(calls);
        // …and tried when it is.
        await env.db.query(`update notification set push_next_at = now() - interval '1 second'`);
      } else {
        expect(n.pushed_at).not.toBeNull(); // given up
      }
    }
    expect(waits[0]).toBeGreaterThan(50);
    expect(waits[0]).toBeLessThanOrEqual(60);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
    expect(push.messagesFor(b)).toHaveLength(0);
    const sub = await env.db.one<{ last_error: string }>('select last_error from push_subscription');
    expect(sub!.last_error).toMatch(/503/);
    // The browser is still there to be sent to next time.
    expect(await env.db.query('select 1 from push_subscription')).toHaveLength(1);
  });

  it('succeed after a failure once the service recovers', async () => {
    const b = await subscribeBrowser('approver@example.com');
    await notifyUsers(env.db, env.brandId, [await ids('approver@example.com')], 'publication.failed', { pieceId }, null);
    push.failures.push({ match: () => true, status: 500, body: 'oops', times: 1 });
    expect(await sendPendingPush(env.ctx)).toBe(0);
    await env.db.query(`update notification set push_next_at = now() - interval '1 second'`);
    expect(await sendPendingPush(env.ctx)).toBe(1);
    expect(push.messagesFor(b)).toHaveLength(1);
  });

  it('are never sent for something a day old', async () => {
    const b = await subscribeBrowser('approver@example.com');
    await notifyUsers(env.db, env.brandId, [await ids('approver@example.com')], 'publication.failed', { pieceId }, null);
    await env.db.query(`update notification set created_at = now() - interval '25 hours'`);
    expect(await sendPendingPush(env.ctx)).toBe(0);
    expect(push.messagesFor(b)).toHaveLength(0);
    expect(await env.db.query('select 1 from notification where pushed_at is null')).toHaveLength(0);
  });

  it('do not go twice when two workers run at once', async () => {
    const b = await subscribeBrowser('approver@example.com');
    await notifyUsers(env.db, env.brandId, [await ids('approver@example.com')], 'publication.failed', { pieceId }, null);
    const sent = await Promise.all([sendPendingPush(env.ctx), sendPendingPush(env.ctx), sendPendingPush(env.ctx)]);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(push.messagesFor(b)).toHaveLength(1);
  });

  it('can be tried from the settings screen: a test message to your own browsers', async () => {
    const b = await subscribeBrowser('approver@example.com');
    const r = await env.call(env.users.approver, 'POST', '/api/push/test');
    expect(r.body).toEqual({ devices: 1, reached: 1 });
    expect(push.messagesFor(b)[0]).toMatchObject({ title: 'Content Studio', tag: 'test' });
    expect((await env.call(env.users.admin, 'POST', '/api/push/test')).body).toEqual({ devices: 0, reached: 0 });
  });
});

describe('Slack', () => {
  const setUp = (kinds: string[] = ['version.uploaded', 'publication.failed'], url = hookUrl()) =>
    env.call(env.users.admin, 'PUT', brandUrl('/slack'), { url, kinds });

  it('takes the address of a Slack webhook, keeps it sealed, and shows only its end', async () => {
    const r = await setUp();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: true, hint: '…EFGH', kinds: ['version.uploaded', 'publication.failed'], disabledReason: null, available: true });
    expect(JSON.stringify(r.body)).not.toContain('abcdEFGH');
    const row = (await env.db.one<{ url_sealed: Buffer }>('select url_sealed from slack_hook'))!;
    expect(row.url_sealed.toString('latin1')).not.toContain('abcdEFGH');
    const got = await env.call(env.users.admin, 'GET', brandUrl('/slack'));
    expect(JSON.stringify(got.body)).not.toContain('abcdEFGH');
    expect(got.body.allKinds.find((k: { kind: string }) => k.kind === 'comment.created')).toMatchObject({ default: false });
    const ev = await env.db.one(`select after from audit_event where action = 'slack.configured' order by id desc limit 1`);
    expect(JSON.stringify(ev!.after)).not.toContain('abcdEFGH');
  });

  it('refuses anything that is not a Slack webhook address, so it cannot be made to post somewhere else', async () => {
    for (const url of ['https://evil.example.com/services/T1/B1/x', `${slack.url}/not-services/T1/B1/x`, `${slack.url}/services/`, 'http://169.254.169.254/services/T/B/x', 'nonsense', `http://user:pw@${new URL(slack.url).host}/services/T/B/x`]) {
      const r = await setUp(['version.uploaded'], url);
      expect(r.status, url).toBe(400);
    }
    expect(await env.db.query('select 1 from slack_hook')).toHaveLength(0);
    expect((await env.call(env.users.admin, 'PUT', brandUrl('/slack'), { url: hookUrl(), kinds: [] })).status).toBe(400);
    expect((await env.call(env.users.admin, 'PUT', brandUrl('/slack'), { kinds: ['version.uploaded'] })).status).toBe(400); // no address yet
  });

  it('is for admins only', async () => {
    for (const who of [env.users.approver, env.users.producer, env.users.reader]) {
      expect((await env.call(who, 'GET', brandUrl('/slack'))).status).toBe(403);
      expect((await env.call(who, 'PUT', brandUrl('/slack'), { url: hookUrl(), kinds: ['version.uploaded'] })).status).toBe(403);
      expect((await env.call(who, 'POST', brandUrl('/slack/test'))).status).toBe(403);
      expect((await env.call(who, 'DELETE', brandUrl('/slack'))).status).toBe(403);
    }
  });

  it('needs the token key that seals the address', async () => {
    const bare = await createEnv({});
    try {
      const r = await bare.call(bare.users.admin, 'PUT', `/api/brands/${bare.brandId}/slack`, { url: 'https://hooks.slack.com/services/T1/B1/abcd', kinds: ['version.uploaded'] });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('no_token_key');
      expect((await bare.call(bare.users.admin, 'GET', `/api/brands/${bare.brandId}/slack`)).body.available).toBe(false);
    } finally { await bare.close(); }
  });

  it('changes what is posted without asking for the address again, and can be removed', async () => {
    await setUp();
    const r = await env.call(env.users.admin, 'PUT', brandUrl('/slack'), { kinds: ['publication.failed', 'account.reconnect'] });
    expect(r.body.kinds).toEqual(['publication.failed', 'account.reconnect']);
    expect(r.body.hint).toBe('…EFGH');
    expect((await env.call(env.users.admin, 'DELETE', brandUrl('/slack'))).status).toBe(200);
    expect((await env.call(env.users.admin, 'GET', brandUrl('/slack'))).body).toMatchObject({ configured: false, hint: null });
  });

  it('sends a test message and says plainly when Slack refuses it', async () => {
    await setUp();
    const ok = await env.call(env.users.admin, 'POST', brandUrl('/slack/test'));
    expect(ok.body).toEqual({ ok: true });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toContain('test message from the content studio');
    expect(slack.posts[0]!.path).toBe('/services/T0001/B0001/abcdEFGH');

    slack.gone.add('/services/T0001/B0001/abcdEFGH');
    const bad = await env.call(env.users.admin, 'POST', brandUrl('/slack/test'));
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.message).toMatch(/404.*no_service/);
    expect((await env.call(env.users.admin, 'GET', brandUrl('/slack'))).body.lastError).toMatch(/no_service/);
    expect((await env.call(env.users.admin, 'POST', brandUrl('/slack/test'))).status).toBe(200);
    await env.call(env.users.admin, 'DELETE', brandUrl('/slack'));
    expect((await env.call(env.users.admin, 'POST', brandUrl('/slack/test'))).status).toBe(400); // nothing to test
  });

  it('posts an event once for the team, not once for each person it was written for', async () => {
    await setUp();
    await event('version.uploaded'); // written for two people (the approver and the admin, and a second approver)
    expect((await env.db.query('select 1 from notification')).length).toBeGreaterThanOrEqual(3);
    expect(await sendPendingSlack(env.ctx)).toBe(1);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toBe(`*Test brand* · A new version is ready for review\n<http://app.test/pieces/${pieceId}|${pieceTitle}>`);
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    expect(slack.posts).toHaveLength(1);
    expect(await env.db.query('select 1 from notification where slack_at is null')).toHaveLength(0);
  });

  it('posts two different events as two messages, and the same event twice (two different versions) as two', async () => {
    await setUp(['version.uploaded', 'publication.failed']);
    await event('version.uploaded', { versionId: 'v1' });
    await event('version.uploaded', { versionId: 'v2' });
    await event('publication.failed');
    expect(await sendPendingSlack(env.ctx)).toBe(3);
    expect(slack.posts).toHaveLength(3);
  });

  it('leaves out the kinds a brand did not choose, and brands with no address, and marks them done', async () => {
    await setUp(['publication.failed']);
    await event('version.uploaded');
    await event('comment.created');
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    expect(slack.posts).toHaveLength(0);
    expect(await env.db.query('select 1 from notification where slack_at is null')).toHaveLength(0);
    await env.call(env.users.admin, 'DELETE', brandUrl('/slack'));
    await event('publication.failed');
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    expect(await env.db.query('select 1 from notification where slack_at is null')).toHaveLength(0);
  });

  it('writes text Slack cannot mistake for its own markup', () => {
    const m = slackMessage('en', 'http://app.test', 'version.uploaded', { pieceId: 'p1' }, 'Tom & Jerry <ltd>', '<!channel> *Spring* & <https://evil.example|click>');
    expect(m.text).not.toMatch(/<!channel>/);
    expect(m.text).toContain('&lt;!channel&gt; *Spring* &amp; &lt;https://evil.example|click&gt;');
    expect(m.text).toContain('*Tom &amp; Jerry &lt;ltd&gt;*');
    expect(m.text).toContain('<http://app.test/pieces/p1|');
  });

  it('tries again with growing waits when Slack cannot take a message, respects what Slack asks, and gives up after a few tries', async () => {
    await setUp(['publication.failed']);
    await event('publication.failed');
    slack.failures.push({ match: () => true, status: 429, body: 'rate_limited', headers: { 'retry-after': '1200' }, times: 1 });
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    let n = (await env.db.one<{ slack_tries: number; slack_next_at: Date }>('select slack_tries, slack_next_at from notification limit 1'))!;
    expect(n.slack_tries).toBe(1);
    expect((new Date(n.slack_next_at).getTime() - Date.now()) / 1000).toBeGreaterThan(1100); // Slack said 20 minutes
    const calls = slack.calls.length;
    await sendPendingSlack(env.ctx);
    expect(slack.calls.length).toBe(calls); // not before it is due

    slack.failures.push({ match: () => true, status: 500, body: 'oops', times: 100 });
    for (let i = 1; i < 6; i++) {
      await env.db.query(`update notification set slack_next_at = now() - interval '1 second'`);
      await sendPendingSlack(env.ctx);
      n = (await env.db.one<{ slack_tries: number; slack_next_at: Date }>('select slack_tries, slack_next_at from notification limit 1'))!;
      expect(n.slack_tries).toBe(i + 1);
    }
    expect(await env.db.query('select 1 from notification where slack_at is null')).toHaveLength(0); // given up
    expect(slack.posts).toHaveLength(0);
    const hook = await env.call(env.users.admin, 'GET', brandUrl('/slack'));
    expect(hook.body.lastError).toMatch(/500/);
    expect(hook.body.disabledReason).toBeNull(); // a bad hour is not the end of the integration
  });

  it('stops for good when Slack says the address no longer exists, tells the admins once, and starts again with a new address', async () => {
    await setUp(['publication.failed']);
    slack.gone.add('/services/T0001/B0001/abcdEFGH');
    await event('publication.failed');
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    const hook = await env.call(env.users.admin, 'GET', brandUrl('/slack'));
    expect(hook.body.disabledReason).toMatch(/404/);
    const told = await env.db.query(`select user_id from notification where kind = 'slack.failing'`);
    expect(told.map((r) => r.user_id)).toEqual([await ids('admin@example.com')]);

    // Nothing more is posted, and a second failure does not tell them again.
    await event('publication.failed');
    await sendPendingSlack(env.ctx);
    expect(slack.posts).toHaveLength(0);
    expect(await env.db.query(`select 1 from notification where kind = 'slack.failing'`)).toHaveLength(1);

    const fresh = await setUp(['publication.failed'], hookUrl('T0001/B0001/newNEW99'));
    expect(fresh.body.disabledReason).toBeNull();
    await event('publication.failed', { again: true });
    expect(await sendPendingSlack(env.ctx)).toBe(1);
    expect(slack.posts[0]!.path).toBe('/services/T0001/B0001/newNEW99');
  });

  it('posts once even when two workers run at the same moment', async () => {
    await setUp(['publication.failed']);
    await event('publication.failed');
    const posted = await Promise.all([sendPendingSlack(env.ctx), sendPendingSlack(env.ctx), sendPendingSlack(env.ctx)]);
    expect(posted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(slack.posts).toHaveLength(1);
  });

  it('does not send what happened before the address was given', async () => {
    await event('publication.failed');
    await sendPendingSlack(env.ctx); // no hook yet: marked done
    await setUp(['publication.failed']);
    expect(await sendPendingSlack(env.ctx)).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });
});
