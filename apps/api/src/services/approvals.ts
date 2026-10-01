import { z } from 'zod';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { canTransition } from '../domain/review.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { audit } from './audit.js';
import { openCommentCount } from './comments.js';
import { loadBrand, loadVersion, rulesOf } from './loaders.js';
import { notifyUsers } from './notify.js';
import { refreshPieceState } from './pieces.js';
import { recomputeFingerprint } from './versions.js';

export const decisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  accountIds: z.array(z.string().uuid()).max(50).default([]),
  checklist: z.record(z.string(), z.boolean()).default({}),
  note: z.string().max(5000).default(''),
});

export const requestChangesInput = z.object({
  note: z.string().trim().max(5000).default(''),
});

async function setVersionState(db: Queryable, versionId: string, from: string, to: string) {
  if (!canTransition(from as never, to as never)) throw conflict('invalid_state', `A version in state ${from} cannot become ${to}`);
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
      throw conflict('invalid_state', 'Changes can only be requested on a version that is in review');
    }
    const a = actorCols(p);
    if (input.note) {
      await db.query('insert into comment (version_id, author_user_id, author_token_id, body) values ($1,$2,$3,$4)', [versionId, a.user, a.token, input.note]);
    }
    const open = await openCommentCount(db, version.variant_id);
    if (open === 0) throw badRequest('no_comments', 'Add at least one comment (or a note) saying what should change');
    await setVersionState(db, versionId, version.review_state, 'changes_requested');
    await refreshPieceState(db, version.piece_id);
    await audit(db, p, version.brand_id, 'version.changes_requested', 'version', versionId,
      { review_state: 'in_review' }, { review_state: 'changes_requested', open_comments: open });
    await notifyAuthor(db, version, 'version.changes_requested', a.user);
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
    if (p.kind !== 'user') throw forbidden('Only people can approve');
    if (version.review_state !== 'in_review') throw conflict('invalid_state', 'Only a version that is in review can be approved or rejected');
    if (version.author_user_id === p.userId) {
      throw forbidden('You cannot approve a version you uploaded yourself');
    }
    const fingerprint = await recomputeFingerprint(db, versionId);
    if (fingerprint !== version.fingerprint) {
      ctx.log.error({ versionId }, 'stored files no longer match the version fingerprint');
      throw conflict('fingerprint_mismatch', 'The stored files do not match the version fingerprint; nothing can be approved');
    }
    const brand = await loadBrand(db, version.brand_id);
    const rules = rulesOf(brand);
    const prior = await db.one('select 1 from approval where version_id = $1 and approver_user_id = $2', [versionId, p.userId]);
    if (prior) throw conflict('already_decided', 'You have already decided on this version');

    if (input.decision === 'reject') {
      if (!input.note.trim()) throw badRequest('note_required', 'Say why you are rejecting this version');
    } else {
      const open = await openCommentCount(db, version.variant_id);
      if (open > 0) throw conflict('open_comments', `There are ${open} open comment(s): resolve them before approving`, { open });
      const missing = rules.checklist.filter((item) => input.checklist[item] !== true);
      if (missing.length) throw badRequest('checklist_incomplete', 'Tick every checklist item before approving', { missing });
      if (input.accountIds.length === 0) throw badRequest('no_accounts', 'Choose at least one account to approve for');
      const accounts = await db.query<{ id: string; status: string }>(
        'select id, status from social_account where brand_id = $1 and id = any($2)',
        [version.brand_id, input.accountIds],
      );
      if (accounts.length !== new Set(input.accountIds).size) throw badRequest('invalid_accounts', 'An account does not belong to this brand');
      if (accounts.some((x) => x.status === 'reconnect_required')) throw badRequest('invalid_accounts', 'An account needs to be reconnected first');
    }

    await db.query(
      `insert into approval (version_id, approver_user_id, decision, account_ids, approved_fingerprint, checklist, note)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [versionId, p.userId, input.decision, input.decision === 'approve' ? input.accountIds : [], fingerprint, JSON.stringify(input.checklist), input.note],
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
        throw conflict('no_common_accounts', 'The approvers did not agree on any account: align on at least one');
      }
      if (valid.length >= rules.required_approvals) {
        await setVersionState(db, versionId, 'in_review', 'approved');
        state = 'approved';
      }
    }
    await refreshPieceState(db, version.piece_id);
    await audit(db, p, version.brand_id, `version.${input.decision === 'approve' ? 'approved' : 'rejected'}`, 'version', versionId,
      { review_state: 'in_review' }, { review_state: state, fingerprint, accounts: input.accountIds, note: input.note });
    if (state !== 'in_review') await notifyAuthor(db, version, state === 'approved' ? 'version.approved' : 'version.changes_requested', p.userId);
    return { versionId, review_state: state, fingerprint };
  });
}

/**
 * Whether a version is approved right now, and for which accounts. An approval only counts when
 * the version is in the approved state, the files still hash to the approved fingerprint, and enough distinct
 * approvers approved exactly that fingerprint.
 */
export async function effectiveApproval(db: Queryable, versionId: string): Promise<{ approved: boolean; accountIds: string[]; fingerprint: string | null }> {
  const none = { approved: false, accountIds: [] as string[], fingerprint: null };
  const version = await db.one<{ fingerprint: string; review_state: string; brand_id: string }>(
    `select ver.fingerprint, ver.review_state, p.brand_id from version ver
     join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id where ver.id = $1`,
    [versionId],
  );
  if (!version || version.review_state !== 'approved') return none;
  if ((await recomputeFingerprint(db, versionId)) !== version.fingerprint) return none;
  const rules = rulesOf(await loadBrand(db, version.brand_id));
  const rows = await db.query<{ account_ids: string[] }>(
    `select account_ids from approval where version_id = $1 and decision = 'approve' and approved_fingerprint = $2`,
    [versionId, version.fingerprint],
  );
  if (rows.length === 0 || rows.length < rules.required_approvals) return none;
  const common = rows.map((r) => r.account_ids).reduce((acc, ids) => acc.filter((x) => ids.includes(x)));
  return { approved: common.length > 0, accountIds: common, fingerprint: version.fingerprint };
}
