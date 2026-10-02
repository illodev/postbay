import { z } from 'zod';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { derivePieceState, type VersionState } from '../domain/review.js';
import { can } from '../domain/roles.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { loadPiece, loadVariant } from './loaders.js';

export const KINDS = ['video', 'carousel', 'post', 'story', 'pdf'] as const;
export const FORMATS = ['9:16', '4:5', '1:1', '16:9', 'carousel', 'document'] as const;

/**
 * Where the piece's project lives (the code and material it is made from), as an opaque reference a runner resolves with its own
 * configuration, e.g. "videos:2026-09-29-quarterly-taxes/telenovela". One line, no control characters; empty clears it.
 */
const pieceSource = z
  .string()
  .trim()
  .max(500)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), 'The project source is one line of text, with no control characters')
  .transform((s) => s || null);

export const pieceInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(KINDS),
  brief: z.string().max(10_000).default(''),
  campaignId: z.string().uuid().nullish(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  aiGenerated: z.boolean().default(false),
  source: pieceSource.nullish(),
});

/**
 * An edit: only what is sent changes. (The creation schema's defaults must not apply here: a title-only edit would otherwise reset
 * the brief and turn the AI label off.)
 */
export const piecePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  brief: z.string().max(10_000).optional(),
  campaignId: z.string().uuid().nullish(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  aiGenerated: z.boolean().optional(),
  source: pieceSource.nullish(),
});

export const variantInput = z.object({
  format: z.enum(FORMATS),
  style: z.string().trim().max(80).default(''),
});

/** Recomputes the piece's review state from the latest live version of each variant. */
export async function refreshPieceState(db: Queryable, pieceId: string): Promise<string> {
  const piece = await loadPiece(db, pieceId);
  const rows = await db.query<{ review_state: VersionState }>(
    `select distinct on (ver.variant_id) ver.review_state
     from variant v join version ver on ver.variant_id = v.id
     where v.piece_id = $1 order by ver.variant_id, ver.number desc`,
    [pieceId],
  );
  const state = derivePieceState(!!piece.discarded_at, rows.map((r) => r.review_state));
  if (state !== piece.review_state) await db.query('update piece set review_state = $2 where id = $1', [pieceId, state]);
  return state;
}

async function assertCampaign(db: Queryable, brandId: string, campaignId: string | null | undefined) {
  if (!campaignId) return;
  const c = await db.one('select 1 from campaign where id = $1 and brand_id = $2', [campaignId, brandId]);
  if (!c) throw badRequest('invalid_campaign', 'The campaign does not exist in this brand');
}

export async function createPiece(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = pieceInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'piece.create');
    await assertCampaign(db, brandId, input.campaignId);
    const a = actorCols(p);
    const piece = (await db.one(
      `insert into piece (brand_id, campaign_id, title, kind, brief, target_date, ai_generated, created_by_user, created_by_token, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [brandId, input.campaignId ?? null, input.title, input.kind, input.brief, input.targetDate ?? null, input.aiGenerated, a.user, a.token, input.source ?? null],
    ))!;
    await audit(db, p, brandId, 'piece.created', 'piece', piece.id, null, { title: input.title, kind: input.kind, source: piece.source });
    return piece;
  });
}

export async function listPieces(ctx: Ctx, p: Principal, brandId: string, f: { state?: string; q?: string }) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  const params: unknown[] = [brandId];
  let where = 'p.brand_id = $1';
  if (f.state) {
    params.push(f.state);
    where += ` and p.review_state = $${params.length}`;
  }
  if (f.q) {
    params.push(`%${f.q.replace(/[%_]/g, '\\$&')}%`);
    where += ` and p.title ilike $${params.length}`;
  }
  // Everything a card in the list shows, in this one query: the latest version of the first variant (the one the preview is
  // drawn from, see thumbs.latestVersionId) with its main file, who made the latest version anywhere, the campaign, and what is
  // scheduled or out on the networks.
  return ctx.db.query(
    `select p.*,
       cp.name as campaign_name,
       (select count(*)::int from variant v where v.piece_id = p.id) as variant_count,
       (select count(*)::int from comment c join version ver on ver.id = c.version_id join variant v on v.id = ver.variant_id
         where v.piece_id = p.id and c.parent_id is null and c.status = 'open' and ver.review_state in ('in_review','changes_requested','approved')) as open_comments,
       lv.latest_version,
       coalesce(la.by_agent, false) as latest_by_agent,
       coalesce(la.created_at, p.created_at) as updated_at,
       np.next_publication,
       coalesce(pn.networks, '{}') as networks,
       pn.last_published_at
     from piece p
     left join campaign cp on cp.id = p.campaign_id
     left join lateral (
       select json_build_object(
         'id', ver.id, 'number', ver.number, 'review_state', ver.review_state, 'created_at', ver.created_at,
         'by_agent', ver.author_token_id is not null,
         'author', case when ver.author_token_id is not null then t.name else coalesce(nullif(btrim(u.name), ''), split_part(u.email, '@', 1)) end,
         'format', v.format,
         'media', m.kind, 'files', m.files, 'duration_ms', m.duration_ms
       ) as latest_version
       from variant v
       join version ver on ver.variant_id = v.id
       left join app_user u on u.id = ver.author_user_id
       left join api_token t on t.id = ver.author_token_id
       cross join lateral (
         select (array_agg(a.kind order by a.position, a.kind))[1] as kind, count(*)::int as files,
                (array_agg(a.duration_ms order by a.position) filter (where a.kind = 'video'))[1] as duration_ms
         from asset a where a.version_id = ver.id and a.kind in ('video','image','pdf')
       ) m
       where v.piece_id = p.id
       order by v.created_at, ver.number desc limit 1
     ) lv on true
     left join lateral (
       select ver.author_token_id is not null as by_agent, ver.created_at
       from version ver join variant v on v.id = ver.variant_id
       where v.piece_id = p.id order by ver.created_at desc limit 1
     ) la on true
     left join lateral (
       select json_build_object('scheduled_at', pub.scheduled_at, 'network', sa.network, 'status', pub.status) as next_publication
       from publication pub join variant v on v.id = pub.variant_id join social_account sa on sa.id = pub.social_account_id
       where v.piece_id = p.id and pub.status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing')
       order by pub.scheduled_at limit 1
     ) np on true
     left join lateral (
       select array_agg(distinct sa.network order by sa.network) as networks,
              max(coalesce(pub.published_at, pub.scheduled_at)) filter (where pub.status = 'published') as last_published_at
       from publication pub join variant v on v.id = pub.variant_id join social_account sa on sa.id = pub.social_account_id
       where v.piece_id = p.id and pub.status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing','published')
     ) pn on true
     where ${where}
     order by (p.review_state = 'discarded'), p.created_at desc limit 200`,
    params,
  );
}

export async function getPiece(ctx: Ctx, p: Principal, pieceId: string) {
  const piece = await loadPiece(ctx.db, pieceId);
  await authorize(ctx.db, p, piece.brand_id, 'brand.view');
  const variants = await ctx.db.query(
    `select v.*,
       (select coalesce(json_agg(json_build_object(
          'id', ver.id, 'number', ver.number, 'review_state', ver.review_state, 'created_at', ver.created_at,
          'notes', ver.notes, 'fingerprint', ver.fingerprint,
          'author', coalesce(u.name, u.email, t.name), 'by_agent', (ver.author_token_id is not null),
          'open_comments', (select count(*)::int from comment c where c.version_id = ver.id and c.parent_id is null and c.status = 'open')
        ) order by ver.number), '[]'::json)
        from version ver
        left join app_user u on u.id = ver.author_user_id
        left join api_token t on t.id = ver.author_token_id
        where ver.variant_id = v.id) as versions
     from variant v where v.piece_id = $1 order by v.created_at`,
    [pieceId],
  );
  const publications = await ctx.db.query(
    `select pub.id, pub.variant_id, pub.social_account_id, pub.version_id, pub.status, pub.scheduled_at, pub.text, pub.first_comment, pub.hold_reason,
       pub.url, pub.manual, pub.visibility, pub.placement, pub.native_scheduled, pub.last_error, pub.last_error_class, pub.published_at,
       sa.network, sa.display_name as account_name, ver.number as version_number
     from publication pub
     join variant v on v.id = pub.variant_id
     join social_account sa on sa.id = pub.social_account_id
     join version ver on ver.id = pub.version_id
     where v.piece_id = $1 order by pub.scheduled_at`,
    [pieceId],
  );
  return { ...piece, variants, publications };
}

/**
 * Edits a piece. What goes to a network with the files (the title, the AI label) is taken from the approval, so an edit after it
 * changes nothing that is already approved; and taking the AI label away once a version has been approved is for approvers only:
 * a producer, person or token, can add the label but never remove it.
 */
export async function updatePiece(ctx: Ctx, p: Principal, pieceId: string, raw: unknown) {
  const input = piecePatch.parse(raw);
  return ctx.db.tx(async (db) => {
    const before = await loadPiece(db, pieceId, true);
    const role = await authorize(db, p, before.brand_id, 'piece.create');
    if (input.campaignId !== undefined) await assertCampaign(db, before.brand_id, input.campaignId);
    if (input.aiGenerated === false && before.ai_generated && !(p.kind === 'user' && can(role, 'version.approve'))) {
      const approved = await db.one(
        `select 1 from approval a join version ver on ver.id = a.version_id join variant v on v.id = ver.variant_id
         where v.piece_id = $1 and a.decision = 'approve' limit 1`,
        [pieceId],
      );
      if (approved) throw forbidden('This piece was approved as made with AI: only an approver can take that label away');
    }
    const after = (await db.one(
      `update piece set title = coalesce($2, title), brief = coalesce($3, brief),
         campaign_id = case when $4::boolean then $5 else campaign_id end,
         target_date = case when $6::boolean then $7 else target_date end,
         ai_generated = coalesce($8, ai_generated),
         source = case when $9::boolean then $10 else source end
       where id = $1 returning *`,
      [
        pieceId,
        input.title ?? null,
        input.brief ?? null,
        input.campaignId !== undefined,
        input.campaignId ?? null,
        input.targetDate !== undefined,
        input.targetDate ?? null,
        input.aiGenerated ?? null,
        input.source !== undefined,
        input.source ?? null,
      ],
    ))!;
    await audit(db, p, before.brand_id, 'piece.updated', 'piece', pieceId,
      { title: before.title, brief: before.brief, target_date: before.target_date, ai_generated: before.ai_generated, source: before.source },
      { title: after.title, brief: after.brief, target_date: after.target_date, ai_generated: after.ai_generated, source: after.source });
    return after;
  });
}

export async function addVariant(ctx: Ctx, p: Principal, pieceId: string, raw: unknown) {
  const input = variantInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const piece = await loadPiece(db, pieceId, true);
    await authorize(db, p, piece.brand_id, 'version.upload');
    if (piece.discarded_at) throw conflict('piece_discarded', 'The piece is discarded');
    const exists = await db.one('select 1 from variant where piece_id = $1 and format = $2 and style = $3', [pieceId, input.format, input.style]);
    if (exists) throw conflict('variant_exists', 'A variant with that format and style already exists');
    const v = (await db.one('insert into variant (piece_id, format, style) values ($1,$2,$3) returning *', [pieceId, input.format, input.style]))!;
    await audit(db, p, piece.brand_id, 'variant.created', 'variant', v.id, null, input);
    return v;
  });
}

/**
 * Discarding is allowed from any state: the piece stops being live and anything scheduled is cancelled. Cancelling what is scheduled
 * is an approver's decision, so once a version is approved or something is scheduled, a producer (a person or a token) can no longer
 * discard the piece: an approver has to.
 */
export async function discardPiece(ctx: Ctx, p: Principal, pieceId: string) {
  return ctx.db.tx(async (db) => {
    const piece = await loadPiece(db, pieceId, true);
    const role = await authorize(db, p, piece.brand_id, 'piece.discard');
    if (piece.discarded_at) return piece;
    if (!(p.kind === 'user' && can(role, 'publication.schedule'))) {
      const committed = await db.one(
        `select 1 from variant v where v.piece_id = $1 and (
           exists (select 1 from version ver where ver.variant_id = v.id and ver.review_state = 'approved')
           or exists (select 1 from publication pub where pub.variant_id = v.id
                        and pub.status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing')))
         limit 1`,
        [pieceId],
      );
      if (committed) throw forbidden('This piece has an approved version or something scheduled: an approver has to discard it');
    }
    await db.query(
      `update version set review_state = 'discarded'
       where variant_id in (select id from variant where piece_id = $1) and review_state in ('in_review','changes_requested','approved')`,
      [pieceId],
    );
    await db.query(
      `update publication set status = 'cancelled', updated_at = now(), next_run_at = case when native_scheduled or held_on_network then $2::timestamptz else null end
       where variant_id in (select id from variant where piece_id = $1) and status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready')`,
      [pieceId, ctx.now()],
    );
    await db.query('update piece set discarded_at = now() where id = $1', [pieceId]);
    await refreshPieceState(db, pieceId);
    await audit(db, p, piece.brand_id, 'piece.discarded', 'piece', pieceId, { review_state: piece.review_state }, { review_state: 'discarded' });
    return loadPiece(db, pieceId);
  });
}

export async function requireLiveVariant(db: Queryable, variantId: string) {
  const v = await loadVariant(db, variantId);
  if (v.piece_discarded) throw conflict('piece_discarded', 'The piece is discarded');
  return v;
}

export { notFound };
