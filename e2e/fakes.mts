// Starts the fake Meta and Google servers the API tests use, plus a "consent screen" that approves every sign-in at once,
// so the end-to-end test can connect accounts through the real UI without reaching any real network.
//
//   npx tsx e2e/fakes.mts          prints the environment variables the API needs, then keeps running
//
// A small control surface lets the test look inside and break things on purpose:
//   GET  /__state     what each fake network received (posts, videos, calls)
//   POST /__control   { op: 'reset' | 'meta.fail' | 'meta.reset' | 'google.audited', ... }
import Fastify from 'fastify';
import { FakeGoogle } from '../apps/api/test/fakes/google.js';
import { FakeMeta } from '../apps/api/test/fakes/meta.js';

const port = Number(process.env.FAKES_PORT ?? 4010);
const meta = await new FakeMeta().start();
const google = await new FakeGoogle().start();

const consent = Fastify({ logger: false });
// The browser lands here from the app, and is sent straight back with a code: the person "agreed".
const approve = async (req: any, reply: any) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  const back = new URL(redirect_uri);
  back.searchParams.set('code', 'e2e-code');
  back.searchParams.set('state', state);
  return reply.redirect(back.toString());
};
consent.get('/:version/dialog/oauth', approve);
consent.get('/auth', approve);
consent.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); }
});

consent.get('/__state', async () => ({
  instagram: [...meta.media.entries()].map(([id, m]) => ({ id, ...m })),
  facebook: [...meta.posts.entries()].map(([id, p]) => ({ id, ...p })),
  youtube: [...google.videos.values()].map((v) => ({ id: v.id, snippet: v.snippet, status: v.status, bytes: v.bytes, uploaded: v.uploaded })),
  metaCalls: meta.calls.map((c) => `${c.method} ${c.path}`),
  googleCalls: google.calls.map((c) => `${c.method} ${c.path}`),
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
    case 'reset':
      // Back to a blank slate, so runs do not depend on what an earlier one left behind.
      meta.media.clear(); meta.posts.clear(); meta.containers.clear(); meta.reels.clear();
      meta.calls.length = 0; meta.failures.length = 0;
      google.videos.clear(); google.calls.length = 0; google.audited = false; google.rejection = null;
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
};
for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${v}'`);
console.log(`# fakes ready; control surface at ${origin}/__state`);

const stop = async () => {
  await Promise.all([consent.close(), meta.stop(), google.stop()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
