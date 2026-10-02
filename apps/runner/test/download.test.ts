import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Studio, StudioError } from '../src/api.js';

const dir = mkdtempSync(path.join(tmpdir(), 'runner-download-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MB = 1024 * 1024;
/** An answer whose body arrives a megabyte at a time, and that refuses to be read whole: what a download must not do with a 4 GB file. */
function streamed(total: number, failAfter?: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (failAfter !== undefined && sent >= failAfter) return c.error(new Error('connection reset'));
      if (sent >= total) return c.close();
      sent += MB;
      c.enqueue(new Uint8Array(MB).fill(sent / MB));
    },
  });
  const res = new Response(body, { status: 200 });
  for (const whole of ['arrayBuffer', 'blob', 'text', 'bytes']) {
    Object.defineProperty(res, whole, { value: () => { throw new Error(`the download read the whole file into memory (${whole})`); } });
  }
  return res;
}

describe('downloading the previous version', () => {
  it('writes the file to disk as it arrives, without holding it in memory', async () => {
    const dest = path.join(dir, 'a', '0-video-take1.mp4');
    await new Studio('http://studio.test', 'tok', async () => streamed(48 * MB)).download('http://media.test/x', dest);
    expect(statSync(dest).size).toBe(48 * MB);
    expect(readdirSync(path.dirname(dest))).toEqual(['0-video-take1.mp4']);
  });

  it('leaves nothing behind when the connection breaks halfway, and says it can be tried again', async () => {
    const dest = path.join(dir, 'b', 'big.mp4');
    const err = await new Studio('http://studio.test', 'tok', async () => streamed(64 * MB, 8 * MB)).download('http://media.test/x', dest).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 0, code: 'download_failed' });
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(path.dirname(dest))).toEqual([]);
  });

  it('refuses an answer that is not a success', async () => {
    const err = await new Studio('http://studio.test', 'tok', async () => new Response('gone', { status: 404 })).download('http://media.test/x', path.join(dir, 'c.mp4')).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: 'download_failed' });
  });
});
