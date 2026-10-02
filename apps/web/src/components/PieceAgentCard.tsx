import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type PieceAgent } from '../api';
import { BLOCK_REASON_LABEL, fmtMoney, fmtShort, TRIGGER_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { OutcomeChip } from './AgentTab';
import { errorMessage, useToast } from './ui';

/**
 * Where a piece stands with the agent: rounds used, what it has cost, what each run did, and whether a person has to step
 * in. Hidden until the agent has done something with the piece, so brands that do not use one never see it.
 */
export function PieceAgentCard({ pieceId }: { pieceId: string }) {
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agent', pieceId] }); toast('Handed back to the agent'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!data || data.runs.length === 0) return null;
  const s = data.settings;
  const budget = s.max_cost_per_piece;
  // Rounds and a piece's own budget start again when a person hands the piece back; the month's budget and a missing one are the admin's.
  const brandBlock = data.blocked_reason === 'monthly_budget_reached' || data.blocked_reason === 'budget_not_set';
  return (
    <section className="card" aria-label="Agent">
      <div className="card-head">
        <h2>Agent</h2>
        {data.status === 'running' && <span className="chip chip-publishing">Working on it</span>}
        {data.status === 'needs_person' && <span className="chip chip-failed">Needs a person</span>}
        {data.status === 'idle' && <span className="chip">Idle</span>}
      </div>
      <p style={{ margin: '0 0 .5rem' }}>
        Round <strong>{data.rounds}</strong> of {data.max_rounds}
        {' · '}spent <strong>{fmtMoney(data.spent_piece, s.currency)}</strong>{budget !== null && <> of {fmtMoney(budget, s.currency)}</>}
      </p>
      {data.status === 'needs_person' && (
        <div className="notice notice-warn" role="status">
          <strong>{BLOCK_REASON_LABEL[data.blocked_reason ?? ''] ?? 'The agent stopped'}.</strong> {data.blocked_message}
          <div className="row" style={{ marginTop: '.5rem' }}>
            {can('approve') && !brandBlock && (
              <button className="btn btn-small" disabled={reset.isPending} onClick={() => reset.mutate()} title="Counts rounds and spending on this piece from zero again, and sends the request that is waiting to the agent">Hand it back to the agent</button>
            )}
            {brandBlock && <span className="small">An admin can set or raise the budget in Settings → Agent.</span>}
          </div>
        </div>
      )}
      <div className="stack" style={{ gap: '.35rem' }}>
        {data.runs.slice(0, 6).map((r) => (
          <div key={r.id} className="version-row" style={{ alignItems: 'flex-start' }}>
            <OutcomeChip run={r} />
            <span className="grow small">
              {TRIGGER_LABEL[r.trigger] ?? r.trigger} · {fmtShort(r.started_at)}
              {r.outcome !== 'blocked' && <> · {fmtMoney(r.cost, s.currency)}</>}
              {!r.counted && r.outcome !== 'blocked' && <span className="muted"> · not counted</span>}
              {r.notes && <span className="muted" style={{ display: 'block', overflowWrap: 'anywhere' }}>{r.notes.slice(0, 200)}</span>}
              {r.detail?.checks?.summary?.length ? <span className="muted" style={{ display: 'block' }}>Checks: {r.detail.checks.summary.join('; ').slice(0, 200)}</span> : null}
            </span>
            {r.version_id && r.version_number && <Link className="btn btn-small" to={`/review/${r.version_id}`}>v{r.version_number}</Link>}
          </div>
        ))}
      </div>
    </section>
  );
}
