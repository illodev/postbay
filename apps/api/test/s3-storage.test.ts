import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { S3Storage } from '../src/storage/s3.js';
import { FakeS3 } from './fakes/s3.js';

let s3: FakeS3;
let storage: S3Storage;
let dir: string;
beforeAll(async () => {
  s3 = await new FakeS3().start();
  dir = await mkdtemp(path.join(tmpdir(), 'estudio-s3-'));
  storage = new S3Storage(loadConfig({
    NODE_ENV: 'test', SECRET: 'test-secret-test-secret-test-secret-test-secret', STORAGE_DRIVER: 's3',
    S3_ENDPOINT: s3.url, S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret', S3_FORCE_PATH_STYLE: 'true',
  }));
});
afterAll(async () => { await s3.stop(); await rm(dir, { recursive: true, force: true }); });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('a file put from disk (the end of a resumable upload)', () => {
  it('carries the checksum it was given, so the app can read it back and trust it when the version is closed', async () => {
    const data = randomBytes(5000);
    const file = path.join(dir, 'a.bin');
    await writeFile(file, data);
    await storage.putFile('brands/b/a.mp4', file, 'video/mp4', { sha256: sha(data) });
    expect(s3.objects.get('brands/b/a.mp4')!.body).toEqual(data);
    expect(await storage.stat('brands/b/a.mp4')).toEqual({ bytes: 5000, sha256: sha(data) });
  });

  it('is refused by the bucket when the checksum is not that of the bytes', async () => {
    const file = path.join(dir, 'b.bin');
    await writeFile(file, randomBytes(100));
    await expect(storage.putFile('brands/b/b.mp4', file, 'video/mp4', { sha256: sha(randomBytes(100)) })).rejects.toThrow();
    expect(s3.objects.has('brands/b/b.mp4')).toBe(false);
  });

  it('cannot be vouched for without a checksum: stat answers nothing, so such a file never closes a version', async () => {
    const file = path.join(dir, 'c.bin');
    await writeFile(file, randomBytes(100));
    await storage.putFile('brands/b/c.mp4', file, 'video/mp4');
    expect(s3.objects.has('brands/b/c.mp4')).toBe(true);
    expect(await storage.stat('brands/b/c.mp4')).toBeNull();
  });

  it('says nothing about a file that is not there', async () => {
    expect(await storage.stat('brands/b/none.mp4')).toBeNull();
  });
});
