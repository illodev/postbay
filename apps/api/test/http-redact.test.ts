import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, redact, redactUrl, setTap, type Exchange } from '../src/connectors/http.js';

/** What the --capture transcript and the attempt history keep: secrets go by their shape, not by a list of names. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkaWQ6cGxjOmx1bWVuIn0.c2lnbmF0dXJlLWJ5dGVz';
const REFRESH = 'eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6InJlZnJlc2gifQ.cmVmcmVzaC1zaWc';

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    // What a Bluesky server answers to createSession.
    res.end(JSON.stringify({ accessJwt: JWT, refreshJwt: REFRESH, did: 'did:plc:lumen', handle: 'lumen.bsky.social', didDoc: { id: 'did:plc:lumen' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('removing secrets from what is recorded', () => {
  it('removes a Bluesky session from the transcript, and the app password from the request', async () => {
    const seen: Exchange[] = [];
    setTap((e) => seen.push(e));
    try {
      await call(`${base}/xrpc/com.atproto.server.createSession`, { method: 'POST', json: { identifier: 'lumen.bsky.social', password: 'app-pass-1234' } });
    } finally {
      setTap(null);
    }
    const text = JSON.stringify(seen);
    for (const secret of [JWT, REFRESH, 'app-pass-1234', 'eyJ']) expect(text).not.toContain(secret);
    expect(text).toContain('did:plc:lumen'); // what is not secret stays readable
  });

  it('removes keys that name a credential, and anything shaped like a JWT wherever it is', () => {
    const out = JSON.stringify(redact({
      accessJwt: JWT, refreshJwt: REFRESH, code: 'auth-code', client_secret: 's', sessionUrl: 'https://upload.example/s/1',
      note: `Bearer ${JWT} was refused`, list: [{ deep: JWT }], fields: 'id,name', jobStatus: { state: 'JOB_STATE_FAILED' },
      redirect: 'https://app.example/api/oauth/callback?state=csrf-state&code=c0de',
    }));
    for (const secret of [JWT, REFRESH, 'csrf-state', 'auth-code', 'c0de', '"s"', 'upload.example/s/1']) expect(out).not.toContain(secret);
    expect(out).toContain('id,name');
    expect(out).toContain('JOB_STATE_FAILED'); // a job's state is not a secret
  });

  it('removes every query value of a signed address, and the credentials of any other', () => {
    const s3 = redactUrl('https://bucket.s3.amazonaws.com/brands/a/b.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261002&X-Amz-Date=20261002T000000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123');
    expect(s3).not.toMatch(/AKIA|abc123|20261002T/);
    expect(s3).toContain('X-Amz-Signature=[removed]');
    const local = redactUrl('https://media.example.com/media/brands/a/b.jpg?exp=1790000000&sig=deadbeef');
    expect(local).not.toContain('deadbeef');
    expect(local).not.toContain('1790000000');
    const meta = redactUrl('https://graph.facebook.com/v23.0/me/accounts?fields=id,name&access_token=EAAB123&state=xyz&code=c0de&fb_exchange_token=EAAC');
    expect(meta).toContain('fields=id,name');
    for (const secret of ['EAAB123', 'xyz', 'c0de', 'EAAC']) expect(meta).not.toContain(secret);
    expect(meta).toContain('access_token=[removed]');
    const jwtParam = redactUrl(`https://video.bsky.app/xrpc/x?did=did:plc:a&token=${JWT}`);
    expect(jwtParam).not.toContain(JWT);
    expect(redactUrl(`Refused https://x.example/a?sig=1 and ${JWT}`)).toBe('Refused https://x.example/a?sig=[removed] and [removed]');
  });
});
