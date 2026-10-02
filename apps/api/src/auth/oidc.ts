import { createHash, createHmac, createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import { call } from '../connectors/http.js';

/**
 * OpenID Connect sign-in (authorization code with PKCE), for any provider that publishes a discovery document: Google Workspace
 * (https://accounts.google.com) and Microsoft Entra (https://login.microsoftonline.com/<tenant>/v2.0) among them.
 *
 * The ID token is checked here and not taken on trust: its signature against the provider's published keys (RS256 only: a token
 * that says "none", or an HMAC, is refused), its issuer, audience, expiry and the nonce this sign-in made, and the email's domain.
 * No library: the standard asks for little and an unreviewed dependency is the larger risk.
 */
export class OidcError extends Error {
  constructor(public code: 'provider' | 'token' | 'claims' | 'domain', message: string) {
    super(message);
  }
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  trustEmail: boolean;
  /** Google puts a Workspace's domain in `hd`; a personal account that merely uses an address at the domain has none, and is refused. */
  requireHostedDomain?: boolean;
}

export interface Claims {
  issuer: string;
  subject: string;
  email: string;
  name?: string;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
interface Jwk extends JsonWebKey { kid?: string; use?: string; alg?: string }

const CACHE_MS = 60 * 60_000;
const SKEW_SECONDS = 60;
const b64u = (b: Buffer) => b.toString('base64url');

export class OidcClient {
  private discovered: { at: number; doc: Discovery } | null = null;
  private keys: { at: number; list: Jwk[] } | null = null;

  constructor(private cfg: OidcSettings, private secret: string, private now: () => Date = () => new Date()) {}

  /** What this sign-in remembers about itself without storing it: the nonce and the PKCE verifier are made from its state. */
  private derive(label: string, state: string) {
    return createHmac('sha256', this.secret).update(`oidc:${label}:${state}`).digest('base64url');
  }
  nonceFor(state: string) { return this.derive('nonce', state); }
  verifierFor(state: string) { return this.derive('verifier', state); }

  async discovery(): Promise<Discovery> {
    if (this.discovered && Date.now() - this.discovered.at < CACHE_MS) return this.discovered.doc;
    const r = await call(`${this.cfg.issuer}/.well-known/openid-configuration`, { timeoutMs: 10_000 });
    const doc = r.body as Partial<Discovery> | null;
    if (!r.ok || !doc || typeof doc !== 'object') throw new OidcError('provider', `The identity provider's discovery document could not be read (HTTP ${r.status})`);
    // The issuer it names must be the one configured: a document that names another is not this provider's.
    if (doc.issuer?.replace(/\/$/, '') !== this.cfg.issuer) throw new OidcError('provider', `The provider says it is "${doc.issuer}", not "${this.cfg.issuer}"`);
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new OidcError('provider', 'The discovery document is missing an endpoint');
    this.discovered = { at: Date.now(), doc: doc as Discovery };
    return this.discovered.doc;
  }

  async authorizeUrl(state: string, redirectUri: string): Promise<string> {
    const d = await this.discovery();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', this.nonceFor(state));
    u.searchParams.set('code_challenge', b64u(createHash('sha256').update(this.verifierFor(state)).digest()));
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /** Swaps the code for the person's ID token and checks it. */
  async exchange(code: string, state: string, redirectUri: string): Promise<Claims> {
    const d = await this.discovery();
    const r = await call(d.token_endpoint, {
      method: 'POST', timeoutMs: 15_000,
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code_verifier: this.verifierFor(state) },
    });
    const body = r.body as { id_token?: string; error?: string; error_description?: string } | null;
    if (!r.ok || !body?.id_token) throw new OidcError('token', `The provider did not accept the sign-in${body?.error ? ` (${body.error})` : ''}`);
    return this.verifyIdToken(body.id_token, this.nonceFor(state));
  }

  private async jwks(force = false): Promise<Jwk[]> {
    if (!force && this.keys && Date.now() - this.keys.at < CACHE_MS) return this.keys.list;
    const d = await this.discovery();
    const r = await call(d.jwks_uri, { timeoutMs: 10_000 });
    const list = (r.body as { keys?: Jwk[] } | null)?.keys;
    if (!r.ok || !Array.isArray(list)) throw new OidcError('provider', 'The provider\'s signing keys could not be read');
    this.keys = { at: Date.now(), list };
    return list;
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<Claims> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OidcError('token', 'The ID token is malformed');
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('token', 'The ID token is malformed');
    }
    if (header.alg !== 'RS256') throw new OidcError('token', `The ID token is signed with ${header.alg ?? 'nothing'}, and only RS256 is accepted`);

    // The key it names; keys rotate, so an unknown one is looked for again once before giving up.
    let key = (await this.jwks()).find((k) => k.kid === header.kid && (!k.use || k.use === 'sig'));
    if (!key) key = (await this.jwks(true)).find((k) => k.kid === header.kid && (!k.use || k.use === 'sig'));
    if (!key || key.kty !== 'RSA') throw new OidcError('token', 'The ID token is signed with a key the provider does not publish');
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: key as JsonWebKey, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
    if (!ok) throw new OidcError('token', 'The ID token\'s signature is not valid');

    const d = await this.discovery();
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (claims.iss !== d.issuer) throw new OidcError('claims', 'The ID token comes from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OidcError('claims', 'The ID token is for another application');
    if (aud.length > 1 && claims.azp !== this.cfg.clientId) throw new OidcError('claims', 'The ID token is for another application');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < nowSec) throw new OidcError('claims', 'The ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > nowSec) throw new OidcError('claims', 'The ID token was issued in the future');
    if (claims.nonce !== nonce) throw new OidcError('claims', 'The ID token answers a different sign-in');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('claims', 'The ID token names nobody');

    const email = (typeof claims.email === 'string' && claims.email) || (this.cfg.trustEmail && typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : '');
    if (!email) throw new OidcError('claims', 'The provider did not say what the person\'s email is');
    if (!(claims.email_verified === true || claims.email_verified === 'true') && !this.cfg.trustEmail) throw new OidcError('claims', 'The provider does not say this email is verified');
    const domain = email.toLowerCase().split('@')[1] ?? '';
    if (!this.cfg.allowedDomains.includes(domain)) throw new OidcError('domain', `Accounts at ${domain || 'that domain'} may not sign in this way`);
    if (this.cfg.requireHostedDomain && !this.cfg.allowedDomains.includes(String(claims.hd ?? '').toLowerCase())) {
      throw new OidcError('domain', 'This Google account does not belong to your Workspace');
    }
    return { issuer: d.issuer, subject: claims.sub, email: email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : undefined };
  }
}
