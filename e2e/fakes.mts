// Starts the fake Meta and Google servers the API tests use, plus a "consent screen" that approves every sign-in at once,
// so the end-to-end test can connect accounts through the real UI without reaching any real network.
//
//   npx tsx e2e/fakes.mts          prints the environment variables the API needs, then keeps running
//
// Phase 4 adds stand-ins for Threads, Bluesky, X, LinkedIn, Pinterest and TikTok. Phase 5 adds an OpenID provider, Slack and a push
// service; their settings are only printed when FAKES_ACCESS=1 (e2e/phase5.sh), so the earlier runs see the app as they always did.
//
// A small control surface lets the test look inside and break things on purpose:
//   GET  /__state     what each fake network received (posts, videos, calls)
//   POST /__control   { op: 'reset' | 'meta.fail' | 'meta.reset' | 'meta.scopes' | 'meta.comment' | 'google.audited' | 'tiktok.domain' | 'tiktok.audited'
//                          | 'oidc.claims' | 'slack.gone' | 'push.browser' | 'push.messages' | 'push.gone', ... }
import Fastify from 'fastify';
import { FakeBluesky } from '../apps/api/test/fakes/bluesky.js';
import { FakeGoogle } from '../apps/api/test/fakes/google.js';
import { FakeLinkedIn } from '../apps/api/test/fakes/linkedin.js';
import { FakeMeta } from '../apps/api/test/fakes/meta.js';
import { FakeOidc } from '../apps/api/test/fakes/oidc.js';
import { FakePinterest } from '../apps/api/test/fakes/pinterest.js';
import { FakePushService, type FakeBrowser } from '../apps/api/test/fakes/push.js';
import { FakeSlack } from '../apps/api/test/fakes/slack.js';
import { FakeThreads } from '../apps/api/test/fakes/threads.js';
import { FakeTikTok } from '../apps/api/test/fakes/tiktok.js';
import { FakeX } from '../apps/api/test/fakes/x.js';

const port = Number(process.env.FAKES_PORT ?? 4010);
const meta = await new FakeMeta().start();
const google = await new FakeGoogle().start();
const threads = await new FakeThreads().start();
const bluesky = await new FakeBluesky().start();
const x = await new FakeX().start();
const linkedin = await new FakeLinkedIn().start();
const pinterest = await new FakePinterest().start();
const tiktok = await new FakeTikTok().start();
const oidc = await new FakeOidc().start();
const slack = await new FakeSlack().start();
const pushService = await new FakePushService().start();
/** The browsers the test has "subscribed" through the push service, by name: it holds their keys, so it can read what was sent to them. */
const browsers = new Map<string, FakeBrowser>();

const consent = Fastify({ logger: false });
// The browser lands here from the app, and is sent straight back with a code: the person "agreed".
/** What each sign-in page was asked for, by its path: the test looks at the permissions the app requested. */
const authorizations: Record<string, Record<string, string>> = {};
const approve = async (req: any, reply: any) => {
  authorizations[String(req.url).split('?')[0]] = { ...(req.query as Record<string, string>) };
  const { redirect_uri, state } = req.query as Record<string, string>;
  const back = new URL(redirect_uri);
  back.searchParams.set('code', 'e2e-code');
  back.searchParams.set('state', state);
  return reply.redirect(back.toString());
};
consent.get('/:version/dialog/oauth', approve);
consent.get('/auth', approve);
// Every other network's sign-in page: the same thing, at /approve/<network>.
consent.get('/approve/:network', approve);
consent.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); }
});

consent.get('/__state', async () => ({
  instagram: [...meta.media.entries()].map(([id, m]) => ({ id, ...m })),
  facebook: [...meta.posts.entries()].map(([id, p]) => ({ id, ...p })),
  youtube: [...google.videos.values()].map((v) => ({ id: v.id, snippet: v.snippet, status: v.status, bytes: v.bytes, uploaded: v.uploaded })),
  metaCalls: meta.calls.map((c) => `${c.method} ${c.path}`),
  googleCalls: google.calls.map((c) => `${c.method} ${c.path}`),
  metaMessages: meta.messages,
  threads: [...threads.posts.values()].map((p) => ({ id: p.id, text: p.text, media_type: p.media_type, image_url: p.image_url, video_url: p.video_url })),
  bluesky: [...bluesky.records.values()].map((r) => ({ uri: r.uri, text: r.value.text, embed: r.value.embed ?? null, facets: r.value.facets?.length ?? 0 })),
  x: [...x.posts.values()],
  xAlt: x.altTexts,
  linkedin: [...linkedin.posts.values()].map((p) => ({ id: p.id, commentary: p.commentary, content: p.content })),
  pinterest: [...pinterest.pins.values()],
  tiktok: [...tiktok.posts.values()].map((p) => ({ id: p.id, kind: p.kind, info: p.info, source: p.source })),
  authorizations,
  slack: slack.posts,
  push: { received: pushService.received.length, problems: pushService.vapidProblems },
  oidc: { lastAuthorize: oidc.lastAuthorize },
  youtubeAnalyticsCalls: google.calls.filter((c) => c.path === '/v2/reports').length,
}));

consent.post('/__control', async (req, reply) => {
  const b = req.body as any;
  switch (b.op) {
    case 'meta.fail': {
      // Make the next `times` calls whose path matches `path` fail the way Meta would.
      const re = new RegExp(b.path);
      meta.fail((c) => re.test(c.path), meta.err(b.code ?? 100, b.message ?? 'Invalid parameter'), b.status ?? 400, b.times ?? 1);
      return { ok: true };
    }
    case 'google.audited':
      // Google audits the project: from now on its videos are shown as asked, public included.
      google.audited = !!b.value;
      return { ok: true };
    case 'meta.scopes':
      // What the next Meta sign-in reports as granted (a brand that switched prizes on is asked for the messaging ones too).
      meta.grantedScopes = b.scopes;
      return { ok: true };
    case 'meta.comment': {
      // Someone comments on an Instagram post: it joins the post's feed, which is what a private reply is checked against.
      (meta.commentFeed[b.mediaId] ??= []).push({ id: b.id, text: b.text, at: b.at ?? Date.now(), personId: b.personId, username: b.username });
      return { ok: true };
    }
    case 'tiktok.domain':
      tiktok.verifiedDomain = b.value;
      return { ok: true };
    case 'tiktok.audited':
      tiktok.audited = !!b.value;
      return { ok: true };
    case 'oidc.claims':
      // Who signs in at the identity provider next, and whether it misbehaves (see apps/api/test/fakes/oidc.ts).
      oidc.claims = b.claims ?? {};
      oidc.tamper = b.tamper ?? {};
      return { ok: true };
    case 'slack.gone':
      // Slack stops knowing a webhook address (404 no_service), or knows it again.
      if (b.value === false) slack.gone.delete(b.path); else slack.gone.add(b.path);
      return { ok: true };
    case 'push.browser': {
      // A browser that agreed to push messages: the page is given this subscription in place of one from a real push service.
      const br = pushService.browser(b.name);
      browsers.set(b.name, br);
      return { subscription: br.subscription };
    }
    case 'push.messages': {
      // What that browser would have received, read with its own keys.
      const br = browsers.get(b.name);
      if (!br) return reply.code(404).send({ error: `no browser ${b.name}` });
      return { messages: pushService.messagesFor(br) };
    }
    case 'push.gone': {
      const br = browsers.get(b.name);
      if (!br) return reply.code(404).send({ error: `no browser ${b.name}` });
      const path = new URL(br.endpoint).pathname;
      if (b.value === false) pushService.gone.delete(path); else pushService.gone.add(path);
      return { ok: true };
    }
    case 'reset':
      // Back to a blank slate, so runs do not depend on what an earlier one left behind.
      meta.media.clear(); meta.posts.clear(); meta.containers.clear(); meta.reels.clear();
      meta.calls.length = 0; meta.failures.length = 0;
      google.videos.clear(); google.calls.length = 0; google.audited = false; google.rejection = null;
      meta.messages.length = 0; for (const k of Object.keys(meta.commentFeed)) delete meta.commentFeed[k];
      threads.posts.clear(); threads.containers.clear(); threads.calls.length = 0; threads.failures.length = 0;
      bluesky.records.clear(); bluesky.calls.length = 0; bluesky.failures.length = 0;
      x.posts.clear(); x.calls.length = 0; x.failures.length = 0;
      linkedin.posts.clear(); linkedin.comments.length = 0; linkedin.calls.length = 0; linkedin.failures.length = 0;
      pinterest.pins.clear(); pinterest.calls.length = 0; pinterest.failures.length = 0;
      tiktok.posts.clear(); tiktok.calls.length = 0; tiktok.failures.length = 0;
      oidc.claims = {}; oidc.tamper = {}; oidc.lastAuthorize = {};
      for (const k of Object.keys(authorizations)) delete authorizations[k];
      slack.posts.length = 0; slack.gone.clear();
      pushService.received.length = 0; pushService.gone.clear(); pushService.vapidProblems.length = 0; pushService.rejectVapid = false;
      google.analytics.clear(); google.analyticsAllowed = true;
      return { ok: true };
    case 'meta.reset':
      meta.failures.length = 0;
      return { ok: true };
    default:
      return reply.code(400).send({ error: `unknown op ${b.op}` });
  }
});

await consent.listen({ port, host: '127.0.0.1' });
const origin = `http://127.0.0.1:${port}`;

// What to export before starting the API (see e2e/README.md).
const env = {
  META_APP_ID: 'e2e-app',
  META_APP_SECRET: 'e2e-secret',
  META_GRAPH_URL: meta.url,
  META_OAUTH_URL: origin,
  GOOGLE_CLIENT_ID: 'e2e-client',
  GOOGLE_CLIENT_SECRET: 'e2e-secret',
  GOOGLE_OAUTH_URL: `${origin}/auth`,
  GOOGLE_TOKEN_URL: `${google.url}/token`,
  YOUTUBE_API_URL: google.url,
  YOUTUBE_ANALYTICS_URL: google.url,
  META_WEBHOOK_VERIFY_TOKEN: 'e2e-verify',
  THREADS_APP_ID: 'e2e-threads',
  THREADS_APP_SECRET: 'e2e-secret',
  THREADS_OAUTH_URL: `${origin}/approve/threads`,
  THREADS_GRAPH_URL: threads.url,
  TIKTOK_CLIENT_KEY: tiktok.clientKey,
  TIKTOK_CLIENT_SECRET: tiktok.clientSecret,
  TIKTOK_OAUTH_URL: `${origin}/approve/tiktok`,
  TIKTOK_API_URL: tiktok.url,
  LINKEDIN_CLIENT_ID: 'e2e-linkedin',
  LINKEDIN_CLIENT_SECRET: 'e2e-secret',
  LINKEDIN_OAUTH_URL: `${origin}/approve/linkedin`,
  LINKEDIN_TOKEN_URL: `${linkedin.url}/oauth/token`,
  LINKEDIN_API_URL: linkedin.url,
  X_CLIENT_ID: x.clientId,
  X_CLIENT_SECRET: x.clientSecret,
  X_OAUTH_URL: `${origin}/approve/x`,
  X_API_URL: x.url,
  PINTEREST_APP_ID: pinterest.clientId,
  PINTEREST_APP_SECRET: pinterest.clientSecret,
  PINTEREST_OAUTH_URL: `${origin}/approve/pinterest`,
  PINTEREST_API_URL: pinterest.url,
  BLUESKY_PDS_URL: bluesky.url,
  BLUESKY_VIDEO_URL: `${bluesky.url}/video`,
  // The fakes' own credentials, for the test to type into the Bluesky form.
  E2E_BLUESKY_HANDLE: bluesky.handle_,
  E2E_BLUESKY_PASSWORD: bluesky.password,
};
if (process.env.FAKES_ACCESS === '1') {
  Object.assign(env, {
    OIDC_ISSUER: oidc.url,
    OIDC_CLIENT_ID: oidc.clientId,
    OIDC_CLIENT_SECRET: oidc.clientSecret,
    OIDC_LABEL: 'Test identity provider',
    OIDC_ALLOWED_DOMAINS: 'example.com',
    // Only the stand-in's own host is accepted as Slack, and this is where it is.
    SLACK_HOOK_HOST: new URL(slack.url).host,
    // For the test to type into the Slack settings.
    E2E_SLACK_URL: `${slack.url}/services/T0000/B0000/e2eSecretToken1234`,
  });
}
for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${v}'`);
console.log(`# fakes ready; control surface at ${origin}/__state`);

const stop = async () => {
  await Promise.all([consent.close(), meta.stop(), google.stop(), threads.stop(), bluesky.stop(), x.stop(), linkedin.stop(), pinterest.stop(), tiktok.stop(), oidc.stop(), slack.stop(), pushService.stop()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
