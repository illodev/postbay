import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AgentRun, type AgentSettings, type BrandAgent } from '../api';
import { BLOCK_REASON_LABEL, fmtMoney, fmtShort, OUTCOME_LABEL, TRIGGER_LABEL } from '../lib/format';
import { ErrorBox, Field, Spinner, useToast } from './ui';

const OUTCOME_CHIP: Record<string, string> = {
  uploaded: 'chip-approved', needs_people: 'chip-changes_requested', failed: 'chip-failed', checks_failed: 'chip-failed',
  timeout: 'chip-failed', aborted: '', blocked: 'chip-on_hold',
};

export function OutcomeChip({ run }: { run: Pick<AgentRun, 'status' | 'outcome' | 'blocked_reason'> }) {
  if (run.status === 'running') return <span className="chip chip-publishing">Working</span>;
  const label = run.outcome === 'blocked' ? (BLOCK_REASON_LABEL[run.blocked_reason ?? ''] ?? 'Not started') : (OUTCOME_LABEL[run.outcome ?? ''] ?? run.outcome);
  return <span className={`chip ${OUTCOME_CHIP[run.outcome ?? ''] ?? ''}`}>{label}</span>;
}

const toNumber = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function AgentTab({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['brand-agent', brandId], queryFn: () => api.get<BrandAgent>(`/api/brands/${brandId}/agent`), refetchInterval: 15_000 });
  const [form, setForm] = useState<null | { rounds: string; piece: string; month: string; minutes: string; slots: string; currency: string }>(null);
  useEffect(() => {
    if (data && !form) {
      const s = data.settings;
      setForm({ rounds: String(s.max_rounds), piece: s.max_cost_per_piece === null ? '' : String(s.max_cost_per_piece), month: s.max_cost_per_month === null ? '' : String(s.max_cost_per_month), minutes: String(s.max_run_minutes), slots: String(s.slot_alert_days), currency: s.currency });
    }
  }, [data, form]);
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const agent: AgentSettings = {
        max_rounds: Number(f.rounds), max_cost_per_piece: toNumber(f.piece), max_cost_per_month: toNumber(f.month),
        max_run_minutes: Number(f.minutes), slot_alert_days: Number(f.slots), currency: f.currency.trim() || 'USD',
      };
      return api.patch(`/api/brands/${brandId}`, { agent });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brand-agent', brandId] });
      qc.invalidateQueries({ queryKey: ['brand', brandId] });
      toast('Saved');
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (!data || !form) return <Spinner />;
  const s = data.settings;
  const budgetsSet = s.max_cost_per_piece !== null && s.max_cost_per_month !== null;
  const pct = s.max_cost_per_month ? Math.min(100, (data.spent_month / s.max_cost_per_month) * 100) : 0;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="stack">
      <div className="notice notice-info">
        The agent turns a request for changes into a new version without anyone passing it on. It runs in a separate program (the runner), listens
        to a webhook and signs in with a producer token (API tokens tab). It can never approve or schedule. These limits are checked here, so no
        runner can skip them.
      </div>
      {!budgetsSet && (
        <div className="notice notice-warn" role="status">The agent will not start until both budgets are set: spending is a decision, not a default.</div>
      )}
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <h3>Limits</h3>
        <div className="row">
          <div className="grow"><Field label="Rounds per piece" hint="After this many rounds the piece goes to a person instead of to the agent again."><input type="number" min={1} max={10} required value={form.rounds} onChange={set('rounds')} /></Field></div>
          <div className="grow"><Field label="Longest run (minutes)" hint="The runner stops the agent after this long."><input type="number" min={1} max={240} required value={form.minutes} onChange={set('minutes')} /></Field></div>
        </div>
        <div className="row">
          <div className="grow"><Field label={`Budget per piece (${form.currency || 'USD'})`} hint="What the agent may spend on one piece, in total."><input type="number" min={0} step="0.01" value={form.piece} onChange={set('piece')} /></Field></div>
          <div className="grow"><Field label={`Budget per month (${form.currency || 'USD'})`} hint="What it may spend across the whole brand each calendar month."><input type="number" min={0} step="0.01" value={form.month} onChange={set('month')} /></Field></div>
          <div style={{ width: 110 }}><Field label="Currency"><input type="text" maxLength={8} value={form.currency} onChange={set('currency')} /></Field></div>
        </div>
        <div className="row">
          <div className="grow"><Field label="Ask for content for an empty slot (days ahead)" hint="A calendar slot still empty this many days before its date is announced as an event. 0 turns it off."><input type="number" min={0} max={30} required value={form.slots} onChange={set('slots')} /></Field></div>
        </div>
        {save.error && <ErrorBox error={save.error} />}
        <div><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
      </form>

      <div className="card stack">
        <h3>This month</h3>
        <p style={{ margin: 0 }}>
          Spent <strong>{fmtMoney(data.spent_month, s.currency)}</strong>
          {s.max_cost_per_month !== null && <> of {fmtMoney(s.max_cost_per_month, s.currency)}</>}
        </p>
        {s.max_cost_per_month !== null && <progress value={pct} max={100} aria-label="Share of the monthly budget spent" style={{ width: '100%' }} />}
      </div>

      <div className="card">
        <div className="card-head"><h3>Recent runs</h3></div>
        {data.runs.length === 0 && <p className="muted">The agent has not run yet.</p>}
        {data.runs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Piece</th><th>Started by</th><th>Result</th><th>Cost</th></tr></thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtShort(r.started_at)}</td>
                    <td>{r.piece_id ? <Link to={`/pieces/${r.piece_id}`}>{r.piece_title ?? 'Piece'}</Link> : <span className="muted">New piece</span>}{r.version_id && r.version_number && <> · <Link to={`/review/${r.version_id}`}>v{r.version_number}</Link></>}</td>
                    <td className="small">{TRIGGER_LABEL[r.trigger] ?? r.trigger}{r.token_name && <div className="muted">{r.token_name}</div>}</td>
                    <td>
                      <OutcomeChip run={r} />
                      {r.notes && <div className="small muted" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{r.notes.slice(0, 160)}</div>}
                    </td>
                    <td className="small">{r.outcome === 'blocked' ? '' : fmtMoney(r.cost, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
