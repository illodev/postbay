import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
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
  upload: (as: Actor, variantId: string, files: UploadSpec[]) => Promise<string[]>;
  newVersion: (as: Actor, variantId: string, files?: UploadSpec[], extra?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  makePiece: (as: Actor, kind?: string, format?: string) => Promise<{ pieceId: string; variantId: string }>;
  approve: (as: Actor, versionId: string, accountIds?: string[], extra?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
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
  async probe() {
    return { width: 1080, height: 1920, durationMs: 10_000, fps: 30 };
  },
  async frame() {
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function createEnv(overrides: Partial<Record<string, string>> = {}): Promise<Env> {
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
    APP_URL: 'http://app.test',
    MEDIA_URL: 'http://media.test',
    ...overrides,
  });
  const db = createDb(config.DATABASE_URL);
  await migrate(db);
  const mails: Mail[] = [];
  const { app, ctx } = await buildApp({
    config,
    db,
    media: fakeMedia,
    mailer: { async send(to, subject, text) { mails.push({ to, subject, text }); } },
    logger: !!process.env.TEST_LOG,
  });
  await app.ready();

  const workspace = (await db.one('insert into workspace (name) values ($1) returning id', ['Test workspace']))!;
  const brand = (await db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Test brand','Europe/Madrid') returning id`, [workspace.id]))!;

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

  const call: Env['call'] = async (as, method, url, body) => {
    const headers: Record<string, string> = {};
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

  return {
    app, ctx, db, mails, brandId: brand.id, workspaceId: workspace.id, accounts, users, call, upload, newVersion, makePiece, approve,
    async close() {
      await app.close();
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
