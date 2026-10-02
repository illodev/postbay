import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'luxon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Account, type BrandSettings, type Integrations, type PendingConnection, type Provider, type Role, type SlackSettings, type Webhook } from '../api';
import { Chip, CopyButton, Dialog, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
import { t, tMaybe, type Key } from '../i18n';
import { fmtDateTime, fmtDay, fmtShort, NETWORK_LABEL, ROLE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { AgentTab } from '../components/AgentTab';
import { AccountCheckDialog, ServerCheckDialog } from '../components/CheckDialog';
import { PrizesSettings } from '../components/PrizesSettings';
import { SlackSettingsCard } from '../components/SlackSettings';
import { Webhooks } from '../components/Webhooks';
import '../styles/settings.css';

/** The sections. "notifications" is the Slack section: the key stays as it was so old links keep working. */
type Tab = 'general' | 'members' | 'accounts' | 'schedule' | 'agent' | 'webhooks' | 'prizes' | 'notifications' | 'tokens' | 'audit';

const ROLES: Role[] = ['admin', 'approver', 'reviewer', 'producer', 'reader'];

/** Network initials for the small square badge. Not words: the same in every language, and the full name sits next to it. */
const NET_SHORT: Record<string, string> = {
  instagram: 'IG', facebook: 'FB', youtube: 'YT', tiktok: 'TT', linkedin: 'LI', x: 'X', threads: 'TH', pinterest: 'PI', bluesky: 'BS',
};

const initials = (s: string) =>
  s.split(/[\s@.()]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** Day names from luxon, so they follow the language: Monday is 1, as the API counts them. */
const weekdayName = (n: number) => {
  const w = Info.weekdays('long')[n - 1] ?? String(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const expired = (iso: string) => new Date(iso).getTime() <= Date.now();

function useBrandSettings(brandId: string) {
  return useQuery({ queryKey: ['brand', brandId], queryFn: () => api.get<BrandSettings>(`/api/brands/${brandId}`) });
}

// ───────────────────────────── general ─────────────────────────────

function General({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: b, error } = useBrandSettings(brandId);
  const [form, setForm] = useState<null | { name: string; timezone: string; locale: string; required: number; reapprove: boolean; checklist: string; lead: number; tolerance: number }>(null);
  const f = form ?? (b && { name: b.name, timezone: b.timezone, locale: b.locale, required: b.rules.required_approvals, reapprove: b.rules.reapprove_on_move, checklist: b.rules.checklist.join('\n'), lead: b.publishing.prepare_lead_minutes, tolerance: b.publishing.late_tolerance_minutes });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/brands/${brandId}`, {
      name: f!.name, timezone: f!.timezone, locale: f!.locale,
      rules: { required_approvals: f!.required, reapprove_on_move: f!.reapprove, checklist: f!.checklist.split('\n').map((x) => x.trim()).filter(Boolean) },
      publishing: { prepare_lead_minutes: f!.lead, late_tolerance_minutes: f!.tolerance },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['brand'] }); qc.invalidateQueries({ queryKey: ['me'] }); setForm(null); toast(t('settings.saved')); },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.post(`/api/brands/${brandId}/pause`, { paused }),
    onSuccess: (_d, paused) => { qc.invalidateQueries({ queryKey: ['brand'] }); qc.invalidateQueries({ queryKey: ['me'] }); toast(paused ? t('settings.general.paused') : t('settings.general.resumed')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (error) return <ErrorBox error={error} />;
  if (!b || !f) return <Spinner />;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return (
    <>
      {can('manage') && (
        <form className="set-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <section className="card stack">
            <h3>{t('settings.general.brand')}</h3>
            <Field label={t('settings.general.name')}>
              <input type="text" required value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} />
            </Field>
            <div className="set-fields">
              <Field label={t('settings.general.timezone')} hint={t('settings.general.timezoneHint')}>
                <input type="text" list="zones" required value={f.timezone} onChange={(e) => setForm({ ...f, timezone: e.target.value })} />
                <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              </Field>
              <Field label={t('settings.general.locale')} hint={t('settings.general.localeHint')}>
                <input type="text" required maxLength={10} value={f.locale} onChange={(e) => setForm({ ...f, locale: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="card stack">
            <div className="set-card-head">
              <div>
                <h3>{t('settings.general.rules')}</h3>
                <p className="set-hint">{t('settings.general.rulesHint')}</p>
              </div>
            </div>
            <Field label={t('settings.general.required')} hint={t('settings.general.requiredHint')}>
              <input className="set-num-input" type="number" min={1} max={5} value={f.required} onChange={(e) => setForm({ ...f, required: Number(e.target.value) })} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={f.reapprove} onChange={(e) => setForm({ ...f, reapprove: e.target.checked })} />
              <span>{t('settings.general.reapprove')}<br /><span className="muted small">{t('settings.general.reapproveHint')}</span></span>
            </label>
            <Field label={t('settings.general.checklist')} hint={t('settings.general.checklistHint')}>
              <textarea value={f.checklist} onChange={(e) => setForm({ ...f, checklist: e.target.value })} placeholder={t('settings.general.checklistPlaceholder')} />
            </Field>
          </section>

          <section className="card stack">
            <h3>{t('settings.general.publishing')}</h3>
            <div className="set-fields">
              <Field label={t('settings.general.lead')} hint={t('settings.general.leadHint')}>
                <input className="set-num-input" type="number" min={12} max={1440} value={f.lead} onChange={(e) => setForm({ ...f, lead: Number(e.target.value) })} />
              </Field>
              <Field label={t('settings.general.tolerance')} hint={t('settings.general.toleranceHint')}>
                <input className="set-num-input" type="number" min={0} max={240} value={f.tolerance} onChange={(e) => setForm({ ...f, tolerance: Number(e.target.value) })} />
              </Field>
            </div>
          </section>

          {save.error && <ErrorBox error={save.error} />}
          <div className="set-savebar">
            <button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? t('common.saving') : t('common.save')}</button>
            {form && <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>{t('settings.discard')}</button>}
            {form && <span className="muted small">{t('settings.unsaved')}</span>}
          </div>
        </form>
      )}

      {can('pause') && (
        <section className="card set-danger" aria-labelledby="danger-zone">
          <h3 id="danger-zone">{t('settings.general.danger')}</h3>
          <div className="set-danger-row">
            <div>
              <div className="row">
                <strong>{b.paused ? t('settings.general.pausedTitle') : t('settings.general.pauseTitle')}</strong>
                {b.paused && <Chip state="on_hold" label={t('settings.general.pausedChip')} />}
              </div>
              <p>{b.paused ? t('settings.general.pausedHint') : t('settings.general.pauseHint')}</p>
            </div>
            {b.paused ? (
              <button className="btn btn-primary" onClick={() => pause.mutate(false)} disabled={pause.isPending}>{t('settings.general.resume')}</button>
            ) : (
              <button className="btn btn-danger" onClick={() => confirm(t('settings.general.pauseConfirm', { brand: b.name })) && pause.mutate(true)} disabled={pause.isPending}>{t('settings.general.pause')}</button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

// ───────────────────────────── members ─────────────────────────────

interface Member { id: string; role: Role; user_id: string; email: string; name: string | null; second_factor: boolean }

function Members({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useSession();
  const { data, error } = useQuery({ queryKey: ['members', brandId], queryFn: () => api.get<Member[]>(`/api/brands/${brandId}/members`) });
  const [form, setForm] = useState({ email: '', name: '', role: 'reviewer' as Role });
  const refresh = () => qc.invalidateQueries({ queryKey: ['members', brandId] });
  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/members`, { email: form.email, name: form.name || undefined, role: form.role }),
    onSuccess: () => { refresh(); setForm({ email: '', name: '', role: 'reviewer' }); toast(t('settings.members.added')); },
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/api/brands/${brandId}/members/${id}`, { role }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['me'] }); toast(t('settings.members.roleChanged')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/members/${id}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post(`/api/brands/${brandId}/members/${id}/reset-2fa`),
    onSuccess: () => { refresh(); toast(t('settings.members.resetDone')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>{data ? t('settings.members.count', { count: data.length }) : t('settings.members.title')}</h3>
        </div>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Spinner />}
        {data && (
          <div className="table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th>{t('settings.members.person')}</th>
                  <th>{t('settings.members.role')}</th>
                  <th>{t('settings.members.secondFactor')}</th>
                  <th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.map((m) => {
                  const isMe = m.user_id === me.user.id;
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="set-person">
                          <span className="avatar" aria-hidden="true">{initials(m.name ?? m.email)}</span>
                          <div className="grow">
                            <div className="set-person-name">{m.name ?? m.email}{isMe && <span className="tag">{t('settings.members.you')}</span>}</div>
                            {m.name && <div className="muted small">{m.email}</div>}
                          </div>
                        </div>
                      </td>
                      <td data-label={t('settings.members.role')}>
                        <select className="set-inline-select" aria-label={t('settings.members.roleOf', { email: m.email })} value={m.role} onChange={(e) => change.mutate({ id: m.id, role: e.target.value as Role })}>
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </td>
                      <td data-label={t('settings.members.secondFactor')}>
                        {m.second_factor ? <Chip state="approved" label={t('settings.members.2faOn')} /> : <Chip state="draft" label={t('settings.members.2faOff')} />}
                      </td>
                      <td className="set-actions">
                        <div className="row">
                          {m.second_factor && !isMe && (
                            <button className="btn btn-small" title={t('settings.members.resetHint')} onClick={() => confirm(t('settings.members.resetConfirm', { email: m.email })) && reset.mutate(m.id)}>{t('settings.members.reset')}</button>
                          )}
                          <button className="btn btn-small btn-danger set-quiet" onClick={() => confirm(t('settings.members.removeConfirm', { email: m.email })) && remove.mutate(m.id)}>{t('settings.members.remove')}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="set-card-head">
          <div>
            <h3>{t('settings.members.addTitle')}</h3>
            <p className="set-hint">{t('settings.members.addHint')}</p>
          </div>
        </div>
        <div className="set-fields">
          <Field label={t('settings.members.email')}><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={`${t('settings.members.name')} ${t('common.optional')}`}><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('settings.members.role')}>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          </Field>
        </div>
        <p className="set-hint"><strong>{ROLE_LABEL[form.role]}:</strong> {t(`settings.role.${form.role}` as Key)} {t('settings.members.otherBrands')}</p>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending}>{t('settings.members.add')}</button></div>
      </form>
    </>
  );
}

// ───────────────────────────── accounts ─────────────────────────────

const providerLabel = (p: Pick<Provider, 'id' | 'label'>) => tMaybe(`settings.provider.${p.id}`, p.label);

function ConnectionDialog({ brandId, pendingId, onClose }: { brandId: string; pendingId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['pending', pendingId], queryFn: () => api.get<PendingConnection>(`/api/brands/${brandId}/connections/${pendingId}`) });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const reconnect = data?.reconnect ?? null;
  const usable = (data?.candidates ?? []).filter((c) => !reconnect || c.network === reconnect.network);
  const chosen = picked ?? new Set(reconnect || usable.length === 1 ? usable.slice(0, 1).map((c) => c.key) : []);
  const select = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/connections/${pendingId}/select`, { keys: [...chosen] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts', brandId] });
      toast(reconnect ? t('settings.accounts.reconnected') : t('settings.accounts.connectedToast'));
      onClose();
    },
  });
  const toggle = (key: string) => {
    if (reconnect) return setPicked(new Set([key]));
    const n = new Set(chosen);
    if (n.has(key)) n.delete(key); else n.add(key);
    setPicked(n);
  };
  return (
    <Dialog title={reconnect ? t('settings.accounts.reconnectTitle', { name: reconnect.display_name }) : t('settings.accounts.chooseTitle')} onClose={onClose}>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); select.mutate(); }}>
          <p className="muted" style={{ margin: 0 }}>{reconnect ? t('settings.accounts.chooseSame') : t('settings.accounts.chooseHint')}</p>
          {usable.length === 0 && <div className="notice notice-warn">{t('settings.accounts.noMatch')}</div>}
          {usable.map((c) => (
            <label key={c.key} className="check">
              <input type={reconnect ? 'radio' : 'checkbox'} name="candidate" checked={chosen.has(c.key)} onChange={() => toggle(c.key)} />
              <span>
                <strong>{NETWORK_LABEL[c.network] ?? c.network}</strong> · {c.displayName}
                {c.existing && <span className="muted small"> · {t('settings.accounts.alreadyHere')}</span>}
                {c.providerData.missingScopes && c.providerData.missingScopes.length > 0 && (
                  <span className="small set-warn" style={{ display: 'block' }}>{t('settings.accounts.missingScopesFail', { scopes: c.providerData.missingScopes.join(', ') })}</span>
                )}
              </span>
            </label>
          ))}
          {select.error && <ErrorBox error={select.error} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={chosen.size === 0 || select.isPending}>
              {reconnect ? t('settings.accounts.reconnect') : chosen.size > 1 ? t('settings.accounts.connectN', { count: chosen.size }) : t('settings.accounts.connect')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** For a network with no sign-in page: the person types what it asks for (Bluesky's handle and an app password). */
function CredentialsDialog({ brandId, provider, reconnect, onClose, onDone }: {
  brandId: string;
  provider: Provider;
  reconnect?: Account;
  onClose: () => void;
  onDone: (pendingId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const go = useMutation({
    mutationFn: () => api.post<{ pendingId: string }>(`/api/brands/${brandId}/connections/${provider.id}/credentials`, { values, reconnectAccountId: reconnect?.id }),
    onSuccess: (r) => onDone(r.pendingId),
  });
  const name = providerLabel(provider);
  return (
    <Dialog title={reconnect ? t('settings.accounts.reconnectTitle', { name: reconnect.display_name }) : t('settings.accounts.connectProvider', { name })} onClose={onClose}>
      <form className="stack" autoComplete="off" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <p className="muted" style={{ margin: 0 }}>{t('settings.accounts.credentialsHint', { name })}</p>
        {provider.fields.map((f) => (
          <Field key={f.key} label={tMaybe(`settings.cred.${provider.id}.${f.key}`, f.label)} hint={f.help && tMaybe(`settings.cred.${provider.id}.${f.key}.help`, f.help)}>
            <input
              type={f.type} name={f.key} required={f.required !== false} autoComplete={f.type === 'password' ? 'new-password' : 'off'}
              value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </Field>
        ))}
        {go.error && <ErrorBox error={go.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={go.isPending}>{go.isPending ? t('settings.accounts.checking') : t('settings.accounts.continue')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Networks that hold posts back until they have reviewed the app: what ticking the box means for each. */
const APPROVAL_NETWORKS = ['youtube', 'tiktok', 'pinterest'];

function AccountState({ a }: { a: Account }) {
  if (a.status === 'reconnect_required') return <Chip state="failed" label={t('settings.accounts.state.reconnect')} />;
  if (a.status === 'manual' || !a.connected) return <Chip state="draft" label={t('settings.accounts.state.manual')} />;
  return <Chip state="approved" label={t('settings.accounts.state.connected')} />;
}

function Accounts({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const pendingId = params.get('connection');
  const connectError = params.get('connect_error');
  const { data, error } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const { data: integ } = useQuery({ queryKey: ['integrations', brandId], queryFn: () => api.get<Integrations>(`/api/brands/${brandId}/integrations`) });
  const [form, setForm] = useState({ network: 'instagram', externalId: '', displayName: '' });
  const [typing, setTyping] = useState<{ provider: Provider; reconnect?: Account } | null>(null);
  const [checking, setChecking] = useState<Account | 'server' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounts', brandId] });
  const openPicker = (pendingId: string) => { const p = new URLSearchParams(params); p.set('connection', pendingId); setParams(p, { replace: true }); setTyping(null); };
  /** A sign-in page takes the browser away; a form opens here. */
  const start = (provider: Provider, account?: Account) => {
    if (provider.signIn === 'credentials') setTyping({ provider, reconnect: account });
    else connect.mutate({ provider: provider.id, accountId: account?.id });
  };
  const clearParams = () => { const p = new URLSearchParams(params); p.delete('connection'); p.delete('connect_error'); setParams(p, { replace: true }); };

  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/accounts`, form),
    onSuccess: () => { refresh(); setForm({ ...form, externalId: '', displayName: '' }); toast(t('settings.accounts.manualAdded')); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/accounts/${id}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const connect = useMutation({
    mutationFn: ({ provider, accountId }: { provider: string; accountId?: string }) =>
      api.post<{ url: string }>(`/api/brands/${brandId}/connections/${provider}`, accountId ? { reconnectAccountId: accountId } : {}),
    // The network's own sign-in page takes over the browser; it sends the person back to this page.
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.post(`/api/brands/${brandId}/accounts/${id}/disconnect`),
    onSuccess: () => { refresh(); toast(t('settings.accounts.disconnected')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const audited = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => api.patch(`/api/brands/${brandId}/accounts/${id}`, { audited: value }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const providerOf = (network: string) => integ?.providers.find((p) => p.networks.includes(network));
  const needs = data?.filter((a) => a.status === 'reconnect_required').length ?? 0;

  return (
    <>
      {connectError && (
        <div className="notice notice-bad" role="alert">
          <div className="row-between"><span>{t('settings.accounts.connectError', { error: connectError })}</span><button className="btn btn-small" onClick={clearParams}>{t('settings.dismiss')}</button></div>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h3>{data && data.length > 0 ? t('settings.accounts.count', { count: data.length }) : t('settings.accounts.title')}</h3>
          {needs > 0 && <Chip state="failed" label={t('settings.accounts.needsCount', { count: needs })} />}
        </div>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Spinner />}
        {data?.length === 0 && <Empty title={t('settings.accounts.empty')}>{t('settings.accounts.emptyHint')}</Empty>}
        {data && data.length > 0 && (
          <ul className="ent-list">
            {data.map((a) => {
              const provider = providerOf(a.network);
              const network = NETWORK_LABEL[a.network] ?? a.network;
              const handle = a.details.username ? `@${a.details.username.replace(/^@/, '')}` : a.external_id;
              const approval = APPROVAL_NETWORKS.includes(a.network) && a.connected;
              const notes: ReactNode[] = [];
              if (a.status === 'active' && a.connected && !a.automated) notes.push(<span key="auto" className="muted">{t('settings.accounts.notAutomated', { network })}</span>);
              if (a.details.missingScopes && a.details.missingScopes.length > 0) notes.push(<span key="scopes" className="set-warn">{t('settings.accounts.missingScopes', { scopes: a.details.missingScopes.join(', ') })}</span>);
              if (a.last_error && a.status === 'reconnect_required') notes.push(<span key="err" className="set-bad">{a.last_error}</span>);
              if (a.details.dataAccessExpiresAt) notes.push(<span key="exp" className="muted">{t('settings.accounts.accessUntil', { date: fmtDay(a.details.dataAccessExpiresAt) })}</span>);
              if (approval) {
                notes.push(
                  <label key="aud" className="check">
                    <input type="checkbox" checked={!!a.details.audited} onChange={(e) => audited.mutate({ id: a.id, value: e.target.checked })} />
                    <span>{t(`settings.accounts.approval.${a.network}` as Key)}{!a.details.audited && <span className="muted"> · {t(`settings.accounts.approvalUntil.${a.network}` as Key)}</span>}</span>
                  </label>,
                );
              }
              return (
                <li key={a.id} className="ent">
                  <span className="net net-lg" aria-hidden="true">{NET_SHORT[a.network] ?? a.network.slice(0, 2).toUpperCase()}</span>
                  <div className="ent-main">
                    <div className="ent-title">{a.display_name}</div>
                    <div className="ent-sub">{network} · <span className="mono">{handle}</span>{a.last_health_at && a.status === 'active' && a.connected && <> · {t('settings.accounts.checked', { when: fmtShort(a.last_health_at) })}</>}</div>
                  </div>
                  <div className="ent-side">
                    <AccountState a={a} />
                    <div className="ent-actions">
                      {a.connected && <button className="btn btn-small" onClick={() => setChecking(a)}>{t('settings.accounts.check')}</button>}
                      {provider?.configured && (a.status !== 'active' || !a.connected) && (
                        <button className={`btn btn-small ${a.status === 'reconnect_required' ? 'btn-primary' : ''}`} onClick={() => start(provider, a)}>
                          {a.status === 'manual' ? t('settings.accounts.connect') : t('settings.accounts.reconnect')}
                        </button>
                      )}
                      {a.connected && a.status === 'active' && provider?.configured && (
                        <button className="btn btn-small" onClick={() => start(provider, a)}>{t('settings.accounts.renew')}</button>
                      )}
                      {(a.connected || provider?.configured) && <span className="ent-sep" aria-hidden="true" />}
                      {a.connected ? (
                        <button className="btn btn-small btn-danger set-quiet" onClick={() => confirm(t('settings.accounts.disconnectConfirm', { name: a.display_name, network })) && disconnect.mutate(a.id)}>{t('settings.accounts.disconnect')}</button>
                      ) : (
                        <button className="btn btn-small btn-danger set-quiet" onClick={() => confirm(t('settings.accounts.removeConfirm', { name: a.display_name, network })) && remove.mutate(a.id)}>{t('settings.accounts.remove')}</button>
                      )}
                    </div>
                  </div>
                  {notes.length > 0 && <div className="ent-notes">{notes}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card stack">
        <div className="set-card-head">
          <div>
            <h3>{t('settings.accounts.connectTitle')}</h3>
            <p className="set-hint">{t('settings.accounts.connectHint')}</p>
          </div>
          <button className="btn btn-small" onClick={() => setChecking('server')}>{t('settings.accounts.serverReady')}</button>
        </div>
        <div className="set-providers">
          {integ?.providers.map((p) => (
            <button key={p.id} className="btn set-provider" disabled={!p.configured || connect.isPending} onClick={() => start(p)} title={p.configured ? undefined : t('settings.accounts.notConfigured')}>
              <span className="nets" aria-hidden="true">{p.networks.map((n) => <span key={n} className="net">{NET_SHORT[n] ?? n.slice(0, 2).toUpperCase()}</span>)}</span>
              {t('settings.accounts.connectProvider', { name: providerLabel(p) })}
            </button>
          ))}
        </div>
        {integ?.providers.some((p) => !p.configured) && <p className="set-hint">{t('settings.accounts.notConfiguredHint')}</p>}
      </section>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="set-card-head">
          <div>
            <h3>{t('settings.accounts.manualTitle')}</h3>
            <p className="set-hint">{t('settings.accounts.manualHint')}</p>
          </div>
        </div>
        <div className="set-fields">
          <Field label={t('settings.accounts.network')}>
            <select value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })}>{Object.keys(NET_SHORT).map((k) => <option key={k} value={k}>{NETWORK_LABEL[k]}</option>)}</select>
          </Field>
          <Field label={t('settings.accounts.displayName')}><input type="text" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label={t('settings.accounts.handle')}><input type="text" required value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} /></Field>
        </div>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending}>{t('settings.accounts.add')}</button></div>
      </form>

      {pendingId && <ConnectionDialog brandId={brandId} pendingId={pendingId} onClose={clearParams} />}
      {checking === 'server' && <ServerCheckDialog brandId={brandId} onClose={() => setChecking(null)} />}
      {checking && checking !== 'server' && <AccountCheckDialog brandId={brandId} account={checking} onClose={() => setChecking(null)} />}
      {typing && <CredentialsDialog brandId={brandId} provider={typing.provider} reconnect={typing.reconnect} onClose={() => setTyping(null)} onDone={openPicker} />}
    </>
  );
}

// ───────────────────────────── calendar: slots and blocked dates ─────────────────────────────

interface Slot { id: string; weekday: number; local_time: string; label: string; network: string; account_name: string }

function Schedule({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { brand } = useSession();
  const { data: accounts } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const { data: slots, error } = useQuery({ queryKey: ['slots', brandId], queryFn: () => api.get<Slot[]>(`/api/brands/${brandId}/slots`) });
  const { data: blocked } = useQuery({ queryKey: ['blocked', brandId], queryFn: () => api.get<{ day: string; reason: string }[]>(`/api/brands/${brandId}/blocked-dates`) });
  const [form, setForm] = useState({ accountId: '', weekday: 2, localTime: '19:00', label: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['slots', brandId] }); qc.invalidateQueries({ queryKey: ['calendar'] }); };
  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/slots`, { ...form, accountId: form.accountId || accounts?.[0]?.id }),
    onSuccess: () => { refresh(); setForm({ ...form, label: '' }); toast(t('settings.schedule.added')); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/brands/${brandId}/slots/${id}`), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'error') });
  const unblock = useMutation({
    mutationFn: (day: string) => api.del(`/api/brands/${brandId}/blocked-dates/${day}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['blocked', brandId] }); qc.invalidateQueries({ queryKey: ['calendar'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const sorted = [...(slots ?? [])].sort((a, b) => a.weekday - b.weekday || a.local_time.localeCompare(b.local_time));
  return (
    <>
      <section className="card">
        <div className="set-card-head" style={{ marginBottom: '.85rem' }}>
          <div>
            <h3>{t('settings.schedule.slots')}</h3>
            <p className="set-hint">{t('settings.schedule.slotsHint', { zone: brand.timezone })}</p>
          </div>
        </div>
        {error && <ErrorBox error={error} />}
        {slots?.length === 0 && <Empty title={t('settings.schedule.noSlots')}>{t('settings.schedule.noSlotsHint')}</Empty>}
        {sorted.length > 0 && (
          <div className="table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th>{t('settings.schedule.day')}</th>
                  <th>{t('settings.schedule.time')}</th>
                  <th>{t('settings.schedule.account')}</th>
                  <th>{t('settings.schedule.label')}</th>
                  <th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{weekdayName(s.weekday)}</strong></td>
                    <td className="mono" data-label={t('settings.schedule.time')}>{s.local_time.slice(0, 5)}</td>
                    <td data-label={t('settings.schedule.account')}>
                      <span className="row" style={{ gap: '.45rem', flexWrap: 'nowrap' }}>
                        <span className="net" aria-hidden="true">{NET_SHORT[s.network] ?? s.network.slice(0, 2).toUpperCase()}</span>
                        <span>{s.account_name} <span className="muted small">· {NETWORK_LABEL[s.network] ?? s.network}</span></span>
                      </span>
                    </td>
                    <td data-label={t('settings.schedule.label')}>{s.label || <span className="muted">{t('settings.schedule.noLabel')}</span>}</td>
                    <td className="set-actions">
                      <div className="row">
                        <button className="btn btn-small btn-danger set-quiet" onClick={() => confirm(t('settings.schedule.removeConfirm', { day: weekdayName(s.weekday), time: s.local_time.slice(0, 5) })) && remove.mutate(s.id)}>{t('settings.schedule.remove')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>{t('settings.schedule.addTitle')}</h3>
        {accounts?.length === 0 && <div className="notice notice-warn">{t('settings.schedule.needAccount')}</div>}
        <div className="set-fields">
          <Field label={t('settings.schedule.account')}>
            <select value={form.accountId || accounts?.[0]?.id || ''} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              {accounts?.map((a) => <option key={a.id} value={a.id}>{NETWORK_LABEL[a.network]} · {a.display_name}</option>)}
            </select>
          </Field>
          <Field label={t('settings.schedule.day')}>
            <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
            </select>
          </Field>
          <Field label={t('settings.schedule.time')}><input type="time" required value={form.localTime} onChange={(e) => setForm({ ...form, localTime: e.target.value })} /></Field>
          <Field label={`${t('settings.schedule.label')} ${t('common.optional')}`}><input type="text" placeholder={t('settings.schedule.labelPlaceholder')} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
        </div>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending || !accounts?.length}>{t('settings.schedule.add')}</button></div>
      </form>

      <section className="card">
        <div className="set-card-head" style={{ marginBottom: '.85rem' }}>
          <div>
            <h3>{t('settings.schedule.blocked')}</h3>
            <p className="set-hint">{t('settings.schedule.blockedHint')}</p>
          </div>
        </div>
        {blocked?.length === 0 && <p className="muted small" style={{ margin: 0 }}>{t('settings.schedule.noBlocked')}</p>}
        {blocked && blocked.length > 0 && (
          <div className="table-wrap">
            <table className="set-table">
              <thead><tr><th>{t('settings.schedule.date')}</th><th>{t('settings.schedule.reason')}</th><th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th></tr></thead>
              <tbody>
                {blocked.map((b) => (
                  <tr key={b.day}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDay(b.day)}</td>
                    <td data-label={t('settings.schedule.reason')}>{b.reason || <span className="muted">—</span>}</td>
                    <td className="set-actions"><div className="row"><button className="btn btn-small" onClick={() => unblock.mutate(b.day)}>{t('settings.schedule.unblock')}</button></div></td>
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

// ───────────────────────────── API tokens ─────────────────────────────

interface Token { id: string; name: string; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null }

function Tokens({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { brand } = useSession();
  const { data, error } = useQuery({ queryKey: ['tokens', brandId], queryFn: () => api.get<Token[]>(`/api/brands/${brandId}/tokens`) });
  const [form, setForm] = useState({ name: '', days: 90 });
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens', brandId] });
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/api/brands/${brandId}/tokens`, { name: form.name, expiresInDays: form.days }),
    onSuccess: (r) => { setShown(r.token); setForm({ name: '', days: 90 }); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/brands/${brandId}/tokens/${id}`), onSuccess: () => { refresh(); toast(t('settings.tokens.revokedToast')); }, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <>
      <section className="card">
        <div className="card-head"><h3>{data && data.length > 0 ? t('settings.tokens.count', { count: data.length }) : t('settings.tokens.title')}</h3></div>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Spinner />}
        {data?.length === 0 && <Empty title={t('settings.tokens.empty')}>{t('settings.tokens.emptyHint')}</Empty>}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th>{t('settings.tokens.name')}</th>
                  <th>{t('settings.tokens.state')}</th>
                  <th>{t('settings.tokens.expires')}</th>
                  <th>{t('settings.tokens.lastUsed')}</th>
                  <th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.map((tk) => {
                  const gone = !!tk.revoked_at || expired(tk.expires_at);
                  return (
                    <tr key={tk.id}>
                      <td><strong style={{ fontWeight: 500 }}>{tk.name}</strong><div className="muted small">{t('settings.tokens.created', { when: fmtShort(tk.created_at) })}</div></td>
                      <td data-label={t('settings.tokens.state')}>
                        {tk.revoked_at ? <Chip state="failed" label={t('settings.tokens.revoked')} /> : expired(tk.expires_at) ? <Chip state="draft" label={t('settings.tokens.expired')} /> : <Chip state="approved" label={t('settings.tokens.active')} />}
                      </td>
                      <td className="mono" data-label={t('settings.tokens.expires')}>{fmtDay(tk.expires_at)}</td>
                      <td data-label={t('settings.tokens.lastUsed')}>{tk.last_used_at ? <span title={fmtDateTime(tk.last_used_at, brand.timezone)}>{fmtShort(tk.last_used_at)}</span> : <span className="muted">{t('settings.tokens.never')}</span>}</td>
                      <td className="set-actions">
                        <div className="row">
                          {!gone && <button className="btn btn-small btn-danger set-quiet" onClick={() => confirm(t('settings.tokens.revokeConfirm', { name: tk.name })) && revoke.mutate(tk.id)}>{t('settings.tokens.revoke')}</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h3>{t('settings.tokens.newTitle')}</h3>
        <div className="set-fields">
          <Field label={t('settings.tokens.name')}><input type="text" required placeholder={t('settings.tokens.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('settings.tokens.days')}><input className="set-num-input" type="number" min={1} max={365} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} /></Field>
        </div>
        {create.error && <ErrorBox error={create.error} />}
        <div><button className="btn btn-primary" disabled={create.isPending}>{t('settings.tokens.create')}</button></div>
      </form>
      {shown && (
        <Dialog title={t('settings.tokens.copyTitle')} onClose={() => setShown(null)}>
          <p className="muted" style={{ margin: 0 }}>{t('settings.tokens.copyHint')}</p>
          <pre className="set-secret">{shown}</pre>
          <div className="row" style={{ justifyContent: 'flex-end' }}><CopyButton text={shown} label={t('settings.tokens.copy')} /><button className="btn btn-primary" onClick={() => setShown(null)}>{t('settings.done')}</button></div>
        </Dialog>
      )}
    </>
  );
}

// ───────────────────────────── audit log ─────────────────────────────

function Audit({ brandId, zone }: { brandId: string; zone: string }) {
  const { data, error } = useQuery({ queryKey: ['audit', brandId], queryFn: () => api.get<{ id: number; action: string; entity: string; at: string; actor: string | null; after: Record<string, unknown> | null }[]>(`/api/brands/${brandId}/audit?limit=200`) });
  return (
    <section className="card">
      <div className="card-head">
        <h3>{data && data.length > 0 ? t('settings.audit.count', { count: data.length }) : t('settings.audit.title')}</h3>
      </div>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <Empty title={t('settings.audit.empty')} />}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="set-table">
            <thead><tr><th>{t('settings.audit.when')}</th><th>{t('settings.audit.who')}</th><th>{t('settings.audit.what')}</th><th>{t('settings.audit.detail')}</th></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.at, zone)}</td>
                  <td data-label={t('settings.audit.who')}>{e.actor ?? <span className="muted">{t('settings.audit.system')}</span>}</td>
                  <td data-label={t('settings.audit.what')}><span className="tag">{e.action}</span></td>
                  <td data-label={t('settings.audit.detail')} className="muted mono"><div className="clip" title={e.after ? JSON.stringify(e.after) : undefined}>{e.after ? JSON.stringify(e.after) : ''}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── the page ─────────────────────────────

/** Which sections have something a person must look at, from data the sections load anyway (the same queries, so one request each). */
function useAttention(brandId: string, enabled: boolean): Partial<Record<Tab, 'bad'>> {
  const opts = { enabled, staleTime: 30_000 };
  const accounts = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`), ...opts });
  const hooks = useQuery({ queryKey: ['webhooks', brandId], queryFn: () => api.get<{ items: Webhook[] }>(`/api/brands/${brandId}/webhooks`), ...opts });
  const slack = useQuery({ queryKey: ['slack', brandId], queryFn: () => api.get<SlackSettings>(`/api/brands/${brandId}/slack`), ...opts });
  const out: Partial<Record<Tab, 'bad'>> = {};
  if (accounts.data?.some((a) => a.status === 'reconnect_required')) out.accounts = 'bad';
  if (hooks.data?.items.some((h) => (h.active && h.failed_24h > 0) || (!h.active && h.disabled_reason))) out.webhooks = 'bad';
  if (slack.data?.disabledReason) out.notifications = 'bad';
  return out;
}

export function SettingsPage() {
  const { brand, can } = useSession();
  const [search, setSearch] = useSearchParams();
  const nav = useRef<HTMLElement>(null);
  const groups: { label: Key; items: [Tab, boolean][] }[] = [
    { label: 'settings.group.brand', items: [['general', can('manage') || can('pause')], ['members', can('manage')], ['accounts', can('manage')], ['schedule', can('manage')]] },
    { label: 'settings.group.automation', items: [['agent', can('manage')], ['webhooks', can('manage')], ['prizes', can('manage')], ['notifications', can('manage')], ['tokens', can('manage')]] },
    { label: 'settings.group.control', items: [['audit', can('audit')]] },
  ];
  const visible = groups.flatMap((g) => g.items.filter(([, ok]) => ok).map(([k]) => k));
  const fromUrl = search.get('tab') as Tab | null;
  const current: Tab = fromUrl && visible.includes(fromUrl) ? fromUrl : (visible[0] ?? 'general');
  const attention = useAttention(brand.id, can('manage'));

  // On a narrow screen the sections are a strip that scrolls sideways: keep the open one in view, without moving the page.
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && nav.current && nav.current.scrollWidth > nav.current.clientWidth) nav.current.scrollTo({ left: el.offsetLeft - 16, behavior: 'smooth' });
  }, [current]);

  const open = (k: Tab) => {
    setSearch({ tab: k }, { replace: true });
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="muted">{t('settings.subtitle', { brand: brand.name })}</p>
        </div>
      </div>
      <div className="set">
        <nav ref={nav} className="set-nav" role="tablist" aria-orientation="vertical" aria-label={t('settings.sections')}>
          {groups.map((g) => {
            const items = g.items.filter(([, ok]) => ok);
            if (items.length === 0) return null;
            return [
              <div key={g.label} className="set-nav-group" aria-hidden="true">{t(g.label)}</div>,
              ...items.map(([k]) => (
                <button key={k} id={`tab-${k}`} role="tab" aria-selected={current === k} aria-controls="settings-panel" className="set-nav-item" onClick={() => open(k)}>
                  <span>{t(`settings.tab.${k}` as Key)}</span>
                  {attention[k] && (
                    <>
                      <span className="set-dot" aria-hidden="true" />
                      <span className="sr-only">{t('settings.needsAttention')}</span>
                    </>
                  )}
                </button>
              )),
            ];
          })}
        </nav>
        <div className="set-main" role="tabpanel" id="settings-panel" aria-labelledby={`tab-${current}`}>
          <header className="set-head">
            <div>
              <h2>{t(`settings.tab.${current}` as Key)}</h2>
              <p className="muted">{t(`settings.tabDesc.${current}` as Key)}</p>
            </div>
          </header>
          {current === 'general' && <General brandId={brand.id} />}
          {current === 'members' && <Members brandId={brand.id} />}
          {current === 'accounts' && <Accounts brandId={brand.id} />}
          {current === 'schedule' && <Schedule brandId={brand.id} />}
          {current === 'agent' && <AgentTab brandId={brand.id} />}
          {current === 'webhooks' && <Webhooks brandId={brand.id} />}
          {current === 'prizes' && <PrizesSettings brandId={brand.id} />}
          {current === 'notifications' && <SlackSettingsCard brandId={brand.id} />}
          {current === 'tokens' && <Tokens brandId={brand.id} />}
          {current === 'audit' && <Audit brandId={brand.id} zone={brand.timezone} />}
        </div>
      </div>
    </>
  );
}
