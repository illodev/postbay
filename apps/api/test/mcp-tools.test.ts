import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Actor, type Env } from './helpers.js';
import { connect, rpc, tool, type Connection } from './mcp-helpers.js';

let env: Env;
const as: Record<'admin' | 'approver' | 'reviewer' | 'producer' | 'reader', Connection> = {} as never;

beforeAll(async () => {
  env = await createEnv();
  for (const who of ['admin', 'approver', 'reviewer', 'producer', 'reader'] as const) as[who] = await connect(env, env.users[who]);
});
afterAll(async () => { await env.close(); });

const brandUrl = () => `/api/brands/${env.brandId}`;
const setApproval = (on: boolean) => env.call(env.users.admin, 'PATCH', brandUrl(), { mcp: { allow_approval: on } });
/** A brand-local time a few days ahead, as a person would say it. */
const localIn = (days: number, hm = '19:00') => `${DateTime.now().setZone('Europe/Madrid').plus({ days }).toISODate()}T${hm}`;

/** A version in review, uploaded by the producer in the web. */
async function inReview(): Promise<{ pieceId: string; variantId: string; versionId: string; fingerprint: string; number: number; title: string }> {
  const { pieceId, variantId } = await env.makePiece(env.users.producer);
  const v = await env.newVersion(env.users.producer, variantId);
  const piece = await env.call(env.users.admin, 'GET', `/api/pieces/${pieceId}`);
  return { pieceId, variantId, versionId: v.body.id, fingerprint: v.body.fingerprint, number: v.body.number, title: piece.body.title };
}

const viaOf = (action: string, entityId: string) =>
  env.db.one<{ via: any; actor_user_id: string; actor_token_id: string | null }>(`select via, actor_user_id, actor_token_id from audit_event where action = $1 and entity_id = $2 order by id desc limit 1`, [action, entityId]);

describe('the tools', () => {
  it('are all offered, with read-only ones marked', async () => {
    const r = await rpc(env, as.reader.access, 'tools/list');
    const names = r.body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'add_comment', 'add_variant', 'add_variant_style', 'approve_version', 'calendar', 'cancel_publication', 'create_campaign', 'create_piece',
      'finish_upload', 'finish_uploads', 'get_piece', 'get_version', 'list_accounts', 'list_brands', 'list_campaigns', 'list_comments',
      'list_notifications', 'list_pieces', 'move_publication', 'pending_for_me', 'remove_variant_style', 'reply_to_comment', 'request_changes',
      'resolve_comment', 'schedule_publication', 'start_upload', 'start_uploads', 'update_piece',
    ]);
    const byName = Object.fromEntries(r.body.result.tools.map((t: any) => [t.name, t]));
    expect(byName.list_pieces.annotations.readOnlyHint).toBe(true);
    expect(byName.cancel_publication.annotations.destructiveHint).toBe(true);
    expect(byName.remove_variant_style.annotations.destructiveHint).toBe(true);
    expect(byName.approve_version.inputSchema.required).toEqual(expect.arrayContaining(['version_id', 'account_ids', 'confirm']));
  });

  it('read what the person can see, with links to the web', async () => {
    const v = await inReview();
    const brands = await tool(env, as.reader.access, 'list_brands');
    expect(brands.data.brands).toEqual([expect.objectContaining({ id: env.brandId, name: 'Test brand', role: 'reader', timezone: 'Europe/Madrid', approval: expect.objectContaining({ assistant_can_approve: false }) })]);
    const list = await tool(env, as.reader.access, 'list_pieces', { state: 'in_review' });
    expect(list.data.pieces.find((x: any) => x.id === v.pieceId)).toMatchObject({ state: 'in_review', latest_version: { id: v.versionId, number: 1, state: 'in_review' }, url: `http://app.test/pieces/${v.pieceId}` });
    expect((await tool(env, as.reader.access, 'list_pieces', { by_agent: true })).data.pieces.some((x: any) => x.id === v.pieceId)).toBe(false);
    const piece = await tool(env, as.reader.access, 'get_piece', { piece_id: v.pieceId });
    expect(piece.data.variants[0].versions[0]).toMatchObject({ id: v.versionId, number: 1, fingerprint: v.fingerprint.slice(0, 12), url: `http://app.test/review/${v.versionId}` });
    const version = await tool(env, as.reader.access, 'get_version', { version_id: v.versionId });
    expect(version.data).toMatchObject({ number: 1, fingerprint: v.fingerprint.slice(0, 12), fingerprint_full: v.fingerprint, state: 'in_review', files: [expect.objectContaining({ kind: 'video', duration_seconds: 10 })] });
    expect(version.data.accounts.map((a: any) => a.network).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    expect((await tool(env, as.reader.access, 'list_accounts')).data.accounts).toHaveLength(3);
    const cal = await tool(env, as.reader.access, 'calendar');
    expect(cal.data).toMatchObject({ timezone: 'Europe/Madrid', paused: false });
    // The brand by name works as well as by id; another name says which ones there are.
    expect((await tool(env, as.reader.access, 'list_accounts', { brand: 'test brand' })).ok).toBe(true);
    const nope = await tool(env, as.reader.access, 'list_accounts', { brand: 'Acme' });
    expect(nope.error).toMatchObject({ code: 'unknown_brand' });
    expect(nope.error.message).toContain('Test brand');
  });

  it('refuse to a reader whatever writes, through the same checks as the web', async () => {
    const v = await inReview();
    const tries: [string, Record<string, unknown>][] = [
      ['add_comment', { version_id: v.versionId, text: 'hola' }],
      ['create_piece', { title: 'Nope', kind: 'video' }],
      ['add_variant', { piece_id: v.pieceId, format: '1:1' }],
      ['start_upload', { variant_id: v.variantId, files: [{ name: 'a.mp4', mime: 'video/mp4', bytes: 10, sha256: 'a'.repeat(64) }] }],
      ['schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at: localIn(3) }],
    ];
    for (const [name, args] of tries) {
      const r = await tool(env, as.reader.access, name, args);
      expect(r.ok, name).toBe(false);
      expect(r.error.code, name).toBe('forbidden');
    }
    expect(await env.db.one(`select 1 from comment where version_id = $1`, [v.versionId])).toBeNull();
  });
});

describe('comments', () => {
  it('are written at a moment, on a page or in general, replied to and resolved, each audited as the person via the assistant', async () => {
    const v = await inReview();
    const at = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.versionId, text: 'The logo is late', at_seconds: 3.5, until_seconds: 5 });
    expect(at.ok, JSON.stringify(at.error)).toBe(true);
    expect(at.data.where).toBe('from 0:03.5 to 0:05');
    const general = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.versionId, text: 'Music too loud overall' });
    expect(general.data.where).toBe('general comment on the whole version');
    // A page anchor on a video version is refused by the same check as the web.
    const page = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.versionId, text: 'x', page: 3 });
    expect(page.error.code).toBe('invalid_anchor');

    const trail = await viaOf('comment.created', at.data.id);
    expect(trail).toMatchObject({ actor_user_id: env.users.reviewer.id, actor_token_id: null, via: { channel: 'mcp', client_name: 'Claude', client_id: as.reviewer.clientId } });

    const threads = await tool(env, as.producer.access, 'list_comments', { version_id: v.versionId, status: 'open' });
    expect(threads.data.threads.map((t: any) => t.where)).toEqual(['from 0:03.5 to 0:05', 'general comment on the whole version']);

    const reply = await tool(env, as.producer.access, 'reply_to_comment', { comment_id: at.data.id, text: 'Moved it to 0:02' });
    expect(reply.ok).toBe(true);
    expect((await viaOf('comment.replied', reply.data.id))!.via).toMatchObject({ client_name: 'Claude' });
    const done = await tool(env, as.producer.access, 'resolve_comment', { comment_id: at.data.id });
    expect(done.data.status).toBe('resolved');
    expect((await viaOf('comment.resolved', at.data.id))!.via).toMatchObject({ channel: 'mcp' });
    expect((await tool(env, as.reader.access, 'resolve_comment', { comment_id: general.data.id })).error.code).toBe('forbidden');

    // The person's activity says it came through the assistant; a comment made in the web does not.
    await env.call(env.users.reviewer, 'POST', `/api/versions/${v.versionId}/comments`, { body: 'From the browser' });
    const feed = (await env.call(env.users.admin, 'GET', `${brandUrl()}/overview`)).body.activity as any[];
    expect(feed.find((e) => e.kind === 'comment' && e.text === 'The logo is late')).toMatchObject({ via: 'Claude', actor: 'reviewer' });
    expect(feed.find((e) => e.kind === 'comment' && e.text === 'From the browser')).toMatchObject({ via: null });
    // And the audit log the web reads carries it.
    const audit = (await env.call(env.users.admin, 'GET', `${brandUrl()}/audit?entity=comment&entityId=${at.data.id}`)).body as any[];
    expect(audit[0].via).toMatchObject({ client_name: 'Claude' });
  });

  it('describe pages and areas in words', async () => {
    const { variantId } = await env.makePiece(env.users.producer, 'carousel', 'carousel');
    const v = await env.newVersion(env.users.producer, variantId, [{ name: 'a.png', mime: 'image/png', kind: 'image' }, { name: 'b.png', mime: 'image/png', kind: 'image' }]);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const whole = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.body.id, text: 'Typo', page: 2 });
    expect(whole.data.where).toBe('page 2 (the whole page)');
    const area = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.body.id, text: 'Crop', page: 1, x: 0.7, y: 0.05, width: 0.2, height: 0.1 });
    expect(area.data.where).toBe('page 1, an area in the top-right (from 70% to 90% across, 5% to 15% down)');
    const point = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.body.id, text: 'Here', page: 1, x: 0.5, y: 0.5 });
    expect(point.data.where).toBe('page 1, a point in the middle-center (50% from the left, 50% from the top)');
  });
});

describe('pieces and uploads', () => {
  it('create a piece with its variants and upload a version through a signed URL, refusing a file that is not what was declared', async () => {
    const created = await tool(env, as.producer.access, 'create_piece', { title: 'Reel de otoño', kind: 'video', formats: ['9:16', '1:1'], brief: 'Hojas' });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.data.variants.map((x: any) => x.format)).toEqual(['9:16', '1:1']);
    expect((await viaOf('piece.created', created.data.id))!.via).toMatchObject({ client_name: 'Claude' });
    const variantId = created.data.variants[0].id;

    const data = randomBytes(256);
    const sha = createHash('sha256').update(data).digest('hex');
    const start = await tool(env, as.producer.access, 'start_upload', { variant_id: variantId, files: [{ name: 'reel.mp4', mime: 'video/mp4', bytes: data.length, sha256: sha }] });
    expect(start.ok, JSON.stringify(start.error)).toBe(true);
    const up = start.data.uploads[0];
    expect(up).toMatchObject({ method: 'PUT', headers: { 'content-type': 'video/mp4' }, expires_in_seconds: 3600 });
    const url = new URL(up.url);
    // Bytes that are not the declared ones are refused by storage itself.
    const wrong = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: up.headers, payload: randomBytes(256) });
    expect(wrong.statusCode).toBe(400);
    // Closing before the file is there is refused.
    expect((await tool(env, as.producer.access, 'finish_upload', { variant_id: variantId, files: [{ upload_id: up.upload_id, kind: 'video' }] })).error.code).toBe('upload_missing');
    const put = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: up.headers, payload: data });
    expect(put.statusCode).toBe(200);
    const done = await tool(env, as.producer.access, 'finish_upload', { variant_id: variantId, files: [{ upload_id: up.upload_id, kind: 'video' }], notes: 'Primera' });
    expect(done.ok, JSON.stringify(done.error)).toBe(true);
    expect(done.data).toMatchObject({ number: 1, state: 'in_review', url: `http://app.test/review/${done.data.id}` });
    expect((await viaOf('version.created', done.data.id))!.via).toMatchObject({ client_name: 'Claude' });
    const feed = (await env.call(env.users.admin, 'GET', `${brandUrl()}/overview`)).body.activity as any[];
    expect(feed.find((e) => e.kind === 'version' && e.version_id === done.data.id)).toMatchObject({ via: 'Claude' });

    // The type and size limits are the web's.
    const pdf = await tool(env, as.producer.access, 'start_upload', { variant_id: variantId, files: [{ name: 'x.mp4', mime: 'video/mp4', bytes: 5 * 1024 ** 3, sha256: sha }] });
    expect(pdf.ok).toBe(false);
  });
});

describe('campaigns and many uploads at once', () => {
  it('creates a campaign once, files a piece in it or out of it, and refuses a campaign that is not there', async () => {
    const made = await tool(env, as.producer.access, 'create_campaign', { name: 'Otoño', objective: 'Lanzamiento' });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    expect((await tool(env, as.producer.access, 'create_campaign', { name: 'otoño' })).error.code).toBe('campaign_exists');
    expect((await tool(env, as.reader.access, 'create_campaign', { name: 'Invierno' })).error.code).toBe('forbidden');
    const { pieceId } = await env.makePiece(env.users.producer);
    const moved = await tool(env, as.producer.access, 'update_piece', { piece_id: pieceId, campaign: 'OTOÑO', title: 'Reel de otoño' });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(moved.data).toMatchObject({ campaign_id: made.data.id, title: 'Reel de otoño' });
    const listed = await tool(env, as.reader.access, 'list_campaigns', {});
    expect(listed.data.campaigns.find((c: any) => c.id === made.data.id)).toMatchObject({ name: 'Otoño', objective: 'Lanzamiento', pieces: 1 });
    const missing = await tool(env, as.producer.access, 'update_piece', { piece_id: pieceId, campaign: 'Primavera' });
    expect(missing.error.code).toBe('unknown_campaign');
    expect(missing.error.details.campaigns).toContain('Otoño');
    expect((await tool(env, as.producer.access, 'update_piece', { piece_id: pieceId, campaign: 'none' })).data.campaign_id).toBeNull();
  });

  it('uploads several versions in two calls, each item answering on its own', async () => {
    const a1 = await env.makePiece(env.users.producer);
    const a2 = await env.makePiece(env.users.producer);
    const files = [randomBytes(128), randomBytes(160)];
    const fact = (b: Buffer, i: number) => ({ name: `v${i}.mp4`, mime: 'video/mp4', bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });
    const started = await tool(env, as.producer.access, 'start_uploads', { items: [
      { variant_id: a1.variantId, files: [fact(files[0]!, 0)] },
      { variant_id: a2.variantId, files: [fact(files[1]!, 1)] },
      { variant_id: '00000000-0000-4000-8000-000000000000', files: [fact(files[1]!, 2)] },
    ] });
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    expect(started.data.items.map((i: any) => i.ok)).toEqual([true, true, false]);
    for (const [i, item] of started.data.items.slice(0, 2).entries()) {
      const up = item.uploads[0]; const url = new URL(up.url);
      expect((await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: up.headers, payload: files[i] })).statusCode).toBe(200);
    }
    const done = await tool(env, as.producer.access, 'finish_uploads', { items: started.data.items.slice(0, 2).map((it: any) => ({
      variant_id: it.variant_id, files: [{ upload_id: it.uploads[0].upload_id, kind: 'video' }], notes: 'Lote',
    })) });
    expect(done.ok, JSON.stringify(done.error)).toBe(true);
    expect(done.data.items.map((i: any) => [i.ok, i.number, i.state])).toEqual([[true, 1, 'in_review'], [true, 1, 'in_review']]);
  });
});

describe('working on a review', () => {
  it("gives the files to download, each comment's exact anchor and frame, and replies that say what became of a comment", async () => {
    const v = await inReview();
    await env.call(env.users.admin, 'PATCH', `/api/pieces/${v.pieceId}`, { source: 'git@example.com:studio/reel.git' });
    expect((await tool(env, as.producer.access, 'get_piece', { piece_id: v.pieceId })).data.source).toBe('git@example.com:studio/reel.git');
    const ver = await tool(env, as.producer.access, 'get_version', { version_id: v.versionId });
    expect(ver.ok, JSON.stringify(ver.error)).toBe(true);
    const file = ver.data.files[0];
    expect(file).toMatchObject({ download_expires_in_seconds: 3600 });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The link gives the very bytes of the version.
    const url = new URL(file.download_url);
    const got = await env.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(got.statusCode).toBe(200);
    expect(createHash('sha256').update(got.rawPayload).digest('hex')).toBe(file.sha256);

    const anchor = { type: 'region', page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.25 };
    const made = await tool(env, as.reviewer.access, 'add_comment', { version_id: v.versionId, text: 'Más contraste aquí', page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.25 });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const listed = await tool(env, as.producer.access, 'list_comments', { version_id: v.versionId, status: 'open' });
    const thread = listed.data.threads.find((t: any) => t.id === made.data.id);
    expect(thread.anchor).toMatchObject(anchor);
    expect(thread).toHaveProperty('frame_url');

    const replied = await tool(env, as.producer.access, 'reply_to_comment', { comment_id: made.data.id, text: 'Hecho en la siguiente versión', kind: 'fixed' });
    expect(replied.ok, JSON.stringify(replied.error)).toBe(true);
    const again = await tool(env, as.producer.access, 'list_comments', { version_id: v.versionId, status: 'open' });
    expect(again.data.threads.find((t: any) => t.id === made.data.id).replies[0]).toMatchObject({ text: 'Hecho en la siguiente versión', kind: 'fixed' });
  });
});

describe('variant styles', () => {
  it("lists the brand's styles, lets an admin add and remove them, and a variant takes only one of them", async () => {
    const styles = async () => (await tool(env, as.admin.access, 'list_brands', {})).data.brands[0].variant_styles;
    expect(await styles()).toEqual([]);

    // Only an admin changes the list, as in Settings → General; it is audited as done through the assistant.
    expect((await tool(env, as.approver.access, 'add_variant_style', { style: 'Riso' })).error.code).toBe('forbidden');
    const added = await tool(env, as.admin.access, 'add_variant_style', { style: 'Riso' });
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(added.data.variant_styles).toEqual(['Riso']);
    expect((await tool(env, as.admin.access, 'add_variant_style', { style: 'Collage', position: 1 })).data.variant_styles).toEqual(['Collage', 'Riso']);
    expect((await tool(env, as.admin.access, 'add_variant_style', { style: 'riso' })).error.code).toBe('duplicate_style');
    expect(await styles()).toEqual(['Collage', 'Riso']);
    expect((await viaOf('brand.updated', env.brandId))!.via).toMatchObject({ client_name: 'Claude' });

    // A variant's style is one of the list, written as the brand writes it; anything else is refused and the list is said.
    const { pieceId } = await env.makePiece(env.users.producer);
    const odd = await tool(env, as.producer.access, 'add_variant', { piece_id: pieceId, format: '1:1', style: 'Acuarela' });
    expect(odd.error).toMatchObject({ code: 'unknown_style', details: { styles: ['Collage', 'Riso'] } });
    expect(odd.error.message).toContain('Collage, Riso');
    const v = await tool(env, as.producer.access, 'add_variant', { piece_id: pieceId, format: '1:1', style: 'RISO' });
    expect(v.ok, JSON.stringify(v.error)).toBe(true);
    expect(v.data.style).toBe('Riso');
    expect((await tool(env, as.producer.access, 'add_variant', { piece_id: pieceId, format: '16:9' })).ok).toBe(true);

    // Taking a style off the list leaves the variants that have it alone.
    expect((await tool(env, as.admin.access, 'remove_variant_style', { style: 'Acuarela' })).error.code).toBe('unknown_style');
    expect((await tool(env, as.admin.access, 'remove_variant_style', { style: 'riso' })).data.variant_styles).toEqual(['Collage']);
    expect((await env.db.one<{ style: string }>('select style from variant where id = $1', [v.data.id]))!.style).toBe('Riso');
    await env.call(env.users.admin, 'PATCH', brandUrl(), { rules: { variant_styles: [] } });
  });
});

describe('approving from an assistant', () => {
  it('is refused while the brand has it off, with where to turn it on', async () => {
    const v = await inReview();
    const confirm = { piece: v.title, version_number: v.number, fingerprint: v.fingerprint.slice(0, 12) };
    const r = await tool(env, as.approver.access, 'approve_version', { version_id: v.versionId, account_ids: [env.accounts.instagram], confirm });
    expect(r.error).toMatchObject({ code: 'assistant_approval_off', details: { settings_url: 'http://app.test/settings?tab=assistants' } });
    expect(r.error.message).toContain('Settings');
    const rc = await tool(env, as.reviewer.access, 'request_changes', { version_id: v.versionId, note: 'Shorter', confirm });
    expect(rc.error.code).toBe('assistant_approval_off');
    expect((await env.db.one('select review_state from version where id = $1', [v.versionId]))!.review_state).toBe('in_review');
  });

  it('when on, needs the person\'s confirmation of this very version, and the role that can approve', async () => {
    expect((await setApproval(true)).status).toBe(200);
    expect((await tool(env, as.approver.access, 'list_brands')).data.brands[0].approval.assistant_can_approve).toBe(true);
    const v = await inReview();
    const confirm = { piece: v.title, version_number: v.number, fingerprint: v.fingerprint.slice(0, 12) };
    const approve = (who: Connection, c: Record<string, unknown>) =>
      tool(env, who.access, 'approve_version', { version_id: v.versionId, account_ids: [env.accounts.instagram], confirm: c });

    for (const bad of [
      { ...confirm, version_number: 2 },
      { ...confirm, fingerprint: 'deadbeefdead' },
      { ...confirm, piece: 'Another piece' },
      { ...confirm, fingerprint: v.fingerprint.slice(0, 8) },
    ]) {
      const r = await approve(as.approver, bad);
      expect(r.ok).toBe(false);
      expect(['confirmation_mismatch', 'invalid_arguments']).toContain(r.error.code);
    }
    const mismatch = await approve(as.approver, { ...confirm, version_number: 2 });
    expect(mismatch.error.details.current).toMatchObject({ version_number: 1, fingerprint: v.fingerprint.slice(0, 12), piece: v.title });

    // A reviewer cannot approve, setting or not: the service's own role check.
    expect((await approve(as.reviewer, confirm)).error.code).toBe('forbidden');
    expect((await env.db.one('select count(*)::int as n from approval where version_id = $1', [v.versionId]))!.n).toBe(0);

    const ok = await approve(as.approver, { ...confirm, piece: `  ${v.title.toUpperCase()} ` });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    expect(ok.data).toMatchObject({ state: 'approved', approved: true, fingerprint: v.fingerprint.slice(0, 12) });
    const trail = await viaOf('version.approved', v.versionId);
    expect(trail).toMatchObject({ actor_user_id: env.users.approver.id, via: { channel: 'mcp', client_name: 'Claude' } });
    const feed = (await env.call(env.users.admin, 'GET', `${brandUrl()}/overview`)).body.activity as any[];
    expect(feed.find((e) => e.kind === 'approved' && e.version_id === v.versionId)).toMatchObject({ via: 'Claude', actor: 'approver' });
    // The full fingerprint is as good as the web's twelve characters.
    const w = await inReview();
    expect((await tool(env, as.approver.access, 'approve_version', { version_id: w.versionId, account_ids: [env.accounts.instagram], confirm: { piece: w.pieceId, version_number: 1, fingerprint: w.fingerprint } })).ok).toBe(true);
  });

  it('keeps the approval rules of the web: never one\'s own upload, never with open comments, the checklist', async () => {
    await setApproval(true);
    // Own upload.
    const { pieceId, variantId } = await env.makePiece(env.users.approver);
    const own = await env.newVersion(env.users.approver, variantId);
    const title = (await env.call(env.users.admin, 'GET', `/api/pieces/${pieceId}`)).body.title;
    const mine = await tool(env, as.approver.access, 'approve_version', { version_id: own.body.id, account_ids: [env.accounts.instagram], confirm: { piece: title, version_number: 1, fingerprint: own.body.fingerprint.slice(0, 12) } });
    expect(mine.error.code).toBe('forbidden');
    // Open comments.
    const v = await inReview();
    const confirm = { piece: v.title, version_number: 1, fingerprint: v.fingerprint.slice(0, 12) };
    await env.call(env.users.reviewer, 'POST', `/api/versions/${v.versionId}/comments`, { body: 'Fix the end' });
    expect((await tool(env, as.approver.access, 'approve_version', { version_id: v.versionId, account_ids: [env.accounts.instagram], confirm })).error.code).toBe('open_comments');
    // The checklist must be confirmed item by item.
    await env.call(env.users.admin, 'PATCH', brandUrl(), { rules: { checklist: ['Music licensed'] } });
    const w = await inReview();
    const c2 = { piece: w.title, version_number: 1, fingerprint: w.fingerprint.slice(0, 12) };
    expect((await tool(env, as.approver.access, 'approve_version', { version_id: w.versionId, account_ids: [env.accounts.instagram], confirm: c2 })).error.code).toBe('checklist_incomplete');
    expect((await tool(env, as.approver.access, 'approve_version', { version_id: w.versionId, account_ids: [env.accounts.instagram], confirm: c2, checklist_confirmed: ['Music licensed'] })).ok).toBe(true);
    await env.call(env.users.admin, 'PATCH', brandUrl(), { rules: { checklist: [] } });
  });

  it('lets a reviewer request changes when on, with the confirmation, and audits it via the assistant', async () => {
    await setApproval(true);
    const v = await inReview();
    const confirm = { piece: v.title, version_number: 1, fingerprint: v.fingerprint.slice(0, 12) };
    expect((await tool(env, as.reader.access, 'request_changes', { version_id: v.versionId, note: 'x', confirm })).error.code).toBe('forbidden');
    expect((await tool(env, as.reviewer.access, 'request_changes', { version_id: v.versionId, note: 'x', confirm: { ...confirm, version_number: 9 } })).error.code).toBe('confirmation_mismatch');
    const r = await tool(env, as.reviewer.access, 'request_changes', { version_id: v.versionId, note: 'Make it shorter', confirm });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toMatchObject({ state: 'changes_requested', open_comments: 1 });
    expect((await viaOf('version.changes_requested', v.versionId))!.via).toMatchObject({ client_name: 'Claude' });
    const feed = (await env.call(env.users.admin, 'GET', `${brandUrl()}/overview`)).body.activity as any[];
    expect(feed.find((e) => e.kind === 'changes_requested' && e.version_id === v.versionId)).toMatchObject({ via: 'Claude' });
  });

  it('turns off again for everyone at once', async () => {
    await setApproval(false);
    const v = await inReview();
    const r = await tool(env, as.approver.access, 'approve_version', { version_id: v.versionId, account_ids: [env.accounts.instagram], confirm: { piece: v.title, version_number: 1, fingerprint: v.fingerprint.slice(0, 12) } });
    expect(r.error.code).toBe('assistant_approval_off');
    // Turning it on and off is the admin's, in the web, and audited.
    expect((await env.call(env.users.approver, 'PATCH', brandUrl(), { mcp: { allow_approval: true } })).status).toBe(403);
    const audit = await env.db.one(`select after from audit_event where action = 'brand.updated' order by id desc limit 1`);
    expect(audit!.after.mcp).toEqual({ allow_approval: false });
  });
});

describe('scheduling', () => {
  async function approved() {
    const v = await inReview();
    expect((await env.approve(env.users.approver, v.versionId, [env.accounts.instagram])).status).toBe(201);
    return v;
  }

  it('schedules only what is approved, for an approved account, at a brand-local time, as the person via the assistant', async () => {
    const v = await approved();
    const at = localIn(4);
    const dry = await tool(env, as.approver.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at, text: 'Otoño', dry_run: true });
    expect(dry.ok, JSON.stringify(dry.error)).toBe(true);
    expect(dry.data).toMatchObject({ dry_run: true, timezone: 'Europe/Madrid', publishes_by_itself: false });
    expect(dry.data.at_local).toContain('19:00');
    expect(await env.db.one('select 1 from publication where version_id = $1', [v.versionId])).toBeNull();

    expect((await tool(env, as.approver.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.youtube, at })).error.code).toBe('account_not_approved');
    expect((await tool(env, as.reviewer.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at })).error.code).toBe('forbidden');
    expect((await tool(env, as.approver.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at: 'next tuesday' })).error.code).toBe('bad_time');
    expect((await tool(env, as.approver.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at: localIn(-2) })).error.code).toBe('past_date');
    const unapproved = await inReview();
    expect((await tool(env, as.approver.access, 'schedule_publication', { version_id: unapproved.versionId, account_id: env.accounts.instagram, at })).error.code).toBe('not_approved');

    const pub = await tool(env, as.approver.access, 'schedule_publication', { version_id: v.versionId, account_id: env.accounts.instagram, at, text: 'Otoño' });
    expect(pub.ok, JSON.stringify(pub.error)).toBe(true);
    const row = await env.db.one('select scheduled_at, created_by, scheduled_by from publication where id = $1', [pub.data.id]);
    expect(DateTime.fromJSDate(row!.scheduled_at, { zone: 'Europe/Madrid' }).toFormat('HH:mm')).toBe('19:00');
    expect(row).toMatchObject({ created_by: env.users.approver.id, scheduled_by: 'person' });
    expect((await viaOf('publication.scheduled', pub.data.id))!.via).toMatchObject({ client_name: 'Claude' });
    const cal = await tool(env, as.reader.access, 'calendar', { from: DateTime.now().setZone('Europe/Madrid').toISODate(), to: DateTime.now().setZone('Europe/Madrid').plus({ days: 10 }).toISODate() });
    expect(cal.data.publications.find((x: any) => x.id === pub.data.id)).toMatchObject({ status: 'scheduled', network: 'instagram' });

    const moved = await tool(env, as.approver.access, 'move_publication', { publication_id: pub.data.id, at: localIn(5, '10:30') });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(moved.data.at_local).toContain('10:30');
    expect((await viaOf('publication.changed', pub.data.id))!.via).toMatchObject({ client_name: 'Claude' });
    expect((await tool(env, as.producer.access, 'cancel_publication', { publication_id: pub.data.id })).error.code).toBe('forbidden');
    const cancelled = await tool(env, as.approver.access, 'cancel_publication', { publication_id: pub.data.id });
    expect(cancelled.data.status).toBe('cancelled');
    expect((await viaOf('publication.cancelled', pub.data.id))!.via).toMatchObject({ client_name: 'Claude' });
  });
});

describe('what is pending', () => {
  it('lists versions awaiting the approver, comments for the producer, and failed publications', async () => {
    const v = await inReview();
    const forApprover = await tool(env, as.approver.access, 'pending_for_me');
    expect(forApprover.data.awaiting_your_decision.some((x: any) => x.version_id === v.versionId)).toBe(true);
    expect(forApprover.data.what_you_can_do_with_them).toBe('approve');
    // A reader is shown nothing to decide.
    expect((await tool(env, as.reader.access, 'pending_for_me')).data.awaiting_your_decision).toEqual([]);

    await env.call(env.users.reviewer, 'POST', `/api/versions/${v.versionId}/comments`, { body: 'Brighter please', anchor: { type: 'time', t: 2 } });
    const forProducer = await tool(env, as.producer.access, 'pending_for_me');
    expect(forProducer.data.comments_for_you.find((c: any) => c.text === 'Brighter please')).toMatchObject({ why: 'on_your_upload', where: 'at 0:02', author: 'reviewer', version_id: v.versionId });

    const ap = await inReview();
    await env.approve(env.users.approver, ap.versionId, [env.accounts.instagram]);
    const p = await env.call(env.users.approver, 'POST', `/api/versions/${ap.versionId}/publications`, { accountId: env.accounts.instagram, scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    await env.db.query(`update publication set status = 'failed', last_error = 'The network said no', failed_at = now() where id = $1`, [p.body.id]);
    const attention = (await tool(env, as.approver.access, 'pending_for_me')).data.needs_attention;
    expect(attention.find((x: any) => x.id === p.body.id)).toMatchObject({ kind: 'publication_failed', detail: 'The network said no', url: `http://app.test/pieces/${ap.pieceId}` });

    const notes = await tool(env, as.producer.access, 'list_notifications', { unread_only: true });
    expect(notes.data.notifications.some((n: any) => n.kind === 'comment.created')).toBe(true);
  });
});

describe('brands the person did not choose', () => {
  it('do not exist for the assistant, even where the person is a member', async () => {
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone, locale) values ($1,'Second brand','Europe/Madrid','en') returning id`, [env.workspaceId]))!.id;
    for (const who of ['approver', 'producer'] as const) await env.db.query('insert into member (user_id, brand_id, role) values ($1,$2,$3)', [env.users[who].id, other, who]);
    // A piece in the second brand, made in the web.
    const piece = await env.call(env.users.producer, 'POST', `/api/brands/${other}/pieces`, { title: 'Secret', kind: 'video' });
    expect(piece.status).toBe(201);

    const onlyFirst = as.approver;
    expect((await tool(env, onlyFirst.access, 'list_brands')).data.brands.map((b: any) => b.name)).toEqual(['Test brand']);
    expect((await tool(env, onlyFirst.access, 'get_piece', { piece_id: piece.body.id })).error.code).toBe('not_found');
    expect((await tool(env, onlyFirst.access, 'list_pieces', { brand: other })).error.code).toBe('not_found');
    expect((await tool(env, onlyFirst.access, 'list_pieces', { brand: 'Second brand' })).error.code).toBe('unknown_brand');

    // Allowed both: it has to be told which.
    const both = await connect(env, env.users.producer as Actor, { brandIds: [env.brandId, other] });
    const which = await tool(env, both.access, 'list_pieces');
    expect(which.error.code).toBe('brand_required');
    expect((await tool(env, both.access, 'list_pieces', { brand: 'Second brand' })).data.pieces.map((x: any) => x.title)).toEqual(['Secret']);
    // An admin of the first brand takes it away from that connection: the second brand stays.
    const off = await env.call(env.users.admin, 'DELETE', `${brandUrl()}/assistants/${both.grantId}`);
    expect(off.body).toMatchObject({ ended: false });
    expect((await tool(env, both.access, 'list_brands')).data.brands.map((b: any) => b.name)).toEqual(['Second brand']);
    expect((await tool(env, both.access, 'list_pieces', { brand: env.brandId })).error.code).toBe('not_found');
  });
});
