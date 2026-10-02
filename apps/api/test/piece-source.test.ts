import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, dueDeliveries } from '../src/services/webhooks.js';
import { createEnv, type Actor, type Env } from './helpers.js';
import { Receiver } from './receiver.js';

// A piece's `source`: where the code and material it is made from live, as an opaque reference a runner resolves.
let env: Env;
let token: Actor;
const rx = new Receiver();
const SOURCE = 'videos:2026-09-29-quarterly-taxes/telenovela';

beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  await rx.start();
  const t = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  token = { id: 'tok', email: 'agent', bearer: t.body.token };
});
afterAll(async () => {
  await rx.stop();
  await env.close();
});

const create = (as: Actor, extra: Record<string, unknown> = {}) =>
  env.call(as, 'POST', `/api/brands/${env.brandId}/pieces`, { title: 'Quarterly taxes', kind: 'video', ...extra });
const patch = (as: Actor, pieceId: string, body: Record<string, unknown>) => env.call(as, 'PATCH', `/api/pieces/${pieceId}`, body);
const stored = async (pieceId: string) => (await env.db.one<{ source: string | null }>('select source from piece where id = $1', [pieceId]))!.source;

describe('a piece can say where its project lives', () => {
  it('is set when the piece is created, and comes back wherever the piece does', async () => {
    const r = await create(env.users.producer, { source: `  ${SOURCE}  ` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.source).toBe(SOURCE); // trimmed
    expect((await env.call(env.users.reader, 'GET', `/api/pieces/${r.body.id}`)).body.source).toBe(SOURCE);
    const list = await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/pieces`);
    expect(list.body.find((p: any) => p.id === r.body.id).source).toBe(SOURCE);
    // A piece made without one has none: an agent then works on its files, as before.
    const plain = await create(env.users.producer);
    expect(plain.body.source).toBeNull();
  });

  it('is changed, kept or cleared by an edit, and the change is in the audit log', async () => {
    const { body: piece } = await create(env.users.producer);
    expect((await patch(env.users.producer, piece.id, { source: SOURCE })).body.source).toBe(SOURCE);
    // An edit that does not mention it leaves it alone.
    expect((await patch(env.users.producer, piece.id, { title: 'Quarterly taxes, take two' })).body).toMatchObject({ title: 'Quarterly taxes, take two', source: SOURCE });
    expect((await patch(env.users.approver, piece.id, { source: 'videos:other/folder' })).body.source).toBe('videos:other/folder');
    expect((await patch(env.users.admin, piece.id, { source: null })).body.source).toBeNull();
    await patch(env.users.admin, piece.id, { source: SOURCE });
    expect((await patch(env.users.admin, piece.id, { source: '   ' })).body.source).toBeNull(); // empty clears it
    const log = await env.db.query(`select action, before, after from audit_event where entity = 'piece' and entity_id = $1 order by id`, [piece.id]);
    expect(log.map((e) => [e.action, e.before?.source ?? null, e.after?.source ?? null])).toEqual([
      ['piece.created', null, null],
      ['piece.updated', null, SOURCE],
      ['piece.updated', SOURCE, SOURCE],
      ['piece.updated', SOURCE, 'videos:other/folder'],
      ['piece.updated', 'videos:other/folder', null],
      ['piece.updated', null, SOURCE],
      ['piece.updated', SOURCE, null],
    ]);
  });

  it('may be set by whoever can create pieces, and by nobody else', async () => {
    const { body: piece } = await create(env.users.producer);
    // A producer token creates pieces, so it can say where their project is too.
    const byToken = await create(token, { source: SOURCE });
    expect(byToken.status, JSON.stringify(byToken.body)).toBe(201);
    expect(byToken.body.source).toBe(SOURCE);
    expect((await patch(token, piece.id, { source: 'videos:by-token' })).status).toBe(200);
    for (const who of [env.users.reviewer, env.users.reader]) {
      expect((await patch(who, piece.id, { source: 'videos:somewhere-else' })).status).toBe(403);
      expect((await create(who, { source: SOURCE })).status).toBe(403);
    }
    expect(await stored(piece.id)).toBe('videos:by-token');
  });

  it('is one line of at most 500 characters', async () => {
    const { body: piece } = await create(env.users.producer);
    expect((await patch(env.users.producer, piece.id, { source: `videos:${'a'.repeat(493)}` })).status).toBe(200); // 500 exactly
    for (const bad of [`videos:${'a'.repeat(494)}`, 'videos:a\nb', 'videos:a\tb', 'videos:a\u0000b', 'videos:\u001b[31mred', 'videos:a\u0085b', 42]) {
      const r = await patch(env.users.producer, piece.id, { source: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await create(env.users.producer, { source: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await stored(piece.id)).toBe(`videos:${'a'.repeat(493)}`);
  });

  it('is refused by the database itself when it is not one line of text', async () => {
    const { body: piece } = await create(env.users.producer);
    for (const bad of ['a\nb', 'x'.repeat(501), '', 'a\u007fb']) {
      await expect(env.db.query('update piece set source = $2 where id = $1', [piece.id, bad]), JSON.stringify(bad)).rejects.toThrow(/piece_source_valid/);
    }
    await env.db.query('update piece set source = $2 where id = $1', [piece.id, 'café/año: ñ — fine']);
    expect(await stored(piece.id)).toBe('café/año: ñ — fine');
  });
});

describe('what a runner reads', () => {
  it('goes out with the piece in the events, the request for changes included', async () => {
    await env.db.query('delete from webhook where brand_id = $1', [env.brandId]);
    const w = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/webhooks`, { url: rx.url, events: ['version.changes_requested', 'comment.created'] });
    expect(w.status).toBe(201);
    const { pieceId, variantId } = await env.makePiece(env.users.producer, 'video', '9:16');
    await patch(env.users.producer, pieceId, { source: SOURCE });
    const v = await env.newVersion(env.users.producer, variantId);
    expect(v.status).toBe(201);
    await env.call(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'The logo goes in the corner' });
    await env.call(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/request-changes`, {});
    for (let i = 0; i < 10; i++) {
      const due = await dueDeliveries(env.ctx);
      if (!due.length) break;
      for (const id of due) await deliver(env.ctx, id);
    }
    const sent = rx.requests.map((r) => r.json);
    expect(sent.find((e) => e.type === 'version.changes_requested').data.piece).toMatchObject({ id: pieceId, source: SOURCE });
    expect(sent.find((e) => e.type === 'comment.created').data.piece).toMatchObject({ id: pieceId, source: SOURCE });
    // And the piece itself, which a runner reads when it starts the work, so a change made after the request still counts.
    expect((await env.call(token, 'GET', `/api/pieces/${pieceId}`)).body.source).toBe(SOURCE);
  });
});
