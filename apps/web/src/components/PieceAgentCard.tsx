import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type PieceAgent } from '../api';
import { t } from '../i18n';
import { BLOCK_REASON_LABEL, fmtMoney, fmtShort, TRIGGER_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { OutcomeChip } from './AgentTab';
import { errorMessage, useToast } from './ui';
import '../styles/piece.css';

const SHOWN = 6;

function Meter({ label, value, cap, fraction }: { label: string; value: string; cap: string | null; fraction: number | null }) {
  return (
    <div className="pc-meter">
      <div className="pc-meter-top">
        <span>{label}</span>
        <span className="pc-meter-line">
          <span className="pc-meter-val">{value}</span>
          {cap !== null && <span className="pc-meter-cap">{t('piece.agent.ofCap', { cap })}</span>}
        </span>
      </div>
      {fraction !== null && (
        <span className={`pc-bar ${fraction >= 1 ? 'is-full' : 'is-agent'}`} aria-hidden="true">
          <i style={{ width: `${Math.round(Math.min(1, fraction) * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * Where a piece stands with the agent: rounds used, what it has cost, what each run did, and whether a person has to step
 * in. Hidden until the agent has done something with the piece, so brands that do not use one never see it.
 */
export function PieceAgentCard({ pieceId, className }: { pieceId: string; className?: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
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
  return (
    <section className={`card pc-agent ${className ?? ''}`} aria-labelledby="pc-agent-h">
      <div className="card-head">
        <h2 id="pc-agent-h" className="pc-agent-title">
          <span className="pc-agent-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M5 9h14v10H5zM9 14h.01M15 14h.01M2 13v3M22 13v3" /></svg>
          </span>
          {t('piece.agent.title')}
        </h2>
        {data.status === 'running' && <span className="chip chip-agent">{t('piece.agent.running')}</span>}
        {data.status === 'needs_person' && <span className="chip chip-needs_person">{t('piece.agent.needsPerson')}</span>}
        {data.status === 'idle' && <span className="chip">{t('piece.agent.idle')}</span>}
      </div>

      <div className="pc-meters">
        <Meter label={t('piece.agent.rounds')} value={String(data.rounds)} cap={String(data.max_rounds)} fraction={data.max_rounds ? data.rounds / data.max_rounds : null} />
        <Meter label={t('piece.agent.spent')} value={money(data.spent_piece)} cap={budget !== null ? money(budget) : null} fraction={budget ? data.spent_piece / budget : null} />
      </div>

      {data.status === 'needs_person' && (
        <div className="notice notice-warn pc-agent-stop" role="status">
          <strong>{BLOCK_REASON_LABEL[data.blocked_reason ?? ''] ?? t('piece.agent.stopped')}.</strong> {why}
          {(can('approve') && !brandBlock) || brandBlock ? (
            <div className="row" style={{ marginTop: '.5rem' }}>
              {can('approve') && !brandBlock && (
                <button className="btn btn-small" disabled={reset.isPending} onClick={() => reset.mutate()} title={t('piece.agent.handBackHint')}>{t('piece.agent.handBack')}</button>
              )}
              {brandBlock && <span className="small">{t('piece.agent.adminBudget')}</span>}
            </div>
          ) : null}
        </div>
      )}

      <h3 className="pc-runs-title">{t('piece.agent.runs')}</h3>
      <ol className="pc-runs">
        {data.runs.slice(0, SHOWN).map((r) => (
          <li key={r.id} className="pc-run">
            <div className="pc-run-head">
              {r.status === 'running' ? <span className="chip chip-agent">{t('piece.agent.running')}</span> : <OutcomeChip run={r} />}
              {r.version_id && r.version_number && (
                <Link className="pc-vchip is-agent" to={`/review/${r.version_id}`} aria-label={t('piece.agent.openVersion', { n: r.version_number })}>v{r.version_number}</Link>
              )}
            </div>
            <div className="pc-run-meta">
              <span>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
              <span aria-hidden="true">·</span>
              <span>{fmtShort(r.started_at)}</span>
              {r.outcome !== 'blocked' && r.status !== 'running' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="mono">{money(r.cost)}</span>
                  {r.counted === false && <span className="pc-run-free">{t('piece.agent.notCounted')}</span>}
                </>
              )}
            </div>
            {r.notes && r.outcome !== 'blocked' && <p className="pc-run-notes">{r.notes.slice(0, 220)}</p>}
            {r.detail?.checks?.summary?.length ? <p className="pc-run-notes">{t('piece.agent.checks', { summary: r.detail.checks.summary.join('; ').slice(0, 200) })}</p> : null}
          </li>
        ))}
      </ol>
      {data.runs.length > SHOWN && <p className="muted small pc-runs-more">{t('piece.agent.more', { count: data.runs.length - SHOWN })}</p>}
    </section>
  );
}
