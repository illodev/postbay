import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConnectorError, type Account, type ConnectorEnv, type Handle, type MediaItem, type PublishInput } from '../src/connectors/types.js';

export const redirect = 'http://app.test/api/oauth/callback';

/** A config pointing the phase 4 networks at the given stand-ins (only those named are switched on). */
export function configFor(extra: Record<string, string>) {
  return loadConfig({ NODE_ENV: 'test', SECRET: 'x'.repeat(40), TOKEN_KEY: randomBytes(32).toString('base64'), ...extra });
}

export function media(over: Partial<MediaItem> = {}): MediaItem {
  return { kind: 'video', position: 0, name: 'reel.mp4', mime: 'video/mp4', bytes: 1000, width: 1080, height: 1920, durationMs: 20_000, key: 'k/reel.mp4', url: 'https://media.test/reel.mp4?sig=1', ...over };
}

export function image(over: Partial<MediaItem> = {}): MediaItem {
  return media({ kind: 'image', name: 'photo.jpg', mime: 'image/jpeg', width: 1080, height: 1350, durationMs: null, key: 'k/photo.jpg', url: 'https://media.test/photo.jpg?sig=1', ...over });
}

export function input(over: Partial<PublishInput> = {}): PublishInput {
  return { publicationId: 'pub-1', placement: 'video', title: 'Spring menu', text: 'Our spring menu is here', firstComment: '', options: {}, scheduledAt: new Date(Date.now() + 3600_000), aiGenerated: false, media: [media()], ...over };
}

export function account(network: Account['network'], over: Partial<Account> = {}): Account {
  return { id: `acc-${network}`, network, externalId: '90001', displayName: 'Lumen', providerData: {}, ...over };
}

export function env(token: string, files: Record<string, Buffer> = {}, now = () => new Date(), extra: Partial<{ expiresAt: string }> = {}): ConnectorEnv & { saved: Handle[] } {
  const saved: Handle[] = [];
  return {
    saved,
    token: async () => ({ accessToken: token, ...extra }),
    now,
    log: { info: () => {}, warn: () => {} },
    open: async (key, start = 0) => {
      const buf = files[key] ?? Buffer.alloc(0);
      return { stream: Readable.from(buf.subarray(start)), size: buf.length };
    },
    persist: async (h) => { saved.push(h); },
  };
}

export async function expectError(p: Promise<unknown>, cls: string): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).errorClass, (err as Error).message).toBe(cls);
    return err as ConnectorError;
  }
  throw new Error(`expected a ${cls} error, but nothing was thrown`);
}

/** Runs prepare until it says done (a network that needs a few looks), keeping the handle the way the engine does. */
export async function prepareUntilDone(c: { prepare: (...a: any[]) => Promise<any> }, inp: PublishInput, acc: Account, e: ConnectorEnv, handle: Handle = {}, max = 10) {
  let h = handle;
  for (let i = 0; i < max; i++) {
    const r = await c.prepare(inp, acc, h, e);
    h = r.handle;
    if (r.done) return { ...r, looks: i + 1 };
  }
  throw new Error('prepare never finished');
}
