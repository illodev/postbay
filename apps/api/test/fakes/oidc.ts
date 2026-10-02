import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, type Call } from './base.js';

/**
 * A stand-in for an OpenID Connect provider (Google Workspace, Microsoft Entra): discovery, signing keys, an authorize page that
 * approves at once, and a token endpoint that checks the code, the secret and PKCE and returns a signed ID token. Written from the
 * specification, not from any one provider, and signed with its own code (not the app's) so the app's checks are tested against
 * something that did not share their mistakes. The `tamper` switches make it misbehave in the ways the app has to refuse.
 */
export class FakeOidc extends FakeServer {
  clientId = 'studio-client';
  clientSecret = 'studio-secret';
  kid = 'key-1';
  /** Claims for the person who signs in next, merged over the defaults. */
  claims: Record<string, unknown> = {};
  tamper: Partial<{
    alg: string; kid: string; noSignature: boolean; wrongKey: boolean; issuer: string; audience: unknown; azp: string; nonce: string;
    expiresInSeconds: number; issuedAtOffsetSeconds: number; discoveryIssuer: string; breakPayload: boolean; withoutSub: boolean;
  }> = {};
  private pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private pending = new Map<string, { challenge: string; redirectUri: string; nonce: string; claims: Record<string, unknown> }>();
  /** The last authorize request, for tests to look at what the app asked for. */
  lastAuthorize: Record<string, string> = {};

  private jwk(key: KeyObject) {
    return { ...(key.export({ format: 'jwk' }) as object), kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  private sign(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc(header)}.${enc(payload)}`;
    if (this.tamper.noSignature) return `${input}.`;
    const sig = createSign('RSA-SHA256').update(input).sign(key).toString('base64url');
    return `${input}.${sig}`;
  }

  handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    if (c.path === '/.well-known/openid-configuration') {
      return reply.send({
        issuer: this.tamper.discoveryIssuer ?? this.url, authorization_endpoint: `${this.url}/authorize`, token_endpoint: `${this.url}/token`, jwks_uri: `${this.url}/jwks`,
      });
    }
    if (c.path === '/jwks') return reply.send({ keys: [this.jwk(this.pair.publicKey)] });

    if (c.path === '/authorize') {
      const q = c.query;
      this.lastAuthorize = q;
      if (q.client_id !== this.clientId) return reply.code(400).send('unknown client');
      if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.nonce || !q.state) return reply.code(400).send('not a code flow with PKCE');
      const code = randomBytes(12).toString('hex');
      this.pending.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri!, nonce: q.nonce, claims: { ...this.claims } });
      const back = new URL(q.redirect_uri!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state);
      return reply.redirect(back.toString());
    }

    if (c.path === '/token' && c.method === 'POST') {
      const b = (c.body ?? {}) as Record<string, string>;
      const bad = (error: string) => reply.code(400).send({ error });
      if (b.client_id !== this.clientId || b.client_secret !== this.clientSecret) return bad('invalid_client');
      const auth = this.pending.get(b.code ?? '');
      this.pending.delete(b.code ?? ''); // a code works once
      if (!auth || b.grant_type !== 'authorization_code' || b.redirect_uri !== auth.redirectUri) return bad('invalid_grant');
      if (createHash('sha256').update(b.code_verifier ?? '').digest('base64url') !== auth.challenge) return bad('invalid_grant');

      const now = Math.floor(Date.now() / 1000);
      const t = this.tamper;
      const payload: Record<string, unknown> = {
        iss: t.issuer ?? this.url, aud: t.audience ?? this.clientId, sub: 'sub-ana', email: 'ana@example.com', email_verified: true, name: 'Ana Admin',
        iat: now + (t.issuedAtOffsetSeconds ?? 0), exp: now + (t.expiresInSeconds ?? 300), nonce: t.nonce ?? auth.nonce, ...auth.claims,
      };
      if (t.azp) payload.azp = t.azp;
      if (t.withoutSub) delete payload.sub;
      const header = { alg: t.alg ?? 'RS256', kid: t.kid ?? this.kid, typ: 'JWT' };
      let idToken = this.sign(header, payload, t.wrongKey ? this.other.privateKey : this.pair.privateKey);
      if (t.breakPayload) {
        // The same signature over a different body: what an attacker editing the token would send.
        const [h, , s] = idToken.split('.');
        idToken = `${h}.${Buffer.from(JSON.stringify({ ...payload, email: 'attacker@example.com' })).toString('base64url')}.${s}`;
      }
      return reply.send({ access_token: 'not-used', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
    }
    return reply.code(404).send({ error: 'not found' });
  }
}
