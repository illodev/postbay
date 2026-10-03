import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DateTime } from 'luxon';
import { z, ZodError } from 'zod';
import { authorize } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Anchor } from '../domain/anchors.js';
import { zonedInstant } from '../domain/time.js';
import { AppError, badRequest } from '../errors.js';
import { msg, render, renderStored, withLocale, type Locale } from '../i18n/index.js';
import * as approvals from '../services/approvals.js';
import * as brandSvc from '../services/brand.js';
import * as comments from '../services/comments.js';
import { loadBrand, loadVersion, rulesOf } from '../services/loaders.js';
import { describeNotification } from '../services/notify.js';
import * as overview from '../services/overview.js';
import * as pieces from '../services/pieces.js';
import * as pubs from '../services/publications.js';
import * as versions from '../services/versions.js';
import type { McpCaller } from './oauth.js';
import { mcpOf } from './settings.js';

/**
 * The tools an assistant sees. Each one calls the same service the web calls, as the person (with `via` naming the assistant), so the
 * person's role in each brand decides what works, through the same `authorize` checks; nothing here grants anything of its own. The one
 * thing added is a gate the web does not need: approving and requesting changes from an assistant is a per-brand setting, and needs the
 * assistant to say back what is being decided on.
 */

const VERSION = '1.0.0';

const INSTRUCTIONS = `Postbay is a content studio: producers (people or an AI agent) upload versions of pieces (videos, carousels, posts, stories, PDFs), the team reviews and comments on them, approvers approve a version for specific social accounts, and approved versions are scheduled on the calendar and published.

You act as the signed-in person, with their role in each brand. Rules that always hold:
- Nothing is published without a person's approval of that exact version. You can only schedule a version that is already approved, on an account it was approved for.
- Approving or requesting changes from here is allowed only where a brand admin has enabled it, and only for people whose role can already do it. Before calling approve_version or request_changes, show the person the piece, the version number and its fingerprint (first 12 characters, as the web shows it), get their explicit go-ahead, and pass those values back in "confirm".
- Times are in each brand's own time zone unless you give an ISO time with an offset. Say times to the person in the brand's zone.
- Ids come from earlier results: list_pieces or pending_for_me → get_piece → versions and comments. Every result has a "url" to open the same thing in the web app; share it when useful.`;

type Out = Record<string, unknown>;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const shortFp = (fp: string | null | undefined) => (fp ? fp.slice(0, 12) : null);
const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);

/** A moment of a video as people say it: 0:07, 1:02.5. */
function tc(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const tenths = Math.round((rest - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`;
}

/** Where a comment points, in words a model can repeat to a person. */
export function describeAnchor(a: Anchor | null | undefined): string {
  if (!a) return 'general comment on the whole version';
  const drawing = a.drawing?.length ? `, with a drawing (${a.drawing.map((s) => (s.type === 'rect' ? 'rectangle' : s.type === 'arrow' ? 'arrow' : 'freehand stroke') + ` in ${s.color}`).join(', ')})` : '';
  if (a.type === 'time') {
    const which = a.position ? ` of video ${a.position + 1} in the carousel` : '';
    const when = a.t_end !== undefined && a.t_end > a.t ? `from ${tc(a.t)} to ${tc(a.t_end)}` : `at ${tc(a.t)}`;
    const cue = a.cue !== undefined ? ` (subtitle line ${a.cue + 1}${a.cue_text ? `: "${a.cue_text.slice(0, 120)}"` : ''})` : '';
    return `${when}${which}${cue}${drawing}`;
  }
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (a.x === 0 && a.y === 0 && a.w >= 0.999 && a.h >= 0.999) return `page ${a.page} (the whole page)${drawing}`;
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const zone = `${cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle'}-${cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'}`;
  if (a.w === 0 && a.h === 0) return `page ${a.page}, a point in the ${zone} (${pct(a.x)} from the left, ${pct(a.y)} from the top)${drawing}`;
  return `page ${a.page}, an area in the ${zone} (from ${pct(a.x)} to ${pct(a.x + a.w)} across, ${pct(a.y)} to ${pct(a.y + a.h)} down)${drawing}`;
}

/** Builds the server for one request: the caller's tools, bound to them. */
export function buildMcpServer(ctx: Ctx, caller: McpCaller, locale: Locale): McpServer {
  const p = caller.principal;
  const base = ctx.config.APP_URL.replace(/\/+$/, '');
  const link = {
    piece: (id: string) => `${base}/pieces/${id}`,
    review: (id: string) => `${base}/review/${id}`,
    calendar: `${base}/calendar`,
    settings: (tab: string) => `${base}/settings?tab=${tab}`,
  };
  const local = (d: Date | string | null | undefined, zone: string) =>
    d ? DateTime.fromJSDate(new Date(d), { zone }).setLocale('en').toFormat('ccc yyyy-LL-dd HH:mm') : null;

  const server = new McpServer({ name: 'postbay', title: 'Postbay', version: VERSION }, { instructions: INSTRUCTIONS });

  /** Runs a tool as the person, in their language, and turns what the services say into a result or an error a model can read. */
  const run = <A,>(fn: (args: A) => Promise<Out>) => async (args: A): Promise<CallToolResult> => {
    try {
      const out = await withLocale(locale, () => fn(args));
      renderStored(locale, out);
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    } catch (err) {
      let error: { code: string; message: string; details?: unknown };
      if (err instanceof AppError) {
        error = { code: err.code, message: err.text ? render(locale, err.text, err.message) : err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
      } else if (err instanceof ZodError) {
        error = { code: 'validation_error', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
      } else if ((err as { code?: string }).code === '22P02') {
        error = { code: 'not_found', message: 'Not found: check the id' };
      } else {
        ctx.log.error({ err: String(err), stack: (err as Error)?.stack }, 'mcp tool failed');
        error = { code: 'internal', message: 'Something went wrong on the server' };
      }
      if (error.details && typeof error.details === 'object') renderStored(locale, error.details);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
    }
  };

  /** The brands this assistant may use and the person is still active in, with their role. */
  const myBrands = () =>
    ctx.db.query<{ id: string; name: string; timezone: string; paused: boolean; role: string; workspace: string; approval_rules: unknown; mcp: unknown; locale: string }>(
      `select b.id, b.name, b.timezone, b.paused, m.role, w.name as workspace, b.approval_rules, b.mcp, b.locale
       from member m join brand b on b.id = m.brand_id join workspace w on w.id = b.workspace_id
       where m.user_id = $1 and m.deactivated_at is null and b.id = any($2) order by w.name, b.name`,
      [p.userId, p.via.brandIds],
    );

  /**
   * The brand a tool works on: the one named (by id or name), or the only one. An id is passed on as it is, so a brand the person was
   * deactivated in answers as the web does (`member_deactivated`).
   */
  const brandOf = async (named?: string) => {
    const all = await myBrands();
    if (named && /^[0-9a-f-]{36}$/i.test(named)) {
      const role = await authorize(ctx.db, p, named, 'brand.view');
      const b = await loadBrand(ctx.db, named);
      return { id: b.id as string, name: b.name as string, timezone: b.timezone as string, role };
    }
    if (named) {
      const wanted = named.trim().toLowerCase();
      const found = all.find((b) => b.name.toLowerCase() === wanted) ?? (all.filter((b) => b.name.toLowerCase().includes(wanted)).length === 1 ? all.find((b) => b.name.toLowerCase().includes(wanted)) : undefined);
      if (!found) throw new AppError(404, 'unknown_brand', msg('mcp.unknownBrand', { brand: named, brands: all.map((b) => b.name).join(', ') || '—' }));
      return { id: found.id, name: found.name, timezone: found.timezone, role: found.role };
    }
    if (all.length === 1) return { id: all[0]!.id, name: all[0]!.name, timezone: all[0]!.timezone, role: all[0]!.role };
    if (all.length === 0) throw new AppError(403, 'no_brands', msg('mcp.noBrands'));
    throw new AppError(400, 'brand_required', msg('mcp.brandRequired', { brands: all.map((b) => b.name).join(', ') }));
  };

  const zoneOf = async (brandId: string) => (await loadBrand(ctx.db, brandId)).timezone as string;

  /** A time the person said: brand-local "2026-10-06T19:00" (or with a space), or an ISO instant with its zone. */
  const when = (at: string, zone: string): string => {
    const s = at.trim();
    const localForm = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(s);
    if (localForm) {
      try {
        return zonedInstant(localForm[1]!, localForm[2]!, zone).toISOString();
      } catch { /* falls through to the refusal */ }
    }
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
    throw badRequest('bad_time', msg('mcp.badTime', { at }));
  };

  const brandParam = z.string().max(200).optional().describe('Brand name or id. Leave it out when the person has only one brand here.');
  const uuid = (what: string) => z.string().uuid().describe(what);
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  // ───────────────────────────── reading ─────────────────────────────

  server.registerTool('list_brands', {
    title: 'List brands',
    description: 'The brands this connection can use, with the person\'s role in each, the time zone, whether it is paused, its approval rules (how many approvals, the checklist an approver must confirm), whether approving from an assistant is enabled there, and the styles a variant can have (variant_styles, in the order people pick from).',
    inputSchema: {},
    annotations: read,
  }, run(async () => {
    const all = await myBrands();
    return {
      brands: all.map((b) => {
        const rules = rulesOf(b);
        return {
          id: b.id, name: b.name, workspace: b.workspace, role: b.role, timezone: b.timezone, paused: b.paused,
          approval: { required_approvals: rules.required_approvals, checklist: rules.checklist, assistant_can_approve: mcpOf(b).allow_approval },
          variant_styles: rules.variant_styles,
        };
      }),
    };
  }));

  server.registerTool('list_pieces', {
    title: 'List pieces',
    description: 'Pieces of a brand, newest first. Filter by state (draft, in_review, changes_requested, approved, discarded), campaign (name or id), whether the latest version was made by the AI agent, or words in the title. Each piece has its latest version and what is scheduled.',
    inputSchema: {
      brand: brandParam,
      state: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'discarded']).optional(),
      campaign: z.string().max(200).optional().describe('Campaign name or id'),
      by_agent: z.boolean().optional().describe('true: only pieces whose latest version the AI agent uploaded; false: only those a person uploaded'),
      search: z.string().max(200).optional().describe('Words in the title'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: read,
  }, run(async (a) => {
    const brand = await brandOf(a.brand);
    let campaignId: string | undefined;
    if (a.campaign) {
      const list = (await brandSvc.listCampaigns(ctx, p, brand.id)) as { id: string; name: string }[];
      const c = list.find((x) => x.id === a.campaign || x.name.toLowerCase() === a.campaign!.trim().toLowerCase());
      if (!c) throw badRequest('unknown_campaign', msg('mcp.unknownCampaign', { campaign: a.campaign }));
      campaignId = c.id;
    }
    const rows = await pieces.listPieces(ctx, p, brand.id, { state: a.state, q: a.search, campaignId, byAgent: a.by_agent });
    return {
      brand: brand.name, total: rows.length,
      pieces: rows.slice(0, a.limit).map((r) => ({
        id: r.id, title: r.title, kind: r.kind, state: r.review_state, campaign: r.campaign_name, target_date: r.target_date, ai_generated: r.ai_generated,
        open_comments: r.open_comments,
        latest_version: r.latest_version ? {
          id: r.latest_version.id, number: r.latest_version.number, state: r.latest_version.review_state, format: r.latest_version.format,
          by_agent: r.latest_version.by_agent, author: r.latest_version.author, uploaded_at: r.latest_version.created_at,
        } : null,
        next_publication: r.next_publication ? { ...r.next_publication, at_local: local(r.next_publication.scheduled_at, brand.timezone) } : null,
        networks: r.networks, url: link.piece(r.id),
      })),
    };
  }));

  server.registerTool('get_piece', {
    title: 'Get a piece',
    description: 'A piece with its variants (formats), every version of each (number, state, fingerprint, open comments), and its publications (scheduled, published, failed or on hold).',
    inputSchema: { piece_id: uuid('The piece id') },
    annotations: read,
  }, run(async (a) => {
    const piece: Record<string, any> = await pieces.getPiece(ctx, p, a.piece_id);
    await pubs.attachKeptTexts(ctx.db, piece.publications as { id: string }[]);
    const zone = await zoneOf(piece.brand_id);
    return {
      id: piece.id, title: piece.title, kind: piece.kind, state: piece.review_state, brief: piece.brief, target_date: piece.target_date,
      ai_generated: piece.ai_generated, discarded: !!piece.discarded_at, url: link.piece(piece.id),
      slot: piece.slot ? { label: piece.slot.label, at_local: local(piece.slot.at, zone), removed: piece.slot.removed } : null,
      variants: (piece.variants as Out[]).map((v) => {
        const list = (v.versions as Out[]) ?? [];
        return {
          id: v.id, format: v.format, style: v.style || null,
          versions: list.map((x) => ({
            id: x.id, number: x.number, state: x.review_state, fingerprint: shortFp(x.fingerprint as string), uploaded_at: x.created_at,
            author: x.author, by_agent: x.by_agent, notes: x.notes || null, open_comments: x.open_comments, url: link.review(x.id as string),
          })),
        };
      }),
      publications: (piece.publications as Out[]).map((x) => ({
        id: x.id, status: x.status, network: x.network, account: x.account_name, account_id: x.social_account_id, version_number: x.version_number,
        at: iso(x.scheduled_at as string), at_local: local(x.scheduled_at as string, zone), by_a_person: x.manual, post_url: x.url,
        hold_reason: x.hold_reason, hold_reason_i18n: x.hold_reason_i18n, last_error: x.last_error, last_error_i18n: x.last_error_i18n,
        scheduled_by: x.scheduled_by, scheduled_by_name: x.scheduled_by_name,
      })),
      timezone: zone,
    };
  }));

  server.registerTool('get_version', {
    title: 'Get a version',
    description: 'One version of a piece: its files, fingerprint, who uploaded it, the decisions taken on it, the brand\'s approval rules (checklist), the accounts it could be approved for, and what approving it would schedule. Use it before approving.',
    inputSchema: { version_id: uuid('The version id') },
    annotations: read,
  }, run(async (a) => {
    const v = await versions.getVersion(ctx, p, a.version_id);
    const version = await loadVersion(ctx.db, a.version_id);
    const brand = await loadBrand(ctx.db, version.brand_id);
    const rules = rulesOf(brand);
    const accounts = (await brandSvc.listAccounts(ctx, p, version.brand_id)) as Out[];
    const open = (await comments.listComments(ctx, p, a.version_id, { status: 'open', carried: true })).length;
    return {
      id: v.id, number: v.number, state: v.review_state, fingerprint: shortFp(v.fingerprint), fingerprint_full: v.fingerprint,
      piece: { id: v.piece?.id, title: v.piece?.title, kind: v.piece?.kind, ai_generated: v.piece?.ai_generated },
      variant: { id: v.variant.id, format: v.variant.format, style: v.variant.style || null },
      uploaded_at: v.created_at, author: v.author, by_agent: v.by_agent, notes: v.notes || null,
      files: v.assets.map((f) => ({ kind: f.kind, position: f.position, name: f.name, mime: f.mime, width: f.width, height: f.height, duration_seconds: seconds(f.duration_ms), bytes: f.bytes })),
      open_comments: open,
      decisions: v.approvals.map((x: Out) => ({ by: x.approver, decision: x.decision, note: x.note || null, at: x.created_at, still_counts: x.matches_fingerprint })),
      approval_rules: { required_approvals: rules.required_approvals, checklist: rules.checklist, assistant_can_approve: mcpOf(brand).allow_approval },
      accounts: accounts.map((x) => ({ id: x.id, network: x.network, name: x.display_name, status: x.status })),
      on_approval: v.slot_schedule ? { summary: v.slot_schedule.summary, ready: v.slot_schedule.ready, code: v.slot_schedule.code, reason: v.slot_schedule.reason, reason_i18n: v.slot_schedule.reason_i18n } : null,
      other_versions: v.versions.map((x: { id: string; number: number }) => ({ id: x.id, number: x.number })),
      url: link.review(v.id),
    };
  }));

  server.registerTool('pending_for_me', {
    title: 'What is pending for me',
    description: 'What waits for the person in a brand: versions awaiting their decision (for approvers: not their own uploads and not already decided; for reviewers: everything in review), open comments on their own uploads and replies to their comments, and publications that failed, are on hold or wait for a confirmation, plus other things that need a hand.',
    inputSchema: { brand: brandParam },
    annotations: read,
  }, run(async (a) => {
    const brand = await brandOf(a.brand);
    const o = await overview.brandOverview(ctx, p, brand.id);
    const forMe = await ctx.db.query(
      `select c.id, c.parent_id, c.body, c.anchor, c.created_at, ver.id as version_id, ver.number as version_number, p.id as piece_id, p.title as piece_title,
         coalesce(u.name, u.email, t.name) as author, (c.author_token_id is not null) as by_agent,
         case when c.parent_id is null then 'on_your_upload' else 'reply_to_your_comment' end as why
       from comment c
       join version ver on ver.id = c.version_id join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
       left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
       left join comment parent on parent.id = c.parent_id
       where p.brand_id = $1 and p.discarded_at is null and c.author_user_id is distinct from $2
         and ((c.parent_id is null and c.status = 'open' and (ver.author_user_id = $2 or p.created_by_user = $2))
           or (c.parent_id is not null and parent.author_user_id = $2 and parent.status = 'open' and c.created_at > now() - interval '14 days'))
       order by c.created_at desc limit 40`,
      [brand.id, p.userId],
    );
    return {
      brand: brand.name, your_role: o.role, timezone: o.timezone,
      awaiting_your_decision: o.awaiting_mode === 'view' ? [] : o.awaiting.map((x) => ({
        version_id: x.version_id, version_number: x.version_number, piece_id: x.piece_id, piece_title: x.piece_title, format: x.variant_format,
        author: x.author, by_agent: x.by_agent, uploaded_at: x.created_at, open_comments: x.open_comments, url: link.review(x.version_id),
      })),
      what_you_can_do_with_them: o.awaiting_mode,
      comments_for_you: forMe.map((c) => ({
        id: c.id, thread_id: c.parent_id ?? c.id, why: c.why, text: c.body, where: c.parent_id ? null : describeAnchor(c.anchor), author: c.author, by_agent: c.by_agent,
        at: c.created_at, piece_id: c.piece_id, piece_title: c.piece_title, version_id: c.version_id, version_number: c.version_number, url: link.review(c.version_id),
      })),
      needs_attention: o.attention.map((x) => ({
        kind: x.kind, reason: x.reason, detail: x.detail, detail_i18n: x.detail_i18n, piece_id: x.piece_id, piece_title: x.piece_title,
        network: x.network, account: x.account_name, at_local: local(x.scheduled_at, o.timezone), id: x.id,
        url: x.piece_id ? link.piece(x.piece_id) : x.kind === 'account_reconnect' ? link.settings('accounts') : x.kind === 'webhook_failing' ? link.settings('webhooks') : null,
      })),
    };
  }));

  server.registerTool('list_comments', {
    title: 'Comments of a version',
    description: 'The comment threads of a version, with replies, including threads still open from earlier versions of the same variant. Each says where it points, in words (a moment or span of the video, a subtitle line, a page or area of an image or PDF).',
    inputSchema: {
      version_id: uuid('The version id'),
      status: z.enum(['open', 'resolved', 'all']).default('all'),
    },
    annotations: read,
  }, run(async (a) => {
    const rows = await comments.listComments(ctx, p, a.version_id, { status: a.status === 'all' ? undefined : a.status, carried: true });
    return {
      version_id: a.version_id, url: link.review(a.version_id),
      threads: rows.map((c) => ({
        id: c.id, status: c.status, where: describeAnchor(c.anchor as Anchor | null), text: c.body, author: c.author, at: c.created_at,
        on_version: c.version_number, carried_from_earlier_version: c.carried, people_only: c.people_only,
        resolved_by: c.resolved_by, resolved_in_version: c.resolved_in_number,
        replies: (c.replies as Out[]).map((r) => ({ id: r.id, text: r.body, author: r.author, by_agent: r.by_agent, at: r.created_at, kind: r.reply_kind })),
      })),
    };
  }));

  server.registerTool('calendar', {
    title: 'Calendar',
    description: 'What is planned between two dates (inclusive, in the brand\'s time zone): publications with their state, the weekly slots still free, and blocked days. Defaults to the next 14 days.',
    inputSchema: {
      brand: brandParam,
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, at most 62 days after from'),
    },
    annotations: read,
  }, run(async (a) => {
    const brand = await brandOf(a.brand);
    const today = DateTime.fromJSDate(ctx.now(), { zone: brand.timezone });
    const from = a.from ?? today.toISODate()!;
    const to = a.to ?? DateTime.fromISO(from, { zone: brand.timezone }).plus({ days: 13 }).toISODate()!;
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 62) throw badRequest('invalid_range', 'At most 62 days at a time');
    const cal = await pubs.calendar(ctx, p, brand.id, from, to);
    return {
      brand: brand.name, timezone: cal.timezone, paused: cal.paused, from, to, url: link.calendar,
      publications: (cal.publications as Out[]).map((x) => ({
        id: x.id, status: x.status, at: iso(x.scheduled_at as string), at_local: local(x.scheduled_at as string, cal.timezone), network: x.network, account: x.account_name,
        account_id: x.account_id, piece_id: x.piece_id, piece_title: x.piece_title, version_number: x.version_number, by_a_person: x.manual,
        scheduled_by: x.scheduled_by, scheduled_by_name: x.scheduled_by_name, hold_reason: x.hold_reason, hold_reason_i18n: x.hold_reason_i18n,
        last_error: x.last_error, last_error_i18n: x.last_error_i18n, post_url: x.url,
      })),
      free_slots: cal.slots.filter((s) => !s.filled && !s.past && !s.blocked).map((s) => ({
        slot_id: s.id, label: s.label || null, at: s.at, at_local: local(s.at, cal.timezone), network: s.network, account: s.account_name, account_id: s.account_id,
      })),
      blocked_days: cal.blocked.map((b) => ({ day: b.day, reason: b.reason || null })),
    };
  }));

  server.registerTool('list_accounts', {
    title: 'Social accounts',
    description: 'The social accounts of a brand: network, name, whether Postbay publishes to it by itself or a person posts by hand, and whether it needs reconnecting.',
    inputSchema: { brand: brandParam },
    annotations: read,
  }, run(async (a) => {
    const brand = await brandOf(a.brand);
    const rows = (await brandSvc.listAccounts(ctx, p, brand.id)) as Out[];
    return { brand: brand.name, accounts: rows.map((x) => ({ id: x.id, network: x.network, name: x.display_name, status: x.status, publishes_by_itself: x.automated })) };
  }));

  server.registerTool('list_notifications', {
    title: 'Notifications',
    description: 'The person\'s latest notifications in the brands this connection can use (what they would see under the bell in the web app).',
    inputSchema: {
      unread_only: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: read,
  }, run(async (a) => {
    const rows = await ctx.db.query(
      `select n.id, n.kind, n.payload, n.read_at, n.created_at, b.name as brand, pc.title as piece_title
       from notification n join brand b on b.id = n.brand_id
       left join piece pc on pc.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.user_id = $1 and n.brand_id = any($2) and ($3::boolean is false or n.read_at is null)
         and exists (select 1 from member m where m.user_id = n.user_id and m.brand_id = n.brand_id and m.deactivated_at is null)
       order by n.created_at desc limit $4`,
      [p.userId, p.via.brandIds, a.unread_only, a.limit],
    );
    return {
      notifications: rows.map((n) => {
        const d = describeNotification(locale, base, n.kind, n.payload ?? {}, n.brand, n.piece_title);
        return { id: n.id, kind: n.kind, brand: n.brand, subject: d.subject, text: d.body || null, piece_title: n.piece_title, at: n.created_at, read: !!n.read_at, url: d.url };
      }),
    };
  }));

  // ───────────────────────────── comments ─────────────────────────────

  server.registerTool('add_comment', {
    title: 'Comment on a version',
    description: 'Adds a comment to a version, as the person. Point it at a moment of the video (at_seconds, optionally until_seconds for a span), at a page of a carousel, image or PDF (page, optionally x/y and width/height as fractions 0–1 of the page from its top-left corner), or leave both out for a general comment.',
    inputSchema: {
      version_id: uuid('The version id'),
      text: z.string().trim().min(1).max(5000),
      at_seconds: z.number().min(0).optional().describe('A moment of the video, in seconds'),
      until_seconds: z.number().min(0).optional().describe('End of the span, in seconds'),
      video_number: z.number().int().min(1).optional().describe('In a carousel with several videos: which one (1 = the first)'),
      page: z.number().int().min(1).optional().describe('Page or carousel item, from 1'),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      width: z.number().min(0).max(1).optional(),
      height: z.number().min(0).max(1).optional(),
      people_only: z.boolean().default(false).describe('Mark it as for people only: the AI agent will leave it alone'),
    },
    annotations: write,
  }, run(async (a) => {
    if (a.at_seconds !== undefined && a.page !== undefined) throw badRequest('invalid_anchor', 'Give either a moment of the video or a page, not both');
    let anchor: Anchor | null = null;
    if (a.at_seconds !== undefined) {
      anchor = { type: 'time', t: a.at_seconds, ...(a.until_seconds !== undefined ? { t_end: a.until_seconds } : {}), ...(a.video_number ? { position: a.video_number - 1 } : {}) } as Anchor;
    } else if (a.page !== undefined) {
      const point = a.x !== undefined || a.y !== undefined;
      anchor = point
        ? { type: 'region', page: a.page, x: a.x ?? 0, y: a.y ?? 0, w: a.width ?? 0, h: a.height ?? 0 }
        : { type: 'region', page: a.page, x: 0, y: 0, w: 1, h: 1 };
    }
    const row = await comments.createComment(ctx, p, a.version_id, { body: a.text, anchor, peopleOnly: a.people_only });
    return { id: row.id, version_id: a.version_id, where: describeAnchor(row.anchor as Anchor | null), people_only: row.people_only, url: link.review(a.version_id) };
  }));

  server.registerTool('reply_to_comment', {
    title: 'Reply to a comment',
    description: 'Replies to a comment thread, as the person. Use the thread\'s id (the top comment).',
    inputSchema: { comment_id: uuid('The thread (top comment) id'), text: z.string().trim().min(1).max(5000) },
    annotations: write,
  }, run(async (a) => {
    const row = await comments.replyToComment(ctx, p, a.comment_id, { body: a.text });
    return { id: row.id, thread_id: a.comment_id, url: link.review(row.version_id) };
  }));

  server.registerTool('resolve_comment', {
    title: 'Resolve a comment',
    description: 'Marks a comment thread as resolved, as the person.',
    inputSchema: { comment_id: uuid('The thread (top comment) id') },
    annotations: { ...write, idempotentHint: true },
  }, run(async (a) => {
    const row = await comments.resolveComment(ctx, p, a.comment_id);
    return { id: row.id, status: row.status, url: link.review(row.version_id) };
  }));

  // ───────────────────────────── pieces and versions ─────────────────────────────

  server.registerTool('create_piece', {
    title: 'Create a piece',
    description: 'Creates a piece in a brand, as the person, optionally with its first variants (formats) so versions can be uploaded to them.',
    inputSchema: {
      brand: brandParam,
      title: z.string().trim().min(1).max(200),
      kind: z.enum(pieces.KINDS),
      brief: z.string().max(10_000).optional(),
      campaign: z.string().max(200).optional().describe('Campaign name or id'),
      target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      ai_generated: z.boolean().optional().describe('Whether the content is made with AI (it goes out labelled as such)'),
      formats: z.array(z.enum(pieces.FORMATS)).max(6).optional().describe('Variants to add right away, e.g. ["9:16", "1:1"]'),
    },
    annotations: write,
  }, run(async (a) => {
    const brand = await brandOf(a.brand);
    let campaignId: string | null = null;
    if (a.campaign) {
      const list = (await brandSvc.listCampaigns(ctx, p, brand.id)) as { id: string; name: string }[];
      const c = list.find((x) => x.id === a.campaign || x.name.toLowerCase() === a.campaign!.trim().toLowerCase());
      if (!c) throw badRequest('unknown_campaign', msg('mcp.unknownCampaign', { campaign: a.campaign }));
      campaignId = c.id;
    }
    const piece = await pieces.createPiece(ctx, p, brand.id, {
      title: a.title, kind: a.kind, brief: a.brief ?? '', campaignId, targetDate: a.target_date ?? null, aiGenerated: a.ai_generated ?? false,
    });
    const variants = [];
    for (const format of a.formats ?? []) variants.push(await pieces.addVariant(ctx, p, piece.id, { format }));
    return { id: piece.id, title: piece.title, kind: piece.kind, brand: brand.name, variants: variants.map((v) => ({ id: v.id, format: v.format })), url: link.piece(piece.id) };
  }));

  server.registerTool('add_variant', {
    title: 'Add a variant',
    description: 'Adds a variant (a format of the same piece: 9:16, 4:5, 1:1, 16:9, carousel or document) to a piece, as the person.',
    inputSchema: {
      piece_id: uuid('The piece id'),
      format: z.enum(pieces.FORMATS),
      style: z.string().trim().max(80).optional().describe('Optional: one of the brand\'s variant styles (list_brands → variant_styles), to tell two variants of the same format apart. Any other style is refused: a new one is added to the brand first, with the person\'s say-so (add_variant_style).'),
    },
    annotations: write,
  }, run(async (a) => {
    // As in the web's dialog, a style comes from the brand's list (written as the brand writes it); the agent's runner does the same.
    let style = '';
    if (a.style) {
      const row = await ctx.db.one<{ approval_rules: unknown }>('select b.approval_rules from piece pc join brand b on b.id = pc.brand_id where pc.id = $1', [a.piece_id]);
      const styles = row ? rulesOf(row).variant_styles : [];
      const match = styles.find((s) => s.toLocaleLowerCase() === a.style!.toLocaleLowerCase());
      if (row && !match) {
        throw styles.length
          ? badRequest('unknown_style', msg('mcp.style.unknown', { style: a.style, styles: styles.join(', ') }), { styles })
          : badRequest('unknown_style', msg('mcp.style.noneDefined', { style: a.style }), { styles });
      }
      style = match ?? a.style;
    }
    const v = await pieces.addVariant(ctx, p, a.piece_id, { format: a.format, style });
    return { id: v.id, piece_id: a.piece_id, format: v.format, style: v.style || null, url: link.piece(a.piece_id) };
  }));

  server.registerTool('add_variant_style', {
    title: 'Add a variant style to a brand',
    description: 'Adds a style ("Riso", "Collage"…) to the brand\'s list of variant styles, the list people pick a variant\'s style from. Admins only, as in Settings → General. Ask the person before adding one: it shows for the whole team.',
    inputSchema: {
      brand: brandParam,
      style: z.string().trim().min(1).max(40).describe('The style, as it should be written'),
      position: z.number().int().min(1).max(30).optional().describe('Where in the list (1 is first). At the end when left out.'),
    },
    annotations: write,
  }, run(async (a) => {
    const b = await brandOf(a.brand);
    const styles = rulesOf(await loadBrand(ctx.db, b.id)).variant_styles;
    const next = [...styles];
    next.splice(a.position ? a.position - 1 : next.length, 0, a.style);
    // The web's own save: admins only, no two alike whatever their case, at most 30, audited.
    const saved = await brandSvc.updateBrand(ctx, p, b.id, { rules: { variant_styles: next } });
    return { brand: b.name, variant_styles: saved.rules.variant_styles, url: link.settings('general') };
  }));

  server.registerTool('remove_variant_style', {
    title: 'Remove a variant style from a brand',
    description: 'Takes a style off the brand\'s list of variant styles. Variants that already have it keep it. Admins only. Ask the person first.',
    inputSchema: { brand: brandParam, style: z.string().trim().min(1).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, run(async (a) => {
    const b = await brandOf(a.brand);
    const styles = rulesOf(await loadBrand(ctx.db, b.id)).variant_styles;
    const next = styles.filter((s) => s.toLocaleLowerCase() !== a.style.toLocaleLowerCase());
    if (next.length === styles.length) throw badRequest('unknown_style', msg('mcp.style.notInList', { style: a.style, styles: styles.join(', ') || '—' }), { styles });
    const saved = await brandSvc.updateBrand(ctx, p, b.id, { rules: { variant_styles: next } });
    return { brand: b.name, variant_styles: saved.rules.variant_styles, url: link.settings('general') };
  }));

  server.registerTool('start_upload', {
    title: 'Start uploading a new version',
    description: `Step 1 of 2 to upload a new version of a variant. Declare each file with its exact size in bytes and its sha256 (hex), computed on the person's machine (for example "stat -c %s file" and "sha256sum file"). The answer has, per file, an upload_id and a signed URL: send the file's bytes with an HTTP PUT to that URL with exactly the headers given (for example: curl --fail -X PUT --data-binary @file -H "content-type: video/mp4" "<url>"). Storage refuses anything whose size or sha256 differs. URLs expire in an hour. Then call finish_upload. This needs a client that can read local files and make HTTP requests (such as Claude Code); a chat client without file access cannot upload. Accepted: video (mp4, mov, webm, mkv), images (jpeg, png, webp, gif), PDF, subtitles (vtt, srt), cover images; up to 4 GB each, 30 files.`,
    inputSchema: {
      variant_id: uuid('The variant id (get_piece lists them)'),
      files: z.array(z.object({
        name: z.string().trim().min(1).max(200).describe('File name, e.g. reel-v3.mp4'),
        mime: z.string().min(3).max(100).describe('e.g. video/mp4, image/jpeg, application/pdf, text/vtt'),
        bytes: z.number().int().positive().describe('Exact size in bytes'),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).describe('sha256 of the file, hex'),
      })).min(1).max(30),
    },
    annotations: write,
  }, run(async (a) => {
    const ups = await versions.requestUploads(ctx, p, a.variant_id, { files: a.files.map((f) => ({ ...f, resumable: false })) });
    return {
      variant_id: a.variant_id,
      uploads: (ups as Out[]).map((u) => ({ upload_id: u.uploadId, name: u.name, method: u.method, url: u.url, headers: u.headers, expires_in_seconds: 3600 })),
      next: 'PUT each file to its url with exactly its headers, then call finish_upload with every upload_id, the kind of each file (video, image, pdf, subtitles or cover) and its position (0 for a single file; 0, 1, 2… for carousel items).',
    };
  }));

  server.registerTool('finish_upload', {
    title: 'Finish uploading a new version',
    description: 'Step 2 of 2: closes the new version from the files sent with start_upload. Postbay re-reads each stored file and refuses any whose size or sha256 differs from what was declared. The new version goes to review, voids any previous approval of the variant and puts what was scheduled with it on hold. Optionally say which open comment threads it resolves.',
    inputSchema: {
      variant_id: uuid('The same variant id as in start_upload'),
      files: z.array(z.object({
        upload_id: z.string().uuid(),
        kind: z.enum(versions.ASSET_KINDS).describe('video, image, pdf, subtitles or cover'),
        position: z.number().int().min(0).max(100).default(0).describe('Order in a carousel, from 0'),
      })).min(1).max(30),
      notes: z.string().max(5000).optional().describe('What changed in this version'),
      resolves_comment_ids: z.array(z.string().uuid()).max(200).optional().describe('Open threads this version fixes'),
    },
    annotations: write,
  }, run(async (a) => {
    const v = await versions.closeVersion(ctx, p, a.variant_id, {
      files: a.files.map((f) => ({ uploadId: f.upload_id, kind: f.kind, position: f.position })), notes: a.notes ?? '', resolves: a.resolves_comment_ids ?? [],
    });
    return { id: v.id, number: v.number, state: v.review_state, fingerprint: shortFp(v.fingerprint), url: link.review(v.id) };
  }));

  // ───────────────────────────── the calendar ─────────────────────────────

  server.registerTool('schedule_publication', {
    title: 'Schedule an approved version',
    description: 'Puts an approved version on the calendar for one of the accounts it was approved for, as the person, through every check the web makes (approved for that account, files unchanged, not in the past, not on a blocked day, brand not paused, what the network accepts). Postbay publishes it by itself when the account is connected and the network allows, otherwise a person is reminded to post it. Use dry_run first to see how it would go out and any problem.',
    inputSchema: {
      version_id: uuid('An approved version'),
      account_id: uuid('The social account (list_accounts, or the accounts the version was approved for)'),
      at: z.string().max(40).describe('When: "YYYY-MM-DDTHH:mm" in the brand\'s time zone, or an ISO time with offset'),
      text: z.string().max(10_000).default('').describe('The caption'),
      first_comment: z.string().max(5000).default(''),
      mode: z.enum(['auto', 'manual']).optional().describe('auto: insist Postbay publishes it itself; manual: a person posts it. Leave out to let Postbay decide'),
      placement: z.string().max(40).optional().describe('Kind of post where the network has several (e.g. reel or feed); leave out to let Postbay pick'),
      options: z.record(z.string(), z.unknown()).optional().describe('Network settings the dry run asks for (e.g. TikTok privacy)'),
      dry_run: z.boolean().default(false).describe('Only check, without scheduling'),
    },
    annotations: write,
  }, run(async (a) => {
    const version = await loadVersion(ctx.db, a.version_id);
    const zone = await zoneOf(version.brand_id);
    const input = { accountId: a.account_id, scheduledAt: when(a.at, zone), text: a.text, firstComment: a.first_comment, options: a.options ?? {}, mode: a.mode, placement: a.placement };
    if (a.dry_run) {
      const plan = await pubs.validatePublication(ctx, p, a.version_id, input);
      return {
        dry_run: true, at: input.scheduledAt, at_local: local(input.scheduledAt, zone), timezone: zone,
        publishes_by_itself: plan.automated, why_a_person_posts: plan.manualReason ?? null, placement: plan.placement, placements: plan.placements,
        issues: plan.issues,
      };
    }
    const pub = await pubs.schedule(ctx, p, a.version_id, input);
    return {
      id: pub.id, status: pub.status, at: iso(pub.scheduled_at), at_local: local(pub.scheduled_at, zone), timezone: zone, publishes_by_itself: !pub.manual,
      why_a_person_posts: pub.manual_reason ?? null, issues: pub.issues ?? [], url: link.piece(version.piece_id),
    };
  }));

  server.registerTool('move_publication', {
    title: 'Move or edit a scheduled publication',
    description: 'Moves a scheduled publication to another time and/or changes its caption or first comment, as the person. Some brands then need a second person to confirm the change.',
    inputSchema: {
      publication_id: uuid('The publication id'),
      at: z.string().max(40).optional().describe('New time: "YYYY-MM-DDTHH:mm" in the brand\'s time zone, or an ISO time with offset'),
      text: z.string().max(10_000).optional(),
      first_comment: z.string().max(5000).optional(),
    },
    annotations: write,
  }, run(async (a) => {
    const owner = await ctx.db.one<{ brand_id: string; piece_id: string }>(
      'select p.brand_id, p.id as piece_id from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id where pub.id = $1', [a.publication_id],
    );
    const zone = owner ? await zoneOf(owner.brand_id) : 'UTC';
    const pub = await pubs.patchPublication(ctx, p, a.publication_id, {
      ...(a.at ? { scheduledAt: when(a.at, zone) } : {}), ...(a.text !== undefined ? { text: a.text } : {}), ...(a.first_comment !== undefined ? { firstComment: a.first_comment } : {}),
    });
    return { id: pub.id, status: pub.status, at: iso(pub.scheduled_at), at_local: local(pub.scheduled_at, zone), needs_confirmation: pub.status === 'awaiting_reapproval', url: owner ? link.piece(owner.piece_id) : null };
  }));

  server.registerTool('cancel_publication', {
    title: 'Cancel a publication',
    description: 'Cancels a publication that has not gone out yet, as the person. Whatever a network was already holding for it is taken down.',
    inputSchema: { publication_id: uuid('The publication id') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, run(async (a) => {
    const pub = await pubs.cancelPublication(ctx, p, a.publication_id);
    return { id: pub.id, status: pub.status };
  }));

  // ───────────────────────────── deciding (behind the brand's setting) ─────────────────────────────

  const confirmSchema = z.object({
    piece: z.string().trim().min(1).max(200).describe('The piece title (or its id), as you showed it to the person'),
    version_number: z.number().int().min(1),
    fingerprint: z.string().trim().min(12).max(64).describe('The version\'s fingerprint as the web shows it (at least its first 12 characters)'),
  }).describe('What the person confirmed, said back. Postbay checks it is this version.');

  /**
   * The assistant gate: the brand allows deciding from an assistant, and what the person confirmed is this very version. The role is
   * checked afterwards by the service itself (approve needs an approver; requesting changes, a reviewer), as in the web.
   */
  const gate = async (versionId: string, confirm: z.infer<typeof confirmSchema>) => {
    const version = await loadVersion(ctx.db, versionId);
    await authorize(ctx.db, p, version.brand_id, 'brand.view');
    const brand = await loadBrand(ctx.db, version.brand_id);
    if (!mcpOf(brand).allow_approval) throw new AppError(403, 'assistant_approval_off', msg('mcp.approvalOff'), { settings_url: link.settings('assistants') });
    const piece = (await ctx.db.one<{ id: string; title: string }>('select id, title from piece where id = $1', [version.piece_id]))!;
    const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const fp = confirm.fingerprint.toLowerCase();
    const matches = (confirm.piece === piece.id || norm(confirm.piece) === norm(piece.title))
      && confirm.version_number === version.number
      && /^[0-9a-f]{12,64}$/.test(fp) && version.fingerprint.startsWith(fp);
    if (!matches) {
      throw new AppError(409, 'confirmation_mismatch',
        msg('mcp.confirmMismatch', { number: version.number, title: piece.title, fingerprint: shortFp(version.fingerprint) }),
        { current: { piece: piece.title, version_number: version.number, fingerprint: shortFp(version.fingerprint), state: version.review_state } });
    }
    return version;
  };

  server.registerTool('approve_version', {
    title: 'Approve a version',
    description: 'Approves a version for the given accounts, as the person. Only where a brand admin enabled approving from assistants, and only for people whose role can approve (never their own upload, never with open comments). Before calling it, show the person what they are approving (piece, version number, fingerprint), get their explicit yes, and pass it in "confirm". The approval is bound to the version\'s files: changing a byte later voids it. If the brand has a checklist, every item must be confirmed by the person.',
    inputSchema: {
      version_id: uuid('The version id'),
      account_ids: z.array(z.string().uuid()).min(1).max(50).describe('The accounts it is approved to go out on'),
      confirm: confirmSchema,
      checklist_confirmed: z.array(z.string().max(200)).max(20).optional().describe('The brand checklist items the person confirmed, word for word'),
      note: z.string().max(5000).optional(),
      auto_schedule: z.boolean().default(true).describe('Let Postbay schedule it by itself afterwards (at its slot, or in a free slot if the brand does that). false keeps it out'),
      schedule_text: z.string().max(10_000).optional().describe('Caption to use when Postbay schedules it by itself'),
      schedule_first_comment: z.string().max(5000).optional(),
    },
    annotations: write,
  }, run(async (a) => {
    await gate(a.version_id, a.confirm);
    const r = await approvals.decide(ctx, p, a.version_id, {
      decision: 'approve', accountIds: a.account_ids, checklist: Object.fromEntries((a.checklist_confirmed ?? []).map((k) => [k, true])),
      note: a.note ?? '', autoSchedule: a.auto_schedule, scheduleText: a.schedule_text ?? '', scheduleFirstComment: a.schedule_first_comment ?? '',
    });
    return { version_id: r.versionId, state: r.review_state, approved: r.review_state === 'approved', fingerprint: shortFp(r.fingerprint), on_approval: r.slot_schedule ?? null, url: link.review(r.versionId) };
  }));

  server.registerTool('request_changes', {
    title: 'Request changes',
    description: 'Sends a version back for changes, as the person. Only where a brand admin enabled deciding from assistants, and only for people whose role can request changes. There must be an open comment, or give a note (it becomes a comment). This may start the AI agent on a new version. Before calling it, show the person the piece, version number and fingerprint, get their explicit yes, and pass them in "confirm".',
    inputSchema: {
      version_id: uuid('The version id'),
      confirm: confirmSchema,
      note: z.string().trim().max(5000).optional().describe('What to change (added as a general comment)'),
    },
    annotations: write,
  }, run(async (a) => {
    await gate(a.version_id, a.confirm);
    const r = await approvals.requestChanges(ctx, p, a.version_id, { note: a.note ?? '' });
    return { version_id: r.versionId, state: r.review_state, open_comments: r.open_comments, url: link.review(r.versionId) };
  }));

  return server;
}
