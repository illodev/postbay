import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Anchor, type CommentThread, type VersionDetail, type VersionSummary } from '../api';
import { t, type Key } from '../i18n';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { Avatar, displayName } from './Avatar';
import { NetMark, SkeletonText, Tipped } from './ui';
import { ago, variantName } from './PieceHero';
import '../styles/piece.css';

/** The most recent versions whose comments and decisions are read; older ones are rarely what someone is looking for. */
const VERSIONS_READ = 12;
const SHOWN = 8;

interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string;
  actor: string | null;
}

type Kind = 'created' | 'edited' | 'discarded' | 'reset' | 'version' | 'comment' | 'reply' | 'approved' | 'rejected' | 'changes' | 'published' | 'failed';

interface Ev {
  key: string;
  at: string;
  kind: Kind;
  who?: { name: string | null; agent?: boolean };
  network?: string;
  version?: { id: string; number: number };
  variant?: string;
  text?: string;
  mark?: string;
  fields?: string[];
}

export interface ActivityPiece {
  id: string;
  brand_id: string;
  variants: { id: string; format: string; style: string; versions: VersionSummary[] }[];
  publications: { id: string; status: string; network: string; account_name: string; scheduled_at: string; published_at?: string | null; version_id: string; version_number: number }[];
}

/** A person's name as lists show it: the name, or the part of the email before the @. */
const short = (name: string | null | undefined) => (name ? displayName(name.includes('@') ? null : name, name.includes('@') ? name : null) : t('piece.unknownAuthor'));

/** Where a comment points: a moment of the video (0:12, 0:12–0:15) or a page of a document. */
function markOf(a: Anchor | null): string | undefined {
  if (!a) return undefined;
  const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  if (a.type === 'time') return a.t_end !== undefined && a.t_end > a.t ? `${tc(a.t)}–${tc(a.t_end)}` : tc(a.t);
  return t('piece.act.page', { n: a.page });
}

const EDITED_FIELDS: Record<string, Key> = {
  title: 'piece.act.field.title',
  brief: 'piece.act.field.brief',
  target_date: 'piece.act.field.target_date',
  ai_generated: 'piece.act.field.ai_generated',
  source: 'piece.act.field.source',
};

/**
 * What has happened to the piece, newest first: versions, comments and replies, decisions and publications, and (for whoever
 * can read the brand's record) its creation and edits. Built from what the piece and its versions already say; nothing is
 * shown that a role cannot read.
 */
export function PieceActivity({ piece, zone, className }: { piece: ActivityPiece; zone: string; className?: string }) {
  const { can } = useSession();
  const [all, setAll] = useState(false);
  const versions = piece.variants
    .flatMap((v) => v.versions.map((x) => ({ ...x, variant: v })))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, VERSIONS_READ);

  const comments = useQueries({
    queries: versions.map((v) => ({
      queryKey: ['comments', v.id],
      queryFn: () => api.get<CommentThread[]>(`/api/versions/${v.id}/comments?carried=true`),
      staleTime: 30_000,
    })),
  });
  const details = useQueries({
    queries: versions.map((v) => ({
      queryKey: ['version', v.id],
      queryFn: () => api.get<VersionDetail>(`/api/versions/${v.id}`),
      staleTime: 30_000,
    })),
  });
  const audit = useQuery({
    queryKey: ['audit', piece.brand_id, 'piece', piece.id],
    enabled: can('audit'),
    queryFn: () => api.get<AuditRow[]>(`/api/brands/${piece.brand_id}/audit?entity=piece&entityId=${piece.id}&limit=100`),
    retry: false,
  });
  const versionAudit = useQuery({
    queryKey: ['audit', piece.brand_id, 'version'],
    enabled: can('audit'),
    queryFn: () => api.get<AuditRow[]>(`/api/brands/${piece.brand_id}/audit?entity=version&limit=500`),
    retry: false,
    staleTime: 30_000,
  });

  const events: Ev[] = [];
  const seen = new Set<string>();
  const byId = new Map(versions.map((v) => [v.id, v]));
  const vnum = (id: string) => {
    const v = byId.get(id) ?? piece.variants.flatMap((x) => x.versions).find((x) => x.id === id);
    return v ? { id: v.id, number: v.number } : undefined;
  };

  for (const v of piece.variants.flatMap((x) => x.versions.map((y) => ({ ...y, variant: x })))) {
    events.push({ key: `v-${v.id}`, at: v.created_at, kind: 'version', who: { name: v.author, agent: v.by_agent }, version: { id: v.id, number: v.number }, variant: variantName(v.variant), text: v.notes || undefined });
  }
  for (const q of comments) {
    for (const c of q.data ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      events.push({ key: `c-${c.id}`, at: c.created_at, kind: 'comment', who: { name: c.author }, version: { id: c.version_id, number: c.version_number }, text: c.body, mark: markOf(c.anchor) });
      for (const r of c.replies) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        events.push({ key: `r-${r.id}`, at: r.created_at, kind: 'reply', who: { name: r.author, agent: r.by_agent }, version: { id: c.version_id, number: c.version_number }, text: r.body });
      }
    }
  }
  for (const q of details) {
    for (const a of q.data?.approvals ?? []) {
      events.push({ key: `a-${a.id}`, at: a.created_at, kind: a.decision === 'approve' ? 'approved' : 'rejected', who: { name: a.approver }, version: { id: q.data!.id, number: q.data!.number }, text: a.note || undefined });
    }
  }
  for (const p of piece.publications) {
    if (p.status === 'published' && p.published_at) events.push({ key: `p-${p.id}`, at: p.published_at, kind: 'published', network: p.network, text: p.account_name, version: { id: p.version_id, number: p.version_number } });
    if (p.status === 'failed') events.push({ key: `p-${p.id}`, at: p.scheduled_at, kind: 'failed', network: p.network, text: p.account_name, version: { id: p.version_id, number: p.version_number } });
  }
  for (const a of audit.data ?? []) {
    const who = { name: a.actor };
    if (a.action === 'piece.created') events.push({ key: `au-${a.id}`, at: a.at, kind: 'created', who });
    if (a.action === 'piece.discarded') events.push({ key: `au-${a.id}`, at: a.at, kind: 'discarded', who });
    if (a.action === 'agent.rounds_reset') events.push({ key: `au-${a.id}`, at: a.at, kind: 'reset', who });
    if (a.action === 'piece.updated') {
      const fields = Object.keys(EDITED_FIELDS).filter((k) => JSON.stringify(a.before?.[k] ?? null) !== JSON.stringify(a.after?.[k] ?? null));
      events.push({ key: `au-${a.id}`, at: a.at, kind: 'edited', who, fields: fields.map((f) => t(EDITED_FIELDS[f]!)) });
    }
  }
  for (const a of versionAudit.data ?? []) {
    if (a.action !== 'version.changes_requested' || !a.entity_id) continue;
    const v = vnum(a.entity_id);
    if (v) events.push({ key: `au-${a.id}`, at: a.at, kind: 'changes', who: { name: a.actor }, version: v });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));

  const loading = comments.some((q) => q.isLoading) || details.some((q) => q.isLoading);
  const shown = all ? events : events.slice(0, SHOWN);

  return (
    <section className={`pc-side-card pc-activity ${className ?? ''}`} aria-labelledby="pc-act-h">
      <header className="pc-side-head">
        <h2 id="pc-act-h">{t('piece.act.title')}</h2>
        {events.length > 0 && <span className="pc-count">{events.length}</span>}
      </header>
      {events.length === 0 ? (
        loading ? (
          <SkeletonText lines={4} />
        ) : (
          <p className="pc-side-empty">{t('piece.act.empty')}</p>
        )
      ) : (
        <ol className="pc-tl">
          {shown.map((e) => (
            <li key={e.key} className={`pc-tl-item is-${e.kind}`}>
              <span className="pc-tl-mark">
                {e.network ? <NetMark network={e.network} size="md" labelled /> : e.who?.agent ? <Avatar agent size={24} title={e.who.name ?? undefined} /> : <Avatar name={short(e.who?.name)} size={24} />}
              </span>
              <div className="pc-tl-body">
                <p className="pc-tl-line">
                  {e.who && <Tipped label={e.who.agent ? (e.who.name ?? undefined) : undefined}><strong className={e.who.agent ? 'pc-agent-name' : undefined}>{e.who.agent ? t('common.agent') : short(e.who.name)}</strong></Tipped>}{' '}
                  <Sentence e={e} />
                </p>
                {(e.mark || (e.text && e.kind !== 'published' && e.kind !== 'failed')) && (
                  <p className="pc-tl-quote">
                    {e.mark && <span className="tc">{e.mark}</span>}
                    {e.text && <span>{e.text}</span>}
                  </p>
                )}
                <Tipped label={fmtDateTime(e.at, zone)}><time className="pc-tl-time" dateTime={e.at}>{ago(e.at)}</time></Tipped>
              </div>
            </li>
          ))}
        </ol>
      )}
      {events.length > SHOWN && (
        <button type="button" className="btn btn-ghost btn-small pc-side-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('piece.act.less') : t('piece.act.all', { count: events.length })}
        </button>
      )}
    </section>
  );
}

function VersionLink({ v }: { v: { id: string; number: number } }) {
  return <Link to={`/review/${v.id}`} className="pc-tl-ver">v{v.number}</Link>;
}

/** A sentence with the version in it as a link, wherever the language puts it ("{v}" in the message). */
function withVersion(key: Key, v: { id: string; number: number } | undefined, vars?: Record<string, string>) {
  const [before, after] = t(key, vars).split('{v}');
  return <>{before}{v && <VersionLink v={v} />}{after}</>;
}

function Sentence({ e }: { e: Ev }) {
  const network = e.network ? (NETWORK_LABEL[e.network] ?? e.network) : '';
  switch (e.kind) {
    case 'created': return <>{t('piece.act.created')}</>;
    case 'discarded': return <>{t('piece.act.discarded')}</>;
    case 'reset': return <>{t('piece.act.reset')}</>;
    case 'edited': return <>{e.fields?.length ? t('piece.act.edited', { fields: e.fields.join(', ') }) : t('piece.act.editedSome')}</>;
    case 'version': return <>{withVersion('piece.act.version', e.version)} <span className="pc-tl-variant">· {e.variant}</span></>;
    case 'comment': return withVersion('piece.act.comment', e.version);
    case 'reply': return withVersion('piece.act.reply', e.version);
    case 'approved': return withVersion('piece.act.approved', e.version);
    case 'rejected': return withVersion('piece.act.rejected', e.version);
    case 'changes': return withVersion('piece.act.changes', e.version);
    case 'published': return <>{withVersion('piece.act.published', e.version, { network })} <span className="pc-tl-variant">· {e.text}</span></>;
    case 'failed': return <>{withVersion('piece.act.failed', e.version, { network })} <span className="pc-tl-variant">· {e.text}</span></>;
  }
}
