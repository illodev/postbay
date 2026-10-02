import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AgentRun, type PieceAgent } from '../api';
import { t } from '../i18n';
import { BLOCK_REASON_LABEL, fmtDateTime, fmtMoney, TRIGGER_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { OutcomeChip } from './AgentTab';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { ago } from './PieceHero';
import { errorMessage, useToast } from './ui';
import '../styles/piece.css';

const SHOWN = 5;

/** What the runner says about the piece's project after a run (apps/runner/src/pipeline.ts, projectDetail). */
interface ProjectDetail {
  source?: string;
  mode?: 'git' | 'dir';
  branch?: string;
  commit?: string | null;
  base?: string;
  files?: number;
  pushed?: boolean;
  error?: string;
}

function projectOf(run: AgentRun): ProjectDetail | null {
  const p = (run.detail as { project?: unknown }).project;
  return p && typeof p === 'object' ? (p as ProjectDetail) : null;
}

const sha = (s: string) => s.slice(0, 7);

function Meter({ label, value, cap, fraction }: { label: string; value: string; cap: string | null; fraction: number | null }) {
  const full = fraction !== null && fraction >= 1;
  return (
    <div className="pc-meter">
      <div className="pc-meter-top">
        <span className="pc-meter-label">{label}</span>
        <span className="pc-meter-val">
          {value}
          {cap !== null && <span className="pc-meter-cap"> / {cap}</span>}
        </span>
      </div>
      <span className={`pc-bar ${full ? 'is-full' : 'is-agent'}`} aria-hidden="true">
        <i style={{ width: `${Math.round(Math.min(1, fraction ?? 0) * 100)}%` }} />
      </span>
    </div>
  );
}

/** The project the agent worked in during a run: its source, the branch and commit it left, whether that reached the remote. */
function Project({ p }: { p: ProjectDetail }) {
  return (
    <div className="pc-proj">
      {p.source && <code className="pc-proj-src" title={t('piece.agent.project.source')}>{p.source}</code>}
      <div className="pc-proj-line">
        {p.mode === 'dir' ? (
          <span className="pc-proj-item">{t('piece.agent.project.dir')}</span>
        ) : (
          <>
            {p.branch && <span className="pc-proj-item" title={t('piece.agent.project.branch')}><Icon name="branch" /><code>{p.branch}</code></span>}
            {p.commit ? (
              <span className="pc-proj-item" title={t('piece.agent.project.commit', { sha: p.commit })}><Icon name="commit" /><code>{sha(p.commit)}</code></span>
            ) : p.commit === null && !p.error ? (
              <span className="pc-proj-item is-quiet">{t('piece.agent.project.unchanged')}</span>
            ) : null}
            {p.commit && p.files !== undefined && <span className="pc-proj-item is-quiet">{t('piece.agent.project.files', { count: p.files })}</span>}
            {p.commit && (p.pushed ? (
              <span className="pc-proj-item is-good"><Icon name="arrowUp" />{t('piece.agent.project.pushed')}</span>
            ) : (
              <span className="pc-proj-item is-warn" title={t('piece.agent.project.notPushedHint')}>{t('piece.agent.project.notPushed')}</span>
            ))}
          </>
        )}
      </div>
      {p.error && <p className="pc-proj-err" title={p.error}>{p.error}</p>}
    </div>
  );
}

/**
 * Where a piece stands with the agent: rounds used, what it has cost, what each run did (with the project it worked in, when
 * the piece has one), and whether a person has to step in. Hidden until the agent has done something with the piece, so brands
 * that do not use one never see it.
 */
export function PieceAgentCard({ pieceId, zone, className }: { pieceId: string; zone?: string; className?: string }) {
  const { can, brand } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const { data } = useQuery({
    queryKey: ['agent', pieceId],
    queryFn: () => api.get<PieceAgent>(`/api/pieces/${pieceId}/agent`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 5000 : 30_000),
  });
  const reset = useMutation({
    mutationFn: () => api.post(`/api/pieces/${pieceId}/agent/reset`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agent', pieceId] }); toast(t('piece.agent.handedBack')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!data || data.runs.length === 0) return null;
  const s = data.settings;
  const budget = s.max_cost_per_piece;
  // Rounds and a piece's own budget start again when a person hands the piece back; the month's budget and a missing one are the admin's.
  const brandBlock = data.blocked_reason === 'monthly_budget_reached' || data.blocked_reason === 'budget_not_set';
  const money = (n: number) => fmtMoney(n, s.currency);
  const tz = zone ?? brand.timezone;
  // Why it stopped, said here in the reader's language; the server's own sentence only for a reason this does not know.
  const why = (() => {
    switch (data.blocked_reason) {
      case 'budget_not_set': return t('piece.agent.why.budget_not_set');
      case 'rounds_exhausted': return t('piece.agent.why.rounds_exhausted', { max: data.max_rounds });
      case 'piece_budget_reached': return t('piece.agent.why.piece_budget_reached', { spent: money(data.spent_piece), cap: money(budget ?? 0) });
      case 'monthly_budget_reached': return t('piece.agent.why.monthly_budget_reached', { spent: money(data.spent_month), cap: money(s.max_cost_per_month ?? 0) });
      default: return data.blocked_message;
    }
  })();
  const runs = all ? data.runs : data.runs.slice(0, SHOWN);
  return (
    <section className={`pc-side-card pc-agent ${className ?? ''}`} aria-labelledby="pc-agent-h">
      <header className="pc-side-head">
        <Avatar agent size={22} />
        <h2 id="pc-agent-h">{t('piece.agent.title')}</h2>
        <span className="pc-side-head-end">
          {data.status === 'running' && <span className="chip chip-agent">{t('piece.agent.running')}</span>}
          {data.status === 'needs_person' && <span className="chip chip-needs_person">{t('piece.agent.needsPerson')}</span>}
          {data.status === 'idle' && <span className="chip chip-draft">{t('piece.agent.idle')}</span>}
        </span>
      </header>

      <div className="pc-meters">
        <Meter label={t('piece.agent.rounds')} value={String(data.rounds)} cap={String(data.max_rounds)} fraction={data.max_rounds ? data.rounds / data.max_rounds : null} />
        <Meter label={t('piece.agent.spent')} value={money(data.spent_piece)} cap={budget !== null ? money(budget) : null} fraction={budget ? data.spent_piece / budget : null} />
      </div>

      {data.status === 'needs_person' && (
        <div className="pc-agent-stop" role="status">
          <p><strong>{BLOCK_REASON_LABEL[data.blocked_reason ?? ''] ?? t('piece.agent.stopped')}.</strong> {why}</p>
          {can('approve') && !brandBlock && (
            <button className="btn btn-small" disabled={reset.isPending} onClick={() => reset.mutate()} title={t('piece.agent.handBackHint')}>{t('piece.agent.handBack')}</button>
          )}
          {brandBlock && <p className="pc-agent-admin">{t('piece.agent.adminBudget')}</p>}
        </div>
      )}

      <h3 className="pc-runs-title">{t('piece.agent.runs')}</h3>
      <ol className="pc-runs">
        {runs.map((r) => {
          const project = projectOf(r);
          return (
            <li key={r.id} className="pc-run">
              <div className="pc-run-head">
                {r.status === 'running' ? <span className="chip chip-agent">{t('piece.agent.running')}</span> : <OutcomeChip run={r} />}
                {r.version_id && r.version_number && (
                  <Link className="pc-run-ver" to={`/review/${r.version_id}`} title={t('piece.agent.openVersion', { n: r.version_number })}>v{r.version_number}</Link>
                )}
                <time className="pc-run-time" dateTime={r.started_at} title={fmtDateTime(r.started_at, tz)}>{ago(r.started_at)}</time>
              </div>
              <div className="pc-run-meta">
                <span>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                {r.outcome !== 'blocked' && r.status !== 'running' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="mono">{money(r.cost)}</span>
                    {r.counted === false && <span className="pc-run-free" title={t('piece.agent.notCountedHint')}>{t('piece.agent.notCounted')}</span>}
                  </>
                )}
              </div>
              {r.notes && r.outcome !== 'blocked' && <p className="pc-run-notes" title={r.notes}>{r.notes}</p>}
              {r.detail?.checks?.summary?.length ? <p className="pc-run-notes is-checks">{t('piece.agent.checks', { summary: r.detail.checks.summary.join('; ') })}</p> : null}
              {project && <Project p={project} />}
            </li>
          );
        })}
      </ol>
      {data.runs.length > SHOWN && (
        <button type="button" className="btn btn-ghost btn-small pc-side-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('piece.agent.fewer') : t('piece.agent.more', { count: data.runs.length - SHOWN })}
        </button>
      )}
    </section>
  );
}
