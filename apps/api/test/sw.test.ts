import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// The service worker is a plain script the browser runs; here it runs against a stand-in for what a browser gives it.
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/public/sw.js'), 'utf8');

interface Shown { title: string; options: { body?: string; tag?: string; data: { url: string } } }
function load(windows: { url: string; focused?: string[]; navigated?: string[] }[] = []) {
  const listeners = new Map<string, (e: any) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://studio.example.com' },
    addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
    registration: { showNotification: async (title: string, options: Shown['options']) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows.map((w) => ({
        url: w.url,
        focus: async () => { w.focused = [...(w.focused ?? []), w.url]; return { navigate: async (u: string) => { w.navigated = [...(w.navigated ?? []), u]; } }; },
      })),
      openWindow: async (u: string) => { opened.push(u); },
    },
  };
  vm.runInNewContext(source, { self, URL });
  const waits: Promise<unknown>[] = [];
  const dispatch = (type: string, event: Record<string, unknown>) => {
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    return Promise.all(waits);
  };
  return { shown, opened, windows, dispatch, listeners };
}
const pushOf = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data), text: () => String(data) } });

describe('the service worker', () => {
  it('listens for pushes and clicks, and nothing else (it fetches nothing and caches nothing)', () => {
    const sw = load();
    expect([...sw.listeners.keys()].sort()).toEqual(['notificationclick', 'push']);
  });

  it('shows what the studio sent, with a tag so a second message about the same thing replaces the first', async () => {
    const sw = load();
    await sw.dispatch('push', pushOf({ title: '[Lumen] A post could not be published', body: 'Piece: Spring menu', url: 'https://studio.example.com/pieces/p1', tag: 'publication.failed:p1' }));
    expect(sw.shown).toEqual([{ title: '[Lumen] A post could not be published', options: { body: 'Piece: Spring menu', tag: 'publication.failed:p1', data: { url: '/pieces/p1' } } }]);
  });

  it('shows something sensible for a message with no title, and for one that is not JSON', async () => {
    const sw = load();
    await sw.dispatch('push', pushOf({}));
    await sw.dispatch('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'plain words' } });
    await sw.dispatch('push', {});
    expect(sw.shown.map((s) => s.title)).toEqual(['Content Studio', 'Content Studio', 'Content Studio']);
    expect(sw.shown[1]!.options.body).toBe('plain words');
    expect(sw.shown[0]!.options.tag).toBeUndefined();
  });

  it('only ever opens a page of this site, whatever the message says', async () => {
    const sw = load();
    for (const url of ['https://evil.example.org/phish', '//evil.example.org/x', 'javascript:alert(1)', 42, undefined]) {
      await sw.dispatch('push', pushOf({ title: 't', url }));
    }
    for (const s of sw.shown) expect(s.options.data.url, JSON.stringify(s)).toBe('/');
    await sw.dispatch('push', pushOf({ title: 't', url: '/pieces/p1?x=1#c' }));
    expect(sw.shown.at(-1)!.options.data.url).toBe('/pieces/p1?x=1#c');
  });

  it('brings the studio window forward and goes to the page when a notification is clicked, or opens one if none is open', async () => {
    const win = { url: 'https://studio.example.com/calendar' };
    const other = { url: 'https://elsewhere.example.org/' };
    const sw = load([other, win]);
    let closed = false;
    await sw.dispatch('notificationclick', { notification: { close: () => { closed = true; }, data: { url: '/pieces/p1' } } });
    expect(closed).toBe(true);
    expect(win).toMatchObject({ focused: [win.url], navigated: ['/pieces/p1'] });
    expect(other).not.toHaveProperty('focused');
    expect(sw.opened).toEqual([]);

    const none = load([other]);
    await none.dispatch('notificationclick', { notification: { close: () => {}, data: { url: '/settings?tab=accounts' } } });
    expect(none.opened).toEqual(['/settings?tab=accounts']);
    const noData = load([]);
    await noData.dispatch('notificationclick', { notification: { close: () => {} } });
    expect(noData.opened).toEqual(['/']);
    const hostile = load([]);
    await hostile.dispatch('notificationclick', { notification: { close: () => {}, data: { url: 'https://evil.example.org/' } } });
    expect(hostile.opened).toEqual(['/']);
  });
});
