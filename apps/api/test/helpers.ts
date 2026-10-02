import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { dueForAttention, advance } from '../src/services/publisher.js';
import { FakeGoogle } from './fakes/google.js';
import { FakeMeta } from './fakes/meta.js';
import type { Ctx } from '../src/context.js';
import { createDb, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import type { Media } from '../src/media/ffmpeg.js';
import type { Role } from '../src/domain/roles.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres';

export interface Actor {
  id: string;
  email: string;
  cookie?: string;
  bearer?: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Env {
  app: FastifyInstance;
  ctx: Ctx;
  db: Db;
  mails: Mail[];
  brandId: string;
  workspaceId: string;
  accounts: { instagram: string; youtube: string; facebook: string };
  users: Record<'admin' | 'approver' | 'approver2' | 'reviewer' | 'producer' | 'reader', Actor>;
  call: (as: Actor | null, method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** The same, asking for a language (`Accept-Language`), or for none (null), which means Spanish. `call` asks for English. */
  callIn: (locale: string | null, as: Actor | null, method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
  upload: (as: Actor, variantId: string, files: UploadSpec[]) => Promise<string[]>;
  newVersion: (as: Actor, variantId: string, files?: UploadSpec[], extra?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  makePiece: (as: Actor, kind?: string, format?: string) => Promise<{ pieceId: string; variantId: string }>;
  approve: (as: Actor, versionId: string, accountIds?: string[], extra?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
  /** Present when the environment was created with `fakes: true`. */
  meta: FakeMeta;
  google: FakeGoogle;
  /** The clock the app and both fake networks agree on. */
  clock: { now: () => Date; set: (d: Date) => void; advance: (ms: number) => void };
  /** Lets the worker do everything that is due at the current time, until nothing more is. Returns what happened. */
  settle: (rounds?: number) => Promise<string[]>;
  /** Creates an account already connected to a network, with the token sealed as the app would. */
  connect: (network: 'instagram' | 'facebook' | 'youtube', o?: Partial<{ externalId: string; name: string; token: string; refreshToken: string; expiresAt: string; providerData: Record<string, unknown> }>) => Promise<string>;
}

export interface EnvOptions {
  /** Start fake Meta and Google servers and configure the app to use them, with a controllable clock. */
  fakes?: boolean;
  /** Use the real ffprobe/ffmpeg instead of the stub. */
  realMedia?: boolean;
}

export interface UploadSpec {
  name?: string;
  mime?: string;
  data?: Buffer;
  kind?: string;
  position?: number;
}

/** Stub for ffprobe/ffmpeg: tests exercise the rules, not the media tools (the end-to-end run uses the real ones). */
export const fakeMedia: Media = {
  async probe(src) {
    // Images are 4:5 (a feed-shaped photo); everything else is a 9:16 video.
    if (/\.(png|jpe?g)$/i.test(src)) return { width: 1080, height: 1350, durationMs: null, fps: null };
    return { width: 1080, height: 1920, durationMs: 10_000, fps: 30 };
  },
  async frame() {
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  },
  async transcode(src, dest) {
    await copyFile(src, dest);
  },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function createEnv(overrides: Partial<Record<string, string>> = {}, opts: EnvOptions = {}): Promise<Env> {
  const meta = new FakeMeta();
  const google = new FakeGoogle();
  if (opts.fakes) {
    await meta.start();
    await google.start();
  }
  let current = new Date();
  let moved = false;
  const clock = {
    now: () => (moved ? new Date(current) : new Date()),
    set: (d: Date) => { current = new Date(d); moved = true; },
    advance: (ms: number) => { current = new Date((moved ? current : new Date()).getTime() + ms); moved = true; },
  };
  if (opts.fakes) {
    meta.now = () => clock.now().getTime();
    google.now = () => clock.now().getTime();
  }
  const fakeConfig: Record<string, string> = opts.fakes
    ? {
        TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
        META_APP_ID: 'app', META_APP_SECRET: 'secret', META_GRAPH_URL: meta.url, META_OAUTH_URL: meta.url,
        GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_OAUTH_URL: `${google.url}/auth`, GOOGLE_TOKEN_URL: `${google.url}/token`, YOUTUBE_API_URL: google.url, YOUTUBE_ANALYTICS_URL: google.url,
        WORKER_SWEEP_SECONDS: '1',
      }
    : {};
  const dbName = `estudio_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const dir = await mkdtemp(path.join(tmpdir(), 'estudio-media-'));
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    SECRET: 'test-secret-test-secret-test-secret-test-secret',
    DATABASE_URL: ADMIN_URL.replace(/\/postgres$/, `/${dbName}`),
    STORAGE_LOCAL_DIR: dir,
    STAGING_DIR: path.join(dir, '.staging'),
    APP_URL: 'http://app.test',
    MEDIA_URL: 'http://media.test',
    ...fakeConfig,
    ...overrides,
  });
  const db = createDb(config.DATABASE_URL);
  await migrate(db);
  const mails: Mail[] = [];
  const { app, ctx } = await buildApp({
    config,
    db,
    media: opts.realMedia ? undefined : fakeMedia,
    now: opts.fakes ? clock.now : undefined,
    mailer: { async send(to, subject, text) { mails.push({ to, subject, text }); } },
    logger: !!process.env.TEST_LOG,
  });
  await app.ready();

  const workspace = (await db.one('insert into workspace (name) values ($1) returning id', ['Test workspace']))!;
  // The test brand publishes in English and every call asks for English, so the tests read the studio's English texts; the
  // Spanish ones (the default for a brand and for a request that says nothing) are tested on purpose (i18n.test.ts and others).
  const brand = (await db.one(`insert into brand (workspace_id, name, timezone, locale) values ($1,'Test brand','Europe/Madrid','en') returning id`, [workspace.id]))!;

  const makeUser = async (label: string, role: Role): Promise<Actor> => {
    const email = `${label}@example.com`;
    const u = (await db.one('insert into app_user (email, name) values ($1,$2) returning id', [email, label]))!;
    await db.query('insert into member (user_id, brand_id, role) values ($1,$2,$3)', [u.id, brand.id, role]);
    const token = randomBytes(24).toString('base64url');
    await db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'), u.id,
    ]);
    return { id: u.id, email, cookie: `sid=${token}` };
  };
  const users = {
    admin: await makeUser('admin', 'admin'),
    approver: await makeUser('approver', 'approver'),
    approver2: await makeUser('approver2', 'approver'),
    reviewer: await makeUser('reviewer', 'reviewer'),
    producer: await makeUser('producer', 'producer'),
    reader: await makeUser('reader', 'reader'),
  };
  const account = async (network: string, name: string) =>
    ((await db.one(`insert into social_account (brand_id, network, external_id, display_name) values ($1,$2,$3,$4) returning id`, [brand.id, network, name, name]))!).id as string;
  const accounts = { instagram: await account('instagram', 'brand_ig'), youtube: await account('youtube', 'brand_yt'), facebook: await account('facebook', 'brand_fb') };

  const callIn: Env['callIn'] = async (locale, as, method, url, body) => {
    const headers: Record<string, string> = locale ? { 'accept-language': locale } : {};
    if (as?.cookie) {
      headers.cookie = as.cookie;
      headers['x-requested-by'] = 'studio';
    }
    if (as?.bearer) headers.authorization = `Bearer ${as.bearer}`;
    const res = await app.inject({ method: method as 'GET', url, headers, payload: body === undefined ? undefined : (body as object) });
    let parsed: any = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
    return { status: res.statusCode, body: parsed };
  };
  const call: Env['call'] = (as, method, url, body) => callIn('en', as, method, url, body);

  const upload: Env['upload'] = async (as, variantId, files) => {
    const specs = files.map((f, i) => ({
      name: f.name ?? `file-${i}.mp4`,
      mime: f.mime ?? 'video/mp4',
      data: f.data ?? randomBytes(64),
    }));
    const req = await call(as, 'POST', `/api/variants/${variantId}/uploads`, {
      files: specs.map((s) => ({ name: s.name, mime: s.mime, bytes: s.data.length, sha256: sha(s.data) })),
    });
    if (req.status !== 200) throw new Error(`uploads failed: ${JSON.stringify(req.body)}`);
    const ids: string[] = [];
    for (const [i, u] of req.body.uploads.entries()) {
      const url = new URL(u.url);
      const put = await app.inject({ method: 'PUT', url: url.pathname + url.search, headers: u.headers, payload: specs[i]!.data });
      if (put.statusCode !== 200) throw new Error(`PUT failed: ${put.statusCode} ${put.body}`);
      ids.push(u.uploadId);
    }
    return ids;
  };

  const newVersion: Env['newVersion'] = async (as, variantId, files = [{}], extra = {}) => {
    const ids = await upload(as, variantId, files);
    return call(as, 'POST', `/api/variants/${variantId}/versions`, {
      files: ids.map((uploadId, i) => ({ uploadId, kind: files[i]?.kind ?? 'video', position: files[i]?.position ?? i })),
      ...extra,
    });
  };

  const makePiece: Env['makePiece'] = async (as, kind = 'video', format = '9:16') => {
    const p = await call(as, 'POST', `/api/brands/${brand.id}/pieces`, { title: `Piece ${randomUUID().slice(0, 4)}`, kind });
    if (p.status !== 201) throw new Error(`piece failed: ${JSON.stringify(p.body)}`);
    const v = await call(as, 'POST', `/api/pieces/${p.body.id}/variants`, { format });
    if (v.status !== 201) throw new Error(`variant failed: ${JSON.stringify(v.body)}`);
    return { pieceId: p.body.id, variantId: v.body.id };
  };

  const approve: Env['approve'] = (as, versionId, accountIds = [accounts.instagram], extra = {}) =>
    call(as, 'POST', `/api/versions/${versionId}/approvals`, { decision: 'approve', accountIds, ...extra });

  const connect: Env['connect'] = async (network, o = {}) => {
    const defaults = {
      instagram: { externalId: '222', name: '@lumen.coffee', token: 'page-token-111', providerData: { igUserId: '222', pageId: '111' } },
      facebook: { externalId: '111', name: 'Lumen Coffee', token: 'page-token-111', providerData: { pageId: '111' } },
      youtube: { externalId: 'UC-lumen', name: 'Lumen Coffee TV', token: '', providerData: { channelId: 'UC-lumen', audited: false } },
    }[network];
    const id = randomUUID();
    let token = o.token ?? defaults.token;
    let refresh = o.refreshToken;
    let expiresAt = o.expiresAt;
    if (network === 'youtube' && !token) {
      // A real access token from the fake, so the fake accepts it.
      token = `access-${++google.tokenSeq}`;
      google.accessTokens.add(token);
      refresh ??= 'refresh-1';
      expiresAt ??= new Date(clock.now().getTime() + 3600_000).toISOString();
    }
    await db.query(
      `insert into social_account (id, brand_id, network, external_id, display_name, token_encrypted, token_expires_at, provider_data, status, connected_by, connected_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9, now())`,
      [id, brand.id, network, o.externalId ?? defaults.externalId, o.name ?? defaults.name,
        ctx.vault!.seal({ accessToken: token, refreshToken: refresh, expiresAt }, `account:${id}`), expiresAt ?? null,
        JSON.stringify({ ...defaults.providerData, ...(o.providerData ?? {}) }), users.admin.id],
    );
    return id;
  };

  const settle: Env['settle'] = async (rounds = 60) => {
    const log: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const due = await dueForAttention(ctx);
      if (due.length === 0) break;
      for (const d of due) log.push(`${d.id.slice(0, 4)}:${await advance(ctx, d.id)}`);
    }
    return log;
  };

  return {
    app, ctx, db, mails, brandId: brand.id, workspaceId: workspace.id, accounts, users, call, callIn, upload, newVersion, makePiece, approve,
    meta, google, clock, settle, connect,
    async close() {
      await app.close();
      if (opts.fakes) {
        await meta.stop();
        await google.stop();
      }
      await db.close();
      await rm(dir, { recursive: true, force: true });
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database ${dbName} with (force)`);
      await a.end();
    },
  };
}

/** A future instant, as the ISO string the API expects. */
export function inDays(days: number, hour = 17): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
