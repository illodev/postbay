import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Actor, type Env } from './helpers.js';

/** The styles a variant of a brand can have: a list the admins keep, which people and the agent pick from. */
let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const setStyles = (variant_styles: unknown, as: Actor = env.users.admin) => env.call(as, 'PATCH', `/api/brands/${env.brandId}`, { rules: { variant_styles } });

describe('variant styles', () => {
  it('start empty, and are kept in order, trimmed, by an admin', async () => {
    expect((await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}`)).body.rules.variant_styles).toEqual([]);
    const r = await setStyles(['  Riso ', 'Collage', 'Fotografía de producto']);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rules.variant_styles).toEqual(['Riso', 'Collage', 'Fotografía de producto']);
    // Changing another rule keeps them.
    const other = await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { required_approvals: 1 } });
    expect(other.body.rules.variant_styles).toEqual(['Riso', 'Collage', 'Fotografía de producto']);
    expect((await setStyles(['Riso'], env.users.approver)).status).toBe(403);
  });

  it('refuses one too long, an empty one, more than 30, and the same one twice (whatever its case)', async () => {
    expect((await setStyles(['x'.repeat(41)])).status).toBe(400);
    expect((await setStyles(['Riso', '   '])).status).toBe(400);
    expect((await setStyles(Array.from({ length: 31 }, (_, i) => `Style ${i}`))).status).toBe(400);
    expect((await setStyles(Array.from({ length: 30 }, (_, i) => `Style ${i}`))).status).toBe(200);
    const twice = await setStyles(['Riso', 'Collage', 'riso ']);
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatchObject({ code: 'duplicate_style', message: 'The style "riso" is there twice' });
    expect((await env.callIn('es', env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { variant_styles: ['A', 'a'] } })).body.error.message).toBe('El estilo «a» está repetido');
  });

  it('are what an agent is told a variant can be, and a variant keeps a style outside the list', async () => {
    await setStyles(['Riso', 'Collage']);
    const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Runner' });
    const req = await env.call({ id: 'bot', email: 'bot', bearer: tok.body.token }, 'GET', `/api/brands/${env.brandId}/requirements`);
    expect(req.body.variant_styles).toEqual(['Riso', 'Collage']);
    const { pieceId } = await env.makePiece(env.users.producer);
    const v = await env.call(env.users.producer, 'POST', `/api/pieces/${pieceId}/variants`, { format: '4:5', style: 'Acuarela' });
    expect(v.status).toBe(201);
    expect(v.body.style).toBe('Acuarela');
  });
});
