import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/connectors/profiles.js';
import { allCapabilities, createConnectorSet } from '../src/connectors/registry.js';
import { configFor } from './connector-helpers.js';

const caps = allCapabilities(configFor({}));
const NETWORKS = ['bluesky', 'facebook', 'instagram', 'linkedin', 'pinterest', 'threads', 'tiktok', 'x', 'youtube'];

describe('the connectors a server has', () => {
  it('has only those it has credentials for, and Bluesky as soon as it can seal a password', () => {
    expect(createConnectorSet(configFor({})).networks()).toEqual(['bluesky']);
    const some = createConnectorSet(configFor({ X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b', TIKTOK_CLIENT_KEY: 'c', TIKTOK_CLIENT_SECRET: 'd' }));
    expect(some.networks().sort()).toEqual(['bluesky', 'tiktok', 'x']);
    expect(some.connector('x')!.network).toBe('x');
    expect(some.connector('linkedin')).toBeNull();
    expect(some.providerOf('tiktok')!.id).toBe('tiktok');
  });

  it('refuses credentials without the key that seals them, and half a pair of credentials is not a pair', () => {
    expect(() => configFor({ TOKEN_KEY: '' , X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' })).toThrow(/TOKEN_KEY/);
    expect(createConnectorSet(configFor({ X_CLIENT_ID: 'a' })).networks()).toEqual(['bluesky']);
  });

  it('refuses a LinkedIn version that is not YYYYMM', () => {
    expect(() => configFor({ LINKEDIN_VERSION: '2026-04' })).toThrow(/YYYYMM/);
  });
});

describe('what every network declares', () => {
  it('covers all nine networks', () => {
    expect(Object.keys(caps).sort()).toEqual(NETWORKS);
  });

  it.each(NETWORKS)('%s: every placement names file profiles that exist, for the kinds of file it accepts', (n) => {
    for (const p of caps[n]!.placements) {
      for (const [kind, id] of Object.entries(p.profiles)) {
        expect(PROFILES[id!], `${n}/${p.id} → ${id}`).toBeDefined();
        expect(PROFILES[id!]!.kind).toBe(kind);
      }
      for (const kind of p.accepts) expect(p.profiles[kind], `${n}/${p.id} accepts ${kind} but names no profile for it`).toBeDefined();
      expect(p.items.min).toBeLessThanOrEqual(p.items.max);
    }
  });

  it.each(NETWORKS)('%s: its options are well formed', (n) => {
    const c = caps[n]!;
    const placements = new Set(c.placements.map((p) => p.id));
    const keys = new Set((c.options ?? []).map((o) => o.key));
    expect(keys.size).toBe((c.options ?? []).length); // no key twice
    for (const o of c.options ?? []) {
      if (o.type === 'select') expect(o.choices?.length, `${n}.${o.key}`).toBeGreaterThan(0);
      for (const pl of o.placements ?? []) expect(placements.has(pl), `${n}.${o.key} names placement ${pl}`).toBe(true);
      if (o.showWhen) expect((c.options ?? []).find((x) => x.key === o.showWhen)?.type, `${n}.${o.key} shows when ${o.showWhen}`).toBe('checkbox');
    }
  });

  it('is plain data: it can be sent to the browser as it is', () => {
    expect(JSON.parse(JSON.stringify(caps))).toEqual(caps);
  });
});
