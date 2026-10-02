import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AgentRun, type AgentSettings, type BrandAgent } from '../api';
import { t } from '../i18n';
import { BLOCK_REASON_LABEL, fmtMoney, fmtShort, OUTCOME_LABEL, TRIGGER_LABEL } from '../lib/format';
import { ErrorBox, Field, Spinner, Tip, useToast } from './ui';

const OUTCOME_CHIP: Record<string, string> = {
  uploaded: 'chip-approved', needs_people: 'chip-changes_requested', failed: 'chip-failed', checks_failed: 'chip-failed',
  timeout: 'chip-failed', aborted: '', blocked: 'chip-on_hold',
};

export function OutcomeChip({ run }: { run: Pick<AgentRun, 'status' | 'outcome' | 'blocked_reason'> }) {
  if (run.status === 'running') return <span className="chip chip-agent">{t('settings.agent.working')}</span>;
  const label = run.outcome === 'blocked' ? (BLOCK_REASON_LABEL[run.blocked_reason ?? ''] ?? t('settings.agent.notStarted')) : (OUTCOME_LABEL[run.outcome ?? ''] ?? run.outcome);
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
      toast(t('settings.saved'));
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (!data || !form) return <Spinner />;
  const s = data.settings;
  const budgetsSet = s.max_cost_per_piece !== null && s.max_cost_per_month !== null;
  const pct = s.max_cost_per_month ? Math.min(100, (data.spent_month / s.max_cost_per_month) * 100) : 0;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const currency = form.currency || 'USD';
  const finished = data.runs.filter((r) => r.status === 'finished');
  const uploaded = finished.filter((r) => r.outcome === 'uploaded').length;

  return (
    <>
      {!budgetsSet && (
        <div className="notice notice-warn" role="status" style={{ margin: 0 }}>{t('settings.agent.noBudget')}</div>
      )}

      <section className="card stack" aria-label={t('settings.agent.month')}>
        <h3>{t('settings.agent.month')}</h3>
        <div className="set-stats">
          <div>
            <div className="set-stat-label">{t('settings.agent.spent')}</div>
            <div className="set-stat-value">{fmtMoney(data.spent_month, s.currency)}</div>
          </div>
          <div>
            <div className="set-stat-label">{t('settings.agent.monthBudget')}</div>
            <div className="set-stat-value">{s.max_cost_per_month !== null ? fmtMoney(s.max_cost_per_month, s.currency) : <span className="set-stat-none">{t('settings.agent.noLimit')}</span>}</div>
          </div>
          <div>
            <div className="set-stat-label">{t('settings.agent.recentRuns')}</div>
            <div className="set-stat-value">{data.runs.length}</div>
            {data.runs.length > 0 && <div className="set-stat-note">{t('settings.agent.uploadedOf', { count: uploaded })}</div>}
          </div>
        </div>
        {s.max_cost_per_month !== null && (
          <>
            <div className="set-meter" data-level={pct >= 100 ? 'full' : pct >= 80 ? 'high' : 'ok'} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t('settings.agent.share')}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="set-hint">{t('settings.agent.spentOf', { spent: fmtMoney(data.spent_month, s.currency), budget: fmtMoney(s.max_cost_per_month, s.currency) })}</p>
          </>
        )}
      </section>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="set-card-head">
          <Tip label={t('settings.agent.limitsHint')}><h3>{t('settings.agent.limits')}</h3></Tip>
        </div>
        <div className="set-fields">
          <Field label={t('settings.agent.rounds')} hint={t('settings.agent.roundsHint')}><input type="number" min={1} max={10} required value={form.rounds} onChange={set('rounds')} /></Field>
          <Field label={t('settings.agent.minutes')} hint={t('settings.agent.minutesHint')}><input type="number" min={1} max={240} required value={form.minutes} onChange={set('minutes')} /></Field>
        </div>
        <div className="set-fields">
          <Field label={t('settings.agent.budgetPiece', { currency })} hint={t('settings.agent.budgetPieceHint')}><input type="number" min={0} step="0.01" value={form.piece} onChange={set('piece')} /></Field>
          <Field label={t('settings.agent.budgetMonth', { currency })} hint={t('settings.agent.budgetMonthHint')}><input type="number" min={0} step="0.01" value={form.month} onChange={set('month')} /></Field>
          <Field label={t('settings.agent.currency')}><input type="text" maxLength={8} value={form.currency} onChange={set('currency')} style={{ maxWidth: 120 }} /></Field>
        </div>
        <Field label={t('settings.agent.slots')} hint={t('settings.agent.slotsHint')}>
          <input className="set-num-input" type="number" min={0} max={30} required value={form.slots} onChange={set('slots')} />
        </Field>
        {save.error && <ErrorBox error={save.error} />}
        <div><button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? t('common.saving') : t('common.save')}</button></div>
      </form>

      <section className="card">
        <div className="card-head"><h3>{t('settings.agent.runs')}</h3></div>
        {data.runs.length === 0 && <p className="muted small" style={{ margin: 0 }}>{t('settings.agent.noRuns')}</p>}
        {data.runs.length > 0 && (
          <div className="table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th>{t('settings.agent.when')}</th>
                  <th>{t('settings.agent.piece')}</th>
                  <th>{t('settings.agent.startedBy')}</th>
                  <th>{t('settings.agent.result')}</th>
                  <th className="num">{t('settings.agent.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtShort(r.started_at)}</td>
                    <td data-label={t('settings.agent.piece')}>
                      <span>
                        {r.piece_id ? <Link to={`/pieces/${r.piece_id}`}>{r.piece_title ?? t('settings.agent.pieceFallback')}</Link> : <span className="muted">{t('settings.agent.newPiece')}</span>}
                        {r.version_id && r.version_number && <> <Link className="tag tag-agent" to={`/review/${r.version_id}`}>v{r.version_number}</Link></>}
                      </span>
                    </td>
                    <td className="small" data-label={t('settings.agent.startedBy')}>
                      <span>{TRIGGER_LABEL[r.trigger] ?? r.trigger}{r.token_name && <span className="muted"> · {r.token_name}</span>}</span>
                    </td>
                    <td data-label={t('settings.agent.result')}>
                      <div>
                        <OutcomeChip run={r} />
                        {r.notes && <div className="small muted" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{r.notes.slice(0, 160)}</div>}
                      </div>
                    </td>
                    <td className="num" data-label={t('settings.agent.cost')}>{r.outcome === 'blocked' ? '—' : fmtMoney(r.cost, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
