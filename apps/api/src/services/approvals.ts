import { z } from 'zod';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { canTransition } from '../domain/review.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { isKnown, msg, type Key, type Localized } from '../i18n/index.js';
import { audit } from './audit.js';
import { accountRef, actorOf, commentRef, emit, openComments, pieceRef, versionRef } from './events.js';
import { openCommentCount } from './comments.js';
import { loadBrand, loadVersion, rulesOf } from './loaders.js';
import { notifyUsers } from './notify.js';
import { refreshPieceState } from './pieces.js';
import { recomputeFingerprint, storedFilesMatch, uploaderOf } from './versions.js';

export const decisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  accountIds: z.array(z.string().uuid()).max(50).default([]),
  checklist: z.record(z.string(), z.boolean()).default({}),
  note: z.string().max(5000).default(''),
});

export const requestChangesInput = z.object({
  note: z.string().trim().max(5000).default(''),
});

/** A version's state as a word in a sentence, in the reader's language (the English is the state's code, as it always was). */
const versionState = (state: string): Localized | string => (isKnown(`error.versionState.${state}`) ? msg(`error.versionState.${state}` as Key) : state);

async function setVersionState(db: Queryable, versionId: string, from: string, to: string) {
  if (!canTransition(from as never, to as never)) throw conflict('invalid_state', msg('error.approval.transition', { from: versionState(from), to: versionState(to) }));
  await db.query('update version set review_state = $2 where id = $1', [versionId, to]);
}

async function notifyAuthor(
  db: Queryable,
  version: { brand_id: string; piece_id: string; author_user_id: string | null; id: string },
  kind: 'version.approved' | 'version.changes_requested',
  actorUserId: string | null,
) {
  const piece = await db.one('select created_by_user from piece where id = $1', [version.piece_id]);
  await notifyUsers(db, version.brand_id, [version.author_user_id, piece?.created_by_user], kind,
    { versionId: version.id, pieceId: version.piece_id }, actorUserId);
}

/** What starts whoever produces: the open comments with their anchors and frames, and who asked. */
export async function emitChangesRequested(
  ctx: Ctx, db: Queryable, p: Principal, version: { id: string; brand_id: string; piece_id: string; variant_id: string },
  reason: 'changes_requested' | 'rejected' | 'agent_reset', note: string | null,
) {
  const comments = await openComments(db, version.variant_id);
  await emit(ctx, db, version.brand_id, 'version.changes_requested', {
    reason, note, requested_by: await actorOf(db, p), piece: await pieceRef(db, version.piece_id), version: await versionRef(db, version.id),
    comments, people_only_open: comments.filter((c) => c.people_only).length,
  });
}

/**
 * A reviewer or approver asks for changes. There must be something to change: at least one open comment
 * (on this version or carried from earlier ones), or a note that becomes a general comment.
 */
export async function requestChanges(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = requestChangesInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await db.query('select 1 from version where id = $1 for update', [versionId]);
    const version = await loadVersion(db, versionId);
    await authorize(db, p, version.brand_id, 'version.request_changes');
    if (version.review_state !== 'in_review') {
      throw conflict('invalid_state', msg('error.approval.changesOnlyInReview'));
    }
    const a = actorCols(p);
    if (input.note) {
      const note = await db.one<{ id: string }>('insert into comment (version_id, author_user_id, author_token_id, body) values ($1,$2,$3,$4) returning id', [versionId, a.user, a.token, input.note]);
      const ref = await commentRef(db, note!.id);
      if (ref) await emit(ctx, db, version.brand_id, 'comment.created', ref);
    }
    const open = await openCommentCount(db, version.variant_id);
    if (open === 0) throw badRequest('no_comments', msg('error.approval.noComments'));
    await setVersionState(db, versionId, version.review_state, 'changes_requested');
    await refreshPieceState(db, version.piece_id);
    await audit(db, p, version.brand_id, 'version.changes_requested', 'version', versionId,
      { review_state: 'in_review' }, { review_state: 'changes_requested', open_comments: open });
    await notifyAuthor(db, version, 'version.changes_requested', a.user);
    await emitChangesRequested(ctx, db, p, version, 'changes_requested', input.note || null);
    return { versionId, review_state: 'changes_requested', open_comments: open };
  });
}

/**
 * An approver approves or rejects a specific version for specific accounts.
 *
 * - Never your own upload, whatever your role.
 * - Never with open comments: the approver has to resolve them first.
 * - The approval records the fingerprint of the files, so it only counts for exactly those files.
 * - When the brand needs several approvals, the approved accounts are the ones every approver agreed on.
 */
export async function decide(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = decisionInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await db.query('select 1 from version where id = $1 for update', [versionId]);
    const version = await loadVersion(db, versionId);
    await authorize(db, p, version.brand_id, 'version.approve');
    if (p.kind !== 'user') throw forbidden(msg('error.approval.peopleOnly'));
    if (version.review_state !== 'in_review') throw conflict('invalid_state', msg('error.approval.onlyInReview'));
    if (version.author_user_id === p.userId) {
      throw forbidden(msg('error.approval.ownUpload'));
    }
    const fingerprint = await recomputeFingerprint(db, versionId);
    // Both the file records and the stored objects themselves: a file replaced in storage stops counting too.
    if (fingerprint !== version.fingerprint || (input.decision === 'approve' && !(await storedFilesMatch(ctx, versionId, db)))) {
      ctx.log.error({ versionId }, 'stored files no longer match the version fingerprint');
      throw conflict('fingerprint_mismatch', msg('error.approval.fingerprint'));
    }
    const brand = await loadBrand(db, version.brand_id);
    const rules = rulesOf(brand);
    const prior = await db.one('select 1 from approval where version_id = $1 and approver_user_id = $2', [versionId, p.userId]);
    if (prior) throw conflict('already_decided', msg('error.approval.alreadyDecided'));

    if (input.decision === 'reject') {
      if (!input.note.trim()) throw badRequest('note_required', msg('error.approval.noteRequired'));
    } else {
      const open = await openCommentCount(db, version.variant_id);
      if (open > 0) throw conflict('open_comments', msg('error.approval.openComments', { count: open }), { open });
      const missing = rules.checklist.filter((item) => input.checklist[item] !== true);
      if (missing.length) throw badRequest('checklist_incomplete', msg('error.approval.checklist'), { missing });
      if (input.accountIds.length === 0) throw badRequest('no_accounts', msg('error.approval.noAccounts'));
      const accounts = await db.query<{ id: string; status: string }>(
        'select id, status from social_account where brand_id = $1 and id = any($2)',
        [version.brand_id, input.accountIds],
      );
      if (accounts.length !== new Set(input.accountIds).size) throw badRequest('invalid_accounts', msg('error.approval.accountNotInBrand'));
      if (accounts.some((x) => x.status === 'reconnect_required')) throw badRequest('invalid_accounts', msg('error.approval.accountReconnect'));
    }

    // What goes to a network besides the files is approved with them: the title and the AI label as the approver saw them.
    const piece = (await db.one<{ title: string; ai_generated: boolean }>('select title, ai_generated from piece where id = $1', [version.piece_id]))!;
    await db.query(
      `insert into approval (version_id, approver_user_id, decision, account_ids, approved_fingerprint, checklist, note, piece_title, ai_generated)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [versionId, p.userId, input.decision, input.decision === 'approve' ? input.accountIds : [], fingerprint, JSON.stringify(input.checklist), input.note,
        piece.title, piece.ai_generated],
    );

    let state = 'in_review';
    if (input.decision === 'reject') {
      await setVersionState(db, versionId, 'in_review', 'changes_requested');
      state = 'changes_requested';
    } else {
      const valid = await db.query<{ account_ids: string[] }>(
        `select account_ids from approval where version_id = $1 and decision = 'approve' and approved_fingerprint = $2`,
        [versionId, fingerprint],
      );
      const common = valid.map((v) => v.account_ids).reduce((acc, ids) => acc.filter((x) => ids.includes(x)));
      if (common.length === 0) {
        throw conflict('no_common_accounts', msg('error.approval.noCommonAccounts'));
      }
      if (valid.length >= rules.required_approvals) {
        await setVersionState(db, versionId, 'in_review', 'approved');
        state = 'approved';
      }
    }
    await refreshPieceState(db, version.piece_id);
    // Who uploaded what was decided on, a person or a token (and who made that token), is part of the record of the decision.
    await audit(db, p, version.brand_id, `version.${input.decision === 'approve' ? 'approved' : 'rejected'}`, 'version', versionId,
      { review_state: 'in_review' },
      { review_state: state, fingerprint, accounts: input.accountIds, note: input.note, uploaded_by: await uploaderOf(db, versionId), title: piece.title, ai_generated: piece.ai_generated });
    if (state !== 'in_review') await notifyAuthor(db, version, state === 'approved' ? 'version.approved' : 'version.changes_requested', p.userId);
    if (input.decision === 'reject') {
      await emit(ctx, db, version.brand_id, 'version.rejected', {
        piece: await pieceRef(db, version.piece_id), version: await versionRef(db, versionId), note: input.note, rejected_by: await actorOf(db, p),
      });
      // A rejection also sends the version back for changes, which is what starts whoever produces it.
      await emitChangesRequested(ctx, db, p, version, 'rejected', input.note);
    } else if (state === 'approved') {
      const accounts = [];
      for (const id of input.accountIds) accounts.push(await accountRef(db, id));
      await emit(ctx, db, version.brand_id, 'version.approved', {
        piece: await pieceRef(db, version.piece_id), version: await versionRef(db, versionId), accounts: accounts.filter(Boolean),
        approvals: (await db.one<{ n: number }>(`select count(*)::int as n from approval where version_id = $1 and decision = 'approve' and approved_fingerprint = $2`, [versionId, fingerprint]))!.n,
      });
    }
    return { versionId, review_state: state, fingerprint };
  });
}

/**
 * Whether a version is approved right now, and for which accounts. An approval only counts when
 * the version is in the approved state, the files still hash to the approved fingerprint, and enough distinct
 * approvers approved exactly that fingerprint.
 */
export interface EffectiveApproval {
  approved: boolean;
  accountIds: string[];
  fingerprint: string | null;
  /** The title the approvers saw (the latest of them), or null for approvals older than the record of it. */
  title: string | null;
  /** Whether any approver saw the piece marked as made with AI. */
  aiGenerated: boolean;
}

export async function effectiveApproval(db: Queryable, versionId: string): Promise<EffectiveApproval> {
  const none = { approved: false, accountIds: [] as string[], fingerprint: null, title: null, aiGenerated: false };
  const version = await db.one<{ fingerprint: string; review_state: string; brand_id: string }>(
    `select ver.fingerprint, ver.review_state, p.brand_id from version ver
     join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id where ver.id = $1`,
    [versionId],
  );
  if (!version || version.review_state !== 'approved') return none;
  if ((await recomputeFingerprint(db, versionId)) !== version.fingerprint) return none;
  const rules = rulesOf(await loadBrand(db, version.brand_id));
  const rows = await db.query<{ account_ids: string[]; piece_title: string | null; ai_generated: boolean | null }>(
    `select account_ids, piece_title, ai_generated from approval where version_id = $1 and decision = 'approve' and approved_fingerprint = $2 order by created_at, id`,
    [versionId, version.fingerprint],
  );
  if (rows.length === 0 || rows.length < rules.required_approvals) return none;
  const common = rows.map((r) => r.account_ids).reduce((acc, ids) => acc.filter((x) => ids.includes(x)));
  const titled = rows.filter((r) => r.piece_title !== null);
  return {
    approved: common.length > 0, accountIds: common, fingerprint: version.fingerprint,
    title: titled.length ? titled[titled.length - 1]!.piece_title : null, aiGenerated: rows.some((r) => r.ai_generated === true),
  };
}
