import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });


describe('uploads and versions', () => {
  it('creates an immutable version in review with a fingerprint, and moves the piece to in_review', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    expect(v.status).toBe(201);
    expect(v.body.number).toBe(1);
    expect(v.body.review_state).toBe('in_review');
    expect(v.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const piece = await call(users.producer, 'GET', `/api/pieces/${pieceId}`);
    expect(piece.body.review_state).toBe('in_review');
    expect(piece.body.variants[0].versions).toHaveLength(1);
  });

  it('rejects an upload whose bytes do not match the declared sha256', async () => {
    const { users, call, makePiece, app } = env;
    const { variantId } = await makePiece(users.producer);
    const data = randomBytes(100);
    const r = await call(users.producer, 'POST', `/api/variants/${variantId}/uploads`, {
      files: [{ name: 'a.mp4', mime: 'video/mp4', bytes: data.length, sha256: createHash('sha256').update('something else').digest('hex') }],
    });
    const url = new URL(r.body.uploads[0].url);
    const put = await app.inject({ method: 'PUT', url: url.pathname + url.search, headers: r.body.uploads[0].headers, payload: data });
    expect(put.statusCode).toBe(400);
    const close = await call(users.producer, 'POST', `/api/variants/${variantId}/versions`, {
      files: [{ uploadId: r.body.uploads[0].uploadId, kind: 'video', position: 0 }],
    });
    expect(close.status).toBe(400);
    expect(close.body.error.code).toBe('upload_missing');
  });

  it('refuses a signed upload URL that has been tampered with', async () => {
    const { users, call, makePiece, app } = env;
    const { variantId } = await makePiece(users.producer);
    const data = randomBytes(50);
    const r = await call(users.producer, 'POST', `/api/variants/${variantId}/uploads`, {
      files: [{ name: 'a.mp4', mime: 'video/mp4', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }],
    });
    const url = new URL(r.body.uploads[0].url);
    url.searchParams.set('bytes', '9999');
    const put = await app.inject({ method: 'PUT', url: url.pathname + url.search, payload: data });
    expect(put.statusCode).toBe(403);
  });

  it('refuses two identical consecutive versions', async () => {
    const { users, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const data = randomBytes(80);
    expect((await newVersion(users.producer, variantId, [{ data }])).status).toBe(201);
    const again = await newVersion(users.producer, variantId, [{ data }]);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('identical_version');
  });

  it('checks the files against the variant format', async () => {
    const { users, makePiece, newVersion } = env;
    const doc = await makePiece(users.producer, 'pdf', 'document');
    const bad = await newVersion(users.producer, doc.variantId, [{}]);
    expect(bad.status).toBe(400);
    const ok = await newVersion(users.producer, doc.variantId, [{ name: 'deck.pdf', mime: 'application/pdf', kind: 'pdf' }]);
    expect(ok.status).toBe(201);
    const carousel = await makePiece(users.producer, 'carousel', 'carousel');
    const one = await newVersion(users.producer, carousel.variantId, [{ name: 'a.png', mime: 'image/png', kind: 'image' }]);
    expect(one.body.error.code).toBe('invalid_files');
    const two = await newVersion(users.producer, carousel.variantId, [
      { name: 'a.png', mime: 'image/png', kind: 'image' },
      { name: 'b.png', mime: 'image/png', kind: 'image' },
    ]);
    expect(two.status).toBe(201);
  });

  it('does not let a reader upload', async () => {
    const { users, call, makePiece } = env;
    const { variantId } = await makePiece(users.producer);
    const r = await call(users.reader, 'POST', `/api/variants/${variantId}/uploads`, {
      files: [{ name: 'a.mp4', mime: 'video/mp4', bytes: 1, sha256: 'a'.repeat(64) }],
    });
    expect(r.status).toBe(403);
  });
});

describe('comments', () => {
  it('lets a reviewer anchor a comment to a moment and stores the frame', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const c = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, {
      body: 'The logo is cut off here', anchor: { type: 'time', t: 3.5 },
    });
    expect(c.status).toBe(201);
    expect(c.body.frame_key).toMatch(/comments\/.+\.jpg$/);
    const list = await call(users.producer, 'GET', `/api/versions/${v.body.id}/comments`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].frame_url).toContain('/media/');
    expect(list.body[0].anchor).toEqual({ type: 'time', t: 3.5 });
  });

  it('rejects an anchor that does not fit the version', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId); // 10 s video
    const late = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'x', anchor: { type: 'time', t: 99 } });
    expect(late.body.error.code).toBe('invalid_anchor');
    const page = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'x', anchor: { type: 'region', page: 3, x: 0, y: 0 } });
    expect(page.body.error.code).toBe('invalid_anchor');
  });

  it('only reviewers and approvers start threads; producers reply and resolve; readers do neither', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const body = { body: 'Please check the date' };
    expect((await call(users.producer, 'POST', `/api/versions/${v.body.id}/comments`, body)).status).toBe(403);
    expect((await call(users.reader, 'POST', `/api/versions/${v.body.id}/comments`, body)).status).toBe(403);
    const c = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, body);
    expect(c.status).toBe(201);
    const reply = await call(users.producer, 'POST', `/api/comments/${c.body.id}/replies`, { body: 'Fixed', kind: 'fixed' });
    expect(reply.status).toBe(201);
    expect((await call(users.reader, 'POST', `/api/comments/${c.body.id}/replies`, { body: 'hi' })).status).toBe(403);
    expect((await call(users.reader, 'POST', `/api/comments/${c.body.id}/resolve`)).status).toBe(403);
    expect((await call(users.producer, 'POST', `/api/comments/${c.body.id}/resolve`)).status).toBe(200);
    expect((await call(users.producer, 'POST', `/api/comments/${c.body.id}/reopen`)).status).toBe(403);
    expect((await call(users.reviewer, 'POST', `/api/comments/${c.body.id}/reopen`)).status).toBe(200);
  });
});

describe('approval', () => {
  it('lets only approvers approve, never with open comments, and records the fingerprint', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const c = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'Typo in the title' });

    expect((await approve(users.reviewer, v.body.id)).status).toBe(403);
    expect((await approve(users.producer, v.body.id)).status).toBe(403);
    expect((await approve(users.reader, v.body.id)).status).toBe(403);

    const blocked = await approve(users.approver, v.body.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('open_comments');

    // The approver closes the comment by hand and then approves.
    expect((await call(users.approver, 'POST', `/api/comments/${c.body.id}/resolve`)).status).toBe(200);
    const ok = await approve(users.approver, v.body.id);
    expect(ok.status).toBe(201);
    expect(ok.body.review_state).toBe('approved');
    expect(ok.body.fingerprint).toBe(v.body.fingerprint);
    expect((await call(users.producer, 'GET', `/api/pieces/${pieceId}`)).body.review_state).toBe('approved');
  });

  it('never lets someone approve their own upload, admins included', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.admin);
    const v = await newVersion(users.admin, variantId);
    const r = await approve(users.admin, v.body.id);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/uploaded yourself/);
    // Someone else can.
    expect((await approve(users.approver, v.body.id)).status).toBe(201);
    expect((await call(users.admin, 'GET', `/api/versions/${v.body.id}`)).body.review_state).toBe('approved');
  });

  it('applies the same rule to approvers, who can upload', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.approver);
    const v = await newVersion(users.approver, variantId);
    expect(v.status).toBe(201);
    expect((await approve(users.approver, v.body.id)).status).toBe(403);
    expect((await approve(users.approver2, v.body.id)).status).toBe(201);
    expect((await call(users.approver, 'GET', `/api/versions/${v.body.id}`)).body.review_state).toBe('approved');
  });

  it('enforces the brand checklist and valid accounts', async () => {
    const { users, call, db, brandId, makePiece, newVersion, approve, accounts } = env;
    await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { rules: { checklist: ['Facts verified', 'Subtitles reviewed'] } });
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const partial = await approve(users.approver, v.body.id, [accounts.instagram], { checklist: { 'Facts verified': true } });
    expect(partial.status).toBe(400);
    expect(partial.body.error.code).toBe('checklist_incomplete');
    expect(partial.body.error.details.missing).toEqual(['Subtitles reviewed']);
    const none = await approve(users.approver, v.body.id, [], { checklist: { 'Facts verified': true, 'Subtitles reviewed': true } });
    expect(none.body.error.code).toBe('no_accounts');
    const foreign = await approve(users.approver, v.body.id, ['00000000-0000-4000-8000-000000000000'], { checklist: { 'Facts verified': true, 'Subtitles reviewed': true } });
    expect(foreign.body.error.code).toBe('invalid_accounts');
    const ok = await approve(users.approver, v.body.id, [accounts.instagram], { checklist: { 'Facts verified': true, 'Subtitles reviewed': true } });
    expect(ok.status).toBe(201);
    await db.query(`update brand set approval_rules = approval_rules || '{"checklist":[]}' where id = $1`, [brandId]);
  });

  it('asks for a reason when rejecting and sends the version back for changes', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const noNote = await call(users.approver, 'POST', `/api/versions/${v.body.id}/approvals`, { decision: 'reject' });
    expect(noNote.body.error.code).toBe('note_required');
    const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/approvals`, { decision: 'reject', note: 'Wrong offer' });
    expect(r.body.review_state).toBe('changes_requested');
    expect((await call(users.producer, 'GET', `/api/pieces/${pieceId}`)).body.review_state).toBe('changes_requested');
  });

  it('needs at least one comment (or a note) to request changes', async () => {
    const { users, call, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    expect((await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/request-changes`, {})).body.error.code).toBe('no_comments');
    expect((await call(users.producer, 'POST', `/api/versions/${v.body.id}/request-changes`, { note: 'x' })).status).toBe(403);
    const ok = await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/request-changes`, { note: 'Shorter intro please' });
    expect(ok.status).toBe(200);
    expect(ok.body.review_state).toBe('changes_requested');
  });

  it('a new version goes back to review, supersedes the old one and voids its approval', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v1 = await newVersion(users.producer, variantId);
    expect((await approve(users.approver, v1.body.id)).body.review_state).toBe('approved');
    const v2 = await newVersion(users.producer, variantId);
    expect(v2.body.number).toBe(2);
    expect(v2.body.review_state).toBe('in_review');
    const old = await call(users.approver, 'GET', `/api/versions/${v1.body.id}`);
    expect(old.body.review_state).toBe('superseded');
    // Approving the old version again is impossible.
    expect((await approve(users.approver2, v1.body.id)).body.error.code).toBe('invalid_state');
    // And the piece is not approved any more.
    expect((await call(users.producer, 'GET', `/api/pieces/${pieceId}`)).body.review_state).toBe('in_review');
  });

  it('carries unresolved comments over and lets the next version resolve them', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer);
    const v1 = await newVersion(users.producer, variantId);
    const c1 = await call(users.reviewer, 'POST', `/api/versions/${v1.body.id}/comments`, { body: 'Fix the intro' });
    const c2 = await call(users.reviewer, 'POST', `/api/versions/${v1.body.id}/comments`, { body: 'Louder music' });
    await call(users.reviewer, 'POST', `/api/versions/${v1.body.id}/request-changes`, {});
    const v2 = await newVersion(users.producer, variantId, [{}], { resolves: [c1.body.id] });
    expect(v2.status).toBe(201);

    // v2 shows what it fixed ("resolved in v2") next to what is still open.
    const carried = await call(users.approver, 'GET', `/api/versions/${v2.body.id}/comments?carried=true`);
    expect(carried.body.map((c: any) => [c.body, c.status, c.carried, c.resolved_in_number])).toEqual([
      ['Fix the intro', 'resolved', true, 2],
      ['Louder music', 'open', true, null],
    ]);
    // Asking only for what is open (what the producer needs before the next upload) leaves out the fixed one.
    const stillOpen = await call(users.approver, 'GET', `/api/versions/${v2.body.id}/comments?carried=true&status=open`);
    expect(stillOpen.body.map((c: any) => c.body)).toEqual(['Louder music']);
    const all = await call(users.approver, 'GET', `/api/versions/${v1.body.id}/comments`);
    const fixed = all.body.find((c: any) => c.id === c1.body.id);
    expect(fixed.status).toBe('resolved');
    expect(fixed.resolved_in_number).toBe(2);

    // The one nobody resolved still blocks approval of v2.
    expect((await approve(users.approver, v2.body.id)).body.error.code).toBe('open_comments');
    // The agent (a token) may reply to a comment on a superseded version.
    const reply = await call(users.producer, 'POST', `/api/comments/${c2.body.id}/replies`, { body: 'Needs a person', kind: 'needs_human' });
    expect(reply.status).toBe(201);
  });

  it('refuses to resolve comments that belong to another variant', async () => {
    const { users, call, makePiece, newVersion } = env;
    const a = await makePiece(users.producer);
    const b = await makePiece(users.producer);
    const va = await newVersion(users.producer, a.variantId);
    const c = await call(users.reviewer, 'POST', `/api/versions/${va.body.id}/comments`, { body: 'x' });
    const r = await newVersion(users.producer, b.variantId, [{}], { resolves: [c.body.id] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_comment');
  });

  it('with two required approvals, needs two different approvers who agree on an account', async () => {
    const { users, call, db, brandId, makePiece, newVersion, approve, accounts } = env;
    await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { rules: { required_approvals: 2 } });
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    const first = await approve(users.approver, v.body.id, [accounts.instagram, accounts.youtube]);
    expect(first.body.review_state).toBe('in_review');
    expect((await approve(users.approver, v.body.id)).body.error.code).toBe('already_decided');
    const disjoint = await approve(users.approver2, v.body.id, [accounts.facebook]);
    expect(disjoint.body.error.code).toBe('no_common_accounts');
    const second = await approve(users.approver2, v.body.id, [accounts.youtube, accounts.facebook]);
    expect(second.body.review_state).toBe('approved');
    await db.query(`update brand set approval_rules = approval_rules || '{"required_approvals":1}' where id = $1`, [brandId]);
  });

  it('records everything in the audit log', async () => {
    const { users, call, brandId, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id);
    const log = await call(users.approver, 'GET', `/api/brands/${brandId}/audit?entity=version&entityId=${v.body.id}`);
    expect(log.body.map((e: any) => e.action)).toEqual(['version.approved', 'version.created']);
    expect(log.body[0].after.fingerprint).toBe(v.body.fingerprint);
    expect((await call(users.reviewer, 'GET', `/api/brands/${brandId}/audit`)).status).toBe(403);
  });
});
