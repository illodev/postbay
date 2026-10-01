import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { Config } from '../config.js';
import type { PresignedPut, Storage, StoredStat } from './index.js';

/**
 * Disk storage for development and tests. It mimics what S3 does with signed URLs:
 * an upload is only accepted with the signature, before the expiry, and is rejected if the size or sha256
 * differ from what was declared.
 */
export class LocalStorage implements Storage {
  private root: string;
  constructor(private config: Pick<Config, 'SECRET' | 'MEDIA_URL' | 'STORAGE_LOCAL_DIR'>) {
    this.root = path.resolve(config.STORAGE_LOCAL_DIR);
  }

  private sign(parts: (string | number)[]): string {
    return createHmac('sha256', this.config.SECRET).update(parts.join('\n')).digest('hex');
  }

  private abs(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  private url(key: string, params: Record<string, string | number>): string {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return `${this.config.MEDIA_URL}/media/${key.split('/').map(encodeURIComponent).join('/')}?${q}`;
  }

  async presignPut(key: string, o: { mime: string; bytes: number; sha256: string; expiresSec: number }): Promise<PresignedPut> {
    const exp = Math.floor(Date.now() / 1000) + o.expiresSec;
    const sig = this.sign(['PUT', key, exp, o.sha256, o.bytes]);
    return { method: 'PUT', url: this.url(key, { exp, sha: o.sha256, bytes: o.bytes, sig }), headers: { 'content-type': o.mime } };
  }

  async presignGet(key: string, o: { expiresSec: number; filename?: string }): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + o.expiresSec;
    const name = o.filename ?? '';
    const sig = this.sign(['GET', key, exp, name]);
    return this.url(key, { exp, sig, ...(name ? { name } : {}) });
  }

  private verify(sig: string, parts: (string | number)[]): boolean {
    const want = Buffer.from(this.sign(parts));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Called by the PUT /media/* route. Returns an HTTP status and a message. */
  async receive(key: string, q: Record<string, string | undefined>, body: Readable): Promise<{ status: number; error?: string }> {
    const { exp, sha, bytes, sig } = q;
    if (!exp || !sha || !bytes || !sig) return { status: 403, error: 'missing signature' };
    if (Number(exp) < Date.now() / 1000) return { status: 403, error: 'URL expired' };
    if (!this.verify(sig, ['PUT', key, exp, sha, bytes])) return { status: 403, error: 'invalid signature' };

    const dest = this.abs(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const limit = Number(bytes);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(new Error('size'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp));
    } catch (err) {
      await rm(tmp, { force: true });
      return (err as Error).message === 'size'
        ? { status: 400, error: 'the file is larger than declared' }
        : { status: 400, error: 'upload interrupted' };
    }
    if (size !== limit) {
      await rm(tmp, { force: true });
      return { status: 400, error: 'the file is smaller than declared' };
    }
    if (hash.digest('hex') !== sha) {
      await rm(tmp, { force: true });
      return { status: 400, error: 'the sha256 does not match the declared one' };
    }
    await rename(tmp, dest);
    return { status: 200 };
  }

  /** Called by the GET /media/* route. */
  async open(key: string, q: Record<string, string | undefined>) {
    const { exp, sig, name = '' } = q;
    if (!exp || !sig) return { status: 403 as const, error: 'missing signature' };
    if (Number(exp) < Date.now() / 1000) return { status: 403 as const, error: 'URL expired' };
    if (!this.verify(sig, ['GET', key, exp, name])) return { status: 403 as const, error: 'invalid signature' };
    const file = this.abs(key);
    const s = await stat(file).catch(() => null);
    if (!s) return { status: 404 as const, error: 'does not exist' };
    return { status: 200 as const, size: s.size, file, filename: name || null, stream: (opts?: { start: number; end: number }) => createReadStream(file, opts) };
  }

  /** Absolute path on disk: ffmpeg reads from here without going through HTTP. Only exists with local storage. */
  localPath(key: string): string {
    return this.abs(key);
  }

  async stat(key: string): Promise<StoredStat | null> {
    const file = this.abs(key);
    const s = await stat(file).catch(() => null);
    if (!s) return null;
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return { bytes: s.size, sha256: hash.digest('hex') };
  }

  async put(key: string, data: Buffer): Promise<void> {
    const dest = this.abs(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }

  async get(key: string): Promise<Buffer | null> {
    return readFile(this.abs(key)).catch(() => null);
  }
}
