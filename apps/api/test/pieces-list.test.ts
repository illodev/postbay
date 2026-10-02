import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, inDays, type Actor, type Env } from './helpers.js';

// The pieces list carries what a card shows, so the page needs no request per piece: the latest version of the first variant
// and its main file, who made the latest version anywhere, the campaign, and what is scheduled or out on the networks.
let env: Env;
let agent: Actor;

beforeAll(async () => {
  env = await createEnv();
  const t = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  agent = { id: t.body.id, email: 'agent', bearer: t.body.token };
  // An agent only uploads inside a run, and a run needs a budget.
  await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_cost_per_piece: 5, max_cost_per_month: 500 } });
});
afterAll(async () => {
  await env.close();
});

const list = async (as: Actor = env.users.reader) => {
  const r = await env.call(as, 'GET', `/api/brands/${env.brandId}/pieces`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as any[];
};
const row = async (pieceId: string) => (await list()).find((p) => p.id === pieceId);

describe('the pieces list', () => {
  it('gives a piece with nothing uploaded yet empty extras, with its campaign and project source', async () => {
    const campaign = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/campaigns`, { name: 'Quarterly taxes' });
    const p = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, {
      title: 'Empty piece', kind: 'video', campaignId: campaign.body.id, source: 'videos:2026-09/telenovela',
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(await row(p.body.id)).toMatchObject({
      campaign_id: campaign.body.id,
      campaign_name: 'Quarterly taxes',
      source: 'videos:2026-09/telenovela',
      variant_count: 0,
      open_comments: 0,
      latest_version: null,
      latest_by_agent: false,
      next_publication: null,
      networks: [],
      last_published_at: null,
    });
    // With no version, the last change is the piece's creation.
    expect((await row(p.body.id)).updated_at).toBe(p.body.created_at);
  });

  it('describes the latest version of the first variant, and says whether the latest version anywhere is the agent’s', async () => {
    const { pieceId, variantId } = await env.makePiece(env.users.producer, 'video', '9:16');
    const v1 = await env.newVersion(env.users.producer, variantId);
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    let r = await row(pieceId);
    expect(r.latest_version).toMatchObject({ id: v1.body.id, number: 1, by_agent: false, author: 'producer', format: '9:16', media: 'video', files: 1, duration_ms: 10_000 });
    expect(r.latest_by_agent).toBe(false);

    // The agent uploads the second version: it is the latest, and the agent's.
    expect((await env.call(agent, 'POST', `/api/pieces/${pieceId}/agent-runs`, { trigger: 'manual' })).status).toBe(201);
    const v2 = await env.newVersion(agent, variantId);
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    r = await row(pieceId);
    expect(r.latest_version).toMatchObject({ id: v2.body.id, number: 2, by_agent: true, author: 'Agent runner', review_state: 'in_review' });
    expect(r.latest_by_agent).toBe(true);
    expect(new Date(r.updated_at).getTime()).toBe(new Date(r.latest_version.created_at).getTime());

    // A person uploads to a second variant: the card still shows the first variant (the one the preview is drawn from), but
    // the latest version anywhere is no longer the agent's.
    const second = await env.call(env.users.producer, 'POST', `/api/pieces/${pieceId}/variants`, { format: '16:9' });
    const w1 = await env.newVersion(env.users.producer, second.body.id);
    expect(w1.status, JSON.stringify(w1.body)).toBe(201);
    r = await row(pieceId);
    expect(r.variant_count).toBe(2);
    expect(r.latest_version).toMatchObject({ id: v2.body.id, number: 2, format: '9:16' });
    expect(r.latest_by_agent).toBe(false);
    expect(new Date(r.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(r.latest_version.created_at).getTime());
  });

  it('counts a carousel’s pictures and gives no duration for them', async () => {
    const { pieceId, variantId } = await env.makePiece(env.users.producer, 'carousel', 'carousel');
    const files = [0, 1, 2].map((i) => ({ name: `slide-${i}.png`, mime: 'image/png', kind: 'image', position: i }));
    const v = await env.newVersion(env.users.producer, variantId, files);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await row(pieceId)).latest_version).toMatchObject({ format: 'carousel', media: 'image', files: 3, duration_ms: null });
  });

  it('shows the next publication and every network the piece is scheduled or published on', async () => {
    const { pieceId, variantId } = await env.makePiece(env.users.producer);
    const v = await env.newVersion(env.users.producer, variantId);
    expect((await env.approve(env.users.approver, v.body.id, [env.accounts.instagram, env.accounts.youtube])).body.review_state).toBe('approved');
    const schedule = (accountId: string, days: number) =>
      env.call(env.users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId, scheduledAt: inDays(days), text: 'Hello' });
    const later = await schedule(env.accounts.instagram, 9);
    const sooner = await schedule(env.accounts.youtube, 4);
    expect([later.status, sooner.status]).toEqual([201, 201]);
    let r = await row(pieceId);
    expect(r.next_publication).toMatchObject({ network: 'youtube', status: 'scheduled' });
    expect(new Date(r.next_publication.scheduled_at).toISOString()).toBe(inDays(4));
    expect(r.networks).toEqual(['instagram', 'youtube']);
    expect(r.last_published_at).toBeNull();

    // The YouTube one goes out: it still counts among the networks, and the next one is Instagram's.
    await env.db.query(`update publication set status = 'published', published_at = now() where id = $1`, [sooner.body.id]);
    r = await row(pieceId);
    expect(r.next_publication).toMatchObject({ network: 'instagram' });
    expect(r.networks).toEqual(['instagram', 'youtube']);
    expect(r.last_published_at).not.toBeNull();

    // A cancelled publication is neither next nor on a network.
    await env.db.query(`update publication set status = 'cancelled' where id = $1`, [later.body.id]);
    r = await row(pieceId);
    expect(r.next_publication).toBeNull();
    expect(r.networks).toEqual(['youtube']);
  });

  it('counts open comments only on live versions, and the extras do not change the order or the filters', async () => {
    const { pieceId, variantId } = await env.makePiece(env.users.producer);
    const v = await env.newVersion(env.users.producer, variantId);
    for (const body of ['One', 'Two']) {
      expect((await env.call(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body })).status).toBe(201);
    }
    expect((await row(pieceId)).open_comments).toBe(2);
    const all = await list();
    // Newest first, as before.
    expect(all[0].id).toBe(pieceId);
    const inReview = (await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/pieces?state=in_review`)).body as any[];
    expect(inReview.length).toBeGreaterThan(0);
    expect(inReview.every((p) => p.review_state === 'in_review')).toBe(true);
    expect(inReview.find((p) => p.id === pieceId)).toMatchObject({ latest_version: { id: v.body.id } });
  });

  it('moves a piece to another campaign with an edit, and the list says so', async () => {
    const a = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/campaigns`, { name: 'Autumn' });
    const { pieceId } = await env.makePiece(env.users.producer);
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { campaignId: a.body.id })).status).toBe(200);
    expect(await row(pieceId)).toMatchObject({ campaign_id: a.body.id, campaign_name: 'Autumn' });
    expect((await env.call(env.users.producer, 'PATCH', `/api/pieces/${pieceId}`, { campaignId: null })).status).toBe(200);
    expect(await row(pieceId)).toMatchObject({ campaign_id: null, campaign_name: null });
  });
});
