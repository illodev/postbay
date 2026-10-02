import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'luxon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Account, type BrandInvitation, type BrandSettings, type Integrations, type PendingConnection, type Provider, type Role, type SlackSettings, type Webhook } from '../api';
import { Avatar, displayName } from '../components/Avatar';
import { Icon } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { Chip, CopyButton, Dialog, ErrorBox, errorMessage, Field, MoreMenu, NetMark, Select, Skeleton, Spinner, Switch, Tip, useConfirm, useToast } from '../components/ui';
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
/** Built on use: the labels follow the language. */
const ROLE_OPTIONS = () => ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));

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
  const confirm = useConfirm();
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
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  // The brand's own zone is always offered, even when this browser's list spells it differently (UTC, Etc/…).
  const zones = known.includes(f.timezone) ? known : [f.timezone, ...known];
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
              <Field label={t('settings.general.timezone')}>
                <Select label={t('settings.general.timezone')} value={f.timezone} onChange={(z) => setForm({ ...f, timezone: z })} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} />
              </Field>
              <Field label={t('settings.general.locale')} hint={t('settings.general.localeHint')}>
                <input type="text" required maxLength={10} value={f.locale} onChange={(e) => setForm({ ...f, locale: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="card stack">
            <h3>{t('settings.general.rules')}</h3>
            <Field label={t('settings.general.required')} hint={t('settings.general.rulesHint')}>
              <input className="set-num-input" type="number" min={1} max={5} value={f.required} onChange={(e) => setForm({ ...f, required: Number(e.target.value) })} />
            </Field>
            <Switch label={t('settings.general.reapprove')} hint={t('settings.general.reapproveHint')} checked={f.reapprove} onChange={(v) => setForm({ ...f, reapprove: v })} />
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
              <button
                className="btn btn-danger"
                disabled={pause.isPending}
                onClick={async () => {
                  if (await confirm({ title: t('settings.general.pauseAsk', { brand: b.name }), text: t('settings.general.pauseConfirm'), confirmLabel: t('settings.general.pause'), danger: true })) pause.mutate(true);
                }}
              >
                {t('settings.general.pause')}
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

// ───────────────────────────── members ─────────────────────────────

interface Member { id: string; role: Role; user_id: string; email: string; name: string | null; second_factor: boolean; can_reset_second_factor?: boolean }

function Members({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const { data, error } = useQuery({ queryKey: ['members', brandId], queryFn: () => api.get<Member[]>(`/api/brands/${brandId}/members`) });
  const invitations = useQuery({ queryKey: ['invitations', brandId], queryFn: () => api.get<BrandInvitation[]>(`/api/brands/${brandId}/invitations`) });
  const [form, setForm] = useState({ email: '', name: '', role: 'reviewer' as Role });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members', brandId] });
    qc.invalidateQueries({ queryKey: ['invitations', brandId] });
  };
  const add = useMutation({
    mutationFn: () => api.post<{ invited: boolean }>(`/api/brands/${brandId}/members`, { email: form.email, name: form.name || undefined, role: form.role }),
    onSuccess: (r) => {
      refresh();
      // Someone who already works in another workspace is invited (202): they join only when they accept.
      toast(r.invited ? t('settings.members.invited', { email: form.email }) : t('settings.members.added'));
      setForm({ email: '', name: '', role: form.role });
    },
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/api/brands/${brandId}/members/${id}`, { role }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['me'] }); toast(t('settings.members.roleChanged')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/members/${id}`),
    onSuccess: () => { refresh(); toast(t('settings.members.removed')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post(`/api/brands/${brandId}/members/${id}/reset-2fa`),
    onSuccess: () => { refresh(); toast(t('settings.members.resetDone')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/invitations/${id}`),
    onSuccess: () => { refresh(); toast(t('settings.members.invitationCancelled')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const pending = invitations.data ?? [];
  return (
    <>
      <section className="card set-card" aria-labelledby="set-members">
        <header className="set-card-top">
          <h3 id="set-members">{data ? t('settings.members.count', { count: data.length }) : t('settings.members.title')}</h3>
        </header>
        {error && <ErrorBox error={error} />}
        {!data && !error && <ListSkeleton />}
        {data && (
          <ul className="ent-list">
            {data.map((m) => {
              const isMe = m.user_id === me.user.id;
              const who = displayName(m.name, m.email);
              // The server says who may reset whose authenticator (an admin of every brand that person is in, never their own).
              const canReset = m.second_factor && !isMe && m.can_reset_second_factor !== false;
              return (
                <li key={m.id} className="ent ent-person">
                  <Avatar name={m.name || m.email} size={32} />
                  <div className="ent-main">
                    <div className="ent-title">{who}{isMe && <span className="set-you">({t('settings.members.you')})</span>}</div>
                    <div className="ent-sub">{m.email}</div>
                  </div>
                  <div className="ent-side">
                    <span className={`set-2fa ${m.second_factor ? 'on' : ''}`} title={m.second_factor ? t('settings.members.2faOnHint') : t('settings.members.2faOffHint')}>
                      <Icon name="shield" />
                      <span>{m.second_factor ? t('settings.members.2faOn') : t('settings.members.2faOff')}</span>
                    </span>
                    <Select className="set-inline-select" label={t('settings.members.roleOf', { email: m.email })} value={m.role} onChange={(role) => change.mutate({ id: m.id, role })} options={ROLE_OPTIONS()} />
                    <MoreMenu
                      label={t('settings.members.actionsOf', { name: who })}
                      items={[
                        canReset && {
                          label: t('settings.members.reset'), icon: 'key',
                          onSelect: async () => {
                            if (await confirm({ title: t('settings.members.resetTitle', { name: who }), text: t('settings.members.resetConfirm', { email: m.email }), confirmLabel: t('settings.members.reset') })) reset.mutate(m.id);
                          },
                        },
                        {
                          label: t('settings.members.remove'), icon: 'trash', danger: true,
                          onSelect: async () => {
                            const text = isMe ? t('settings.members.removeSelfConfirm') : t('settings.members.removeConfirm', { email: m.email });
                            if (await confirm({ title: t('settings.members.removeTitle', { name: who }), text, confirmLabel: t('settings.members.remove'), danger: true })) remove.mutate(m.id);
                          },
                        },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {pending.length > 0 && (
        <section className="card set-card" aria-labelledby="set-invitations">
          <header className="set-card-top">
            <h3 id="set-invitations">{t('settings.members.pending')}</h3>
            <span className="set-count">{pending.length}</span>
          </header>
          <ul className="ent-list">
            {pending.map((i) => (
              <li key={i.id} className="ent ent-person">
                <Avatar name={i.email} size={32} />
                <div className="ent-main">
                  <div className="ent-title">{i.email}</div>
                  <div className="ent-sub">
                    {ROLE_LABEL[i.role]} · {t('settings.members.invitedWhen', { when: fmtShort(i.created_at) })}
                    {i.invited_by && <> · {t('settings.members.invitedBy', { who: displayName(null, i.invited_by) })}</>}
                    {' · '}{t('settings.members.expires', { date: fmtDay(i.expires_at) })}
                  </div>
                </div>
                <div className="ent-side">
                  <span className="chip chip-in_review">{t('settings.members.waiting')}</span>
                  <button
                    className="btn btn-small btn-ghost"
                    disabled={cancel.isPending}
                    onClick={async () => {
                      if (await confirm({ title: t('settings.members.cancelTitle'), text: t('settings.members.cancelConfirm', { email: i.email }), confirmLabel: t('settings.members.cancelInvitation'), danger: true })) cancel.mutate(i.id);
                    }}
                  >
                    {t('settings.members.cancelInvitation')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="card set-card" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} aria-labelledby="set-add-member">
        <header className="set-card-top">
          <h3 id="set-add-member" title={t('settings.members.addHint')}>{t('settings.members.addTitle')}</h3>
        </header>
        <div className="set-invite">
          <Field label={t('settings.members.email')}><input type="email" required placeholder={t('settings.members.emailPlaceholder')} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={`${t('settings.members.name')} ${t('common.optional')}`}><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('settings.members.role')}>
            <Select label={t('settings.members.role')} value={form.role} onChange={(role) => setForm({ ...form, role })} options={ROLE_OPTIONS()} />
          </Field>
          <button className="btn btn-primary" disabled={add.isPending}>{t('settings.members.add')}</button>
        </div>
        <p className="set-role-help"><strong>{ROLE_LABEL[form.role]}.</strong> {t(`settings.role.${form.role}` as Key)} {t('settings.members.otherBrands')}</p>
        {add.error && <ErrorBox error={add.error} />}
      </form>
    </>
  );
}

/** Rows that are loading: a circle and two lines each. */
function ListSkeleton({ rows = 3, square }: { rows?: number; square?: boolean }) {
  return (
    <ul className="ent-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="ent">
          <Skeleton width={32} height={32} radius={square ? 9 : 99} />
          <span className="ent-main stack" style={{ gap: 6 }}><Skeleton width="38%" /><Skeleton width="24%" height={10} /></span>
        </li>
      ))}
    </ul>
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
/** Networks whose comments reach the app through Meta's webhook, once the account is subscribed to it. */
const META_NETWORKS = ['instagram', 'facebook'];
/** Where the repository explains how to give this server each network's app (its credentials). */
const SETUP_DOCS = 'https://github.com/illodev/marketing/blob/HEAD/docs/phase-2.md#setting-up-the-networks';

function AccountState({ a }: { a: Account }) {
  if (a.status === 'reconnect_required') return <Chip state="failed" label={t('settings.accounts.state.reconnect')} />;
  if (a.status === 'manual' || !a.connected) return <Chip state="draft" label={t('settings.accounts.state.manual')} />;
  return <Chip state="approved" label={t('settings.accounts.state.connected')} />;
}

/** Whether Meta pushes this account's comments to the app, from what was written on the account when it was asked. */
function EventsState({ a }: { a: Account }) {
  const ev = a.details.events;
  if (!ev) return null;
  if (ev.subscribed) {
    return (
      <span className="set-note set-note-good" title={ev.fields?.length ? ev.fields.join(', ') : undefined}>
        <Icon name="check" />
        {t('settings.accounts.events.on')}
        {ev.at && <span className="set-note-when"> · {fmtShort(ev.at)}</span>}
      </span>
    );
  }
  return (
    <span className="set-note set-note-warn">
      <Icon name="bell" />
      <span>{t('settings.accounts.events.off')}{ev.note && <span className="set-note-why"> {ev.note}</span>}</span>
    </span>
  );
}

function Accounts({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
    onSuccess: () => { refresh(); toast(t('settings.accounts.removed')); },
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
  const settle = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { audited?: boolean; madeForKids?: boolean | null } }) => api.patch(`/api/brands/${brandId}/accounts/${id}`, body),
    onSuccess: () => { refresh(); toast(t('settings.saved')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const providerOf = (network: string) => integ?.providers.find((p) => p.networks.includes(network));
  const all = data ?? [];
  const connected = all.filter((a) => a.connected || a.status === 'reconnect_required');
  const manual = all.filter((a) => !connected.includes(a));
  const needs = connected.filter((a) => a.status === 'reconnect_required').length;
  const configured = integ?.providers.filter((p) => p.configured) ?? [];
  const unconfigured = integ?.providers.filter((p) => !p.configured) ?? [];

  const handleOf = (a: Account) => (a.details.username ? `@${a.details.username.replace(/^@/, '')}` : a.external_id);

  const connectedRow = (a: Account) => {
    const provider = providerOf(a.network);
    const network = NETWORK_LABEL[a.network] ?? a.network;
    const notes: ReactNode[] = [];
    if (a.status === 'active' && a.connected && !a.automated) notes.push(<span key="auto" className="set-note">{t('settings.accounts.notAutomated', { network })}</span>);
    if (a.details.missingScopes && a.details.missingScopes.length > 0) notes.push(<span key="scopes" className="set-note set-note-warn"><Icon name="key" />{t('settings.accounts.missingScopes', { scopes: a.details.missingScopes.join(', ') })}</span>);
    if (a.last_error && a.status === 'reconnect_required') notes.push(<span key="err" className="set-note set-note-bad">{a.last_error}</span>);
    if (a.details.dataAccessExpiresAt) notes.push(<span key="exp" className="set-note"><Icon name="clock" />{t('settings.accounts.accessUntil', { date: fmtDay(a.details.dataAccessExpiresAt) })}</span>);
    if (META_NETWORKS.includes(a.network) && a.connected) notes.push(<EventsState key="events" a={a} />);
    const controls: ReactNode[] = [];
    if (APPROVAL_NETWORKS.includes(a.network)) {
      controls.push(
        <Switch
          key="aud"
          checked={!!a.details.audited}
          disabled={settle.isPending}
          onChange={(v) => settle.mutate({ id: a.id, body: { audited: v } })}
          label={t(`settings.accounts.approval.${a.network}` as Key)}
          hint={a.details.audited ? undefined : t(`settings.accounts.approvalUntil.${a.network}` as Key)}
        />,
      );
    }
    if (a.network === 'youtube') controls.push(<KidsDefault key="kids" a={a} disabled={settle.isPending} onChange={(v) => settle.mutate({ id: a.id, body: { madeForKids: v } })} />);
    return (
      <li key={a.id} className="ent">
        <NetMark network={a.network} size="lg" />
        <div className="ent-main">
          <div className="ent-title">{a.display_name}</div>
          <div className="ent-sub">
            {network} · {handleOf(a)}
            {a.last_health_at && a.status === 'active' && a.connected && <> · {t('settings.accounts.checked', { when: fmtShort(a.last_health_at) })}</>}
          </div>
        </div>
        <div className="ent-side">
          <AccountState a={a} />
          {a.status === 'reconnect_required' && provider?.configured && (
            <button className="btn btn-small btn-primary" onClick={() => start(provider, a)}>{t('settings.accounts.reconnect')}</button>
          )}
          <MoreMenu
            label={t('settings.accounts.actionsOf', { name: a.display_name })}
            items={[
              a.connected && { label: t('settings.accounts.check'), icon: 'check', onSelect: () => setChecking(a) },
              provider?.configured && {
                label: a.status === 'reconnect_required' ? t('settings.accounts.reconnect') : t('settings.accounts.renew'), icon: 'refresh',
                onSelect: () => start(provider, a),
              },
              a.connected && {
                label: t('settings.accounts.disconnect'), icon: 'logout', danger: true,
                onSelect: async () => {
                  if (await confirm({ title: t('settings.accounts.disconnectTitle', { name: a.display_name }), text: t('settings.accounts.disconnectConfirm', { name: a.display_name, network }), confirmLabel: t('settings.accounts.disconnect'), danger: true })) disconnect.mutate(a.id);
                },
              },
            ]}
          />
        </div>
        {(notes.length > 0 || controls.length > 0) && (
          <div className="ent-notes">
            {notes}
            {controls.length > 0 && <div className="set-controls">{controls}</div>}
          </div>
        )}
      </li>
    );
  };

  const manualRow = (a: Account) => {
    const provider = providerOf(a.network);
    const network = NETWORK_LABEL[a.network] ?? a.network;
    return (
      <li key={a.id} className="ent">
        <NetMark network={a.network} size="lg" />
        <div className="ent-main">
          <div className="ent-title">{a.display_name}</div>
          <div className="ent-sub">{network} · {handleOf(a)}</div>
        </div>
        <div className="ent-side">
          {provider?.configured && <button className="btn btn-small" onClick={() => start(provider, a)}><Icon name="link" /><span>{t('settings.accounts.connect')}</span></button>}
          <MoreMenu
            label={t('settings.accounts.actionsOf', { name: a.display_name })}
            items={[
              {
                label: t('settings.accounts.removeFromBrand'), icon: 'trash', danger: true,
                onSelect: async () => {
                  if (await confirm({ title: t('settings.accounts.removeTitle', { name: a.display_name }), text: t('settings.accounts.removeConfirm', { name: a.display_name, network }), confirmLabel: t('settings.accounts.removeFromBrand'), danger: true })) remove.mutate(a.id);
                },
              },
            ]}
          />
        </div>
      </li>
    );
  };

  return (
    <>
      {connectError && (
        <div className="notice notice-bad" role="alert">
          <div className="row-between"><span>{t('settings.accounts.connectError', { error: connectError })}</span><button className="btn btn-small" onClick={clearParams}>{t('settings.dismiss')}</button></div>
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {!data && !error && <section className="card set-card"><ListSkeleton square /></section>}
      {data?.length === 0 && <p className="set-empty">{t('settings.accounts.empty')}</p>}

      {data && connected.length > 0 && (
        <section className="card set-card" aria-labelledby="set-acc-connected">
          <header className="set-card-top">
            <h3 id="set-acc-connected">{t('settings.accounts.groupConnected')}</h3>
            <span className="set-count">{connected.length}</span>
            {needs > 0 && <Chip state="failed" label={t('settings.accounts.needsCount', { count: needs })} />}
          </header>
          <ul className="ent-list">{connected.map(connectedRow)}</ul>
        </section>
      )}

      {data && manual.length > 0 && (
        <section className="card set-card" aria-labelledby="set-acc-manual">
          <header className="set-card-top">
            <h3 id="set-acc-manual">{t('settings.accounts.groupManual')}</h3>
            <span className="set-count">{manual.length}</span>
          </header>
          <p className="set-hint set-card-lead">{t('settings.accounts.groupManualHint')}</p>
          <ul className="ent-list">{manual.map(manualRow)}</ul>
        </section>
      )}

      <section className="card set-card" aria-labelledby="set-acc-connect">
        <header className="set-card-top">
          <h3 id="set-acc-connect" className="grow">{t('settings.accounts.connectTitle')}</h3>
          <button className="btn btn-small btn-ghost" onClick={() => setChecking('server')}>{t('settings.accounts.serverReady')}</button>
        </header>
        {integ && configured.length === 0 && (
          <div className="set-callout" style={{ marginTop: 12 }}>
            <Icon name="settings" />
            <div>
              <strong>{t('settings.accounts.noneConfigured')}</strong>
              <p>{t('settings.accounts.noneConfiguredHint')} <a href={SETUP_DOCS} target="_blank" rel="noreferrer">{t('settings.accounts.setupDocs')}<Icon name="external" /></a></p>
            </div>
          </div>
        )}
        {configured.length > 0 && (
          <div className="set-providers">
            {configured.map((p) => (
              <button key={p.id} className="btn set-provider" disabled={connect.isPending} onClick={() => start(p)}>
                <span className="nets" aria-hidden="true">{p.networks.map((n) => <NetMark key={n} network={n} size="sm" />)}</span>
                {t('settings.accounts.connectProvider', { name: providerLabel(p) })}
              </button>
            ))}
          </div>
        )}
        {configured.length > 0 && unconfigured.length > 0 && (
          <p className="set-hint" style={{ marginTop: 10 }}>
            {t('settings.accounts.someUnconfigured', { names: unconfigured.map(providerLabel).join(', ') })}{' '}
            <a href={SETUP_DOCS} target="_blank" rel="noreferrer">{t('settings.accounts.setupDocs')}<Icon name="external" /></a>
          </p>
        )}
      </section>

      <form className="card set-card" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} aria-labelledby="set-acc-manual-add">
        <header className="set-card-top">
          <h3 id="set-acc-manual-add" title={t('settings.accounts.manualHint')}>{t('settings.accounts.manualTitle')}</h3>
        </header>
        <div className="set-invite">
          <Field label={t('settings.accounts.network')}>
            <Select label={t('settings.accounts.network')} value={form.network} onChange={(network) => setForm({ ...form, network })} options={Object.keys(NETWORK_LABEL).map((k) => ({ value: k, label: NETWORK_LABEL[k]!, icon: <NetMark network={k} size="xs" /> }))} />
          </Field>
          <Field label={t('settings.accounts.displayName')}><input type="text" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label={t('settings.accounts.handle')}><input type="text" required value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} /></Field>
          <button className="btn btn-primary" disabled={add.isPending}>{t('settings.accounts.add')}</button>
        </div>
        {add.error && <ErrorBox error={add.error} />}
      </form>

      {pendingId && <ConnectionDialog brandId={brandId} pendingId={pendingId} onClose={clearParams} />}
      {checking === 'server' && <ServerCheckDialog brandId={brandId} onClose={() => setChecking(null)} />}
      {checking && checking !== 'server' && <AccountCheckDialog brandId={brandId} account={checking} onClose={() => setChecking(null)} />}
      {typing && <CredentialsDialog brandId={brandId} provider={typing.provider} reconnect={typing.reconnect} onClose={() => setTyping(null)} onDone={openPicker} />}
    </>
  );
}

/** YouTube asks, for every video, whether it is made for kids; a channel can start each new video from a default. */
function KidsDefault({ a, disabled, onChange }: { a: Account; disabled?: boolean; onChange: (v: boolean | null) => void }) {
  const value = a.details.madeForKids === undefined ? 'ask' : a.details.madeForKids ? 'yes' : 'no';
  return (
    <div className="set-control-row">
      <span className="switch-text">
        <span className="switch-label">{t('settings.accounts.kids')}</span>
        <span className="switch-hint">{t('settings.accounts.kidsHint')}</span>
      </span>
      <Select
        className="set-inline-select"
        label={t('settings.accounts.kids')}
        value={value}
        disabled={disabled}
        onChange={(v) => onChange(v === 'ask' ? null : v === 'yes')}
        options={[{ value: 'ask', label: t('settings.accounts.kidsAsk') }, { value: 'no', label: t('settings.accounts.kidsNo') }, { value: 'yes', label: t('settings.accounts.kidsYes') }]}
      />
    </div>
  );
}

// ───────────────────────────── calendar: slots and blocked dates ─────────────────────────────

interface Slot { id: string; weekday: number; local_time: string; label: string; network: string; account_name: string }

function Schedule({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
  // The week as columns: each day lists its slots in the order of the clock.
  const byDay = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, slots: sorted.filter((s) => s.weekday === d) }));
  const exampleAccount = accounts?.find((a) => a.network === 'instagram') ?? accounts?.[0];

  return (
    <>
      <section className="card set-card" aria-labelledby="set-grid">
        <header className="set-card-top">
          <h3 id="set-grid">{t('settings.schedule.slots')}</h3>
          {sorted.length > 0 && <span className="set-count">{sorted.length}</span>}
        </header>
        <p className="set-hint set-card-lead">{t('settings.schedule.slotsHint')}</p>
        {error && <ErrorBox error={error} />}
        {slots?.length === 0 && (
          <div className="set-example">
            <p className="set-example-label">{t('settings.schedule.example')}</p>
            <div className="set-slot set-slot-example" aria-hidden="true">
              <span className="set-slot-time">{weekdayName(2)} 19:00</span>
              {exampleAccount ? <NetMark network={exampleAccount.network} size="xs" /> : <NetMark network="instagram" size="xs" />}
              <span className="set-slot-label">{t('settings.schedule.labelPlaceholder')}</span>
            </div>
          </div>
        )}
        {sorted.length > 0 && (
          <div className="set-week" role="list" aria-label={t('settings.schedule.slots')}>
            {byDay.map(({ day, slots: list }) => (
              <div key={day} className="set-week-day" role="listitem">
                <div className="set-week-name">{weekdayName(day).slice(0, 3)}</div>
                {list.length === 0 && <div className="set-week-none" aria-hidden="true">—</div>}
                {list.map((sl) => (
                  <div key={sl.id} className="set-slot" title={`${weekdayName(sl.weekday)} ${sl.local_time.slice(0, 5)} · ${NETWORK_LABEL[sl.network] ?? sl.network} · ${sl.account_name}`}>
                    <div className="set-slot-top">
                      <span className="set-slot-time">{sl.local_time.slice(0, 5)}</span>
                      <NetMark network={sl.network} size="xs" />
                      <Tip label={t('settings.schedule.removeTitle')}>
                        <button
                          className="set-slot-x"
                          aria-label={t('settings.schedule.removeLabel', { day: weekdayName(sl.weekday), time: sl.local_time.slice(0, 5) })}
                          onClick={async () => {
                            if (await confirm({ title: t('settings.schedule.removeTitle'), text: t('settings.schedule.removeConfirm', { day: weekdayName(sl.weekday), time: sl.local_time.slice(0, 5) }), confirmLabel: t('settings.schedule.remove'), danger: true })) remove.mutate(sl.id);
                          }}
                        >
                          <Icon name="x" />
                        </button>
                      </Tip>
                    </div>
                    <span className={`set-slot-label ${sl.label ? '' : 'none'}`}>{sl.label || t('settings.schedule.noLabel')}</span>
                    <span className="set-slot-account">{sl.account_name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="set-hint set-zone"><Icon name="clock" />{t('settings.schedule.zone', { zone: brand.timezone })}</p>
      </section>

      <form className="card set-card" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} aria-labelledby="set-add-slot">
        <header className="set-card-top">
          <h3 id="set-add-slot">{t('settings.schedule.addTitle')}</h3>
        </header>
        {accounts?.length === 0 && <div className="notice notice-warn" style={{ margin: '10px 0 0' }}>{t('settings.schedule.needAccount')}</div>}
        <div className="set-invite set-invite-slot">
          <Field label={t('settings.schedule.day')}>
            <Select label={t('settings.schedule.day')} value={String(form.weekday)} onChange={(d) => setForm({ ...form, weekday: Number(d) })} options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: String(d), label: weekdayName(d) }))} />
          </Field>
          <Field label={t('settings.schedule.time')}><input type="time" required value={form.localTime} onChange={(e) => setForm({ ...form, localTime: e.target.value })} /></Field>
          <Field label={t('settings.schedule.account')}>
            <Select
              label={t('settings.schedule.account')}
              value={form.accountId || accounts?.[0]?.id}
              disabled={!accounts?.length}
              onChange={(accountId) => setForm({ ...form, accountId })}
              options={(accounts ?? []).map((a) => ({ value: a.id, label: a.display_name, icon: <NetMark network={a.network} size="xs" /> }))}
            />
          </Field>
          <Field label={t('settings.schedule.label')}><input type="text" placeholder={t('settings.schedule.labelPlaceholder')} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          <button className="btn btn-primary" disabled={add.isPending || !accounts?.length}>{t('settings.schedule.add')}</button>
        </div>
        <p className="set-hint" style={{ marginTop: 8 }}>{t('settings.schedule.labelHint')}</p>
        {add.error && <ErrorBox error={add.error} />}
      </form>

      <section className="card set-card" aria-labelledby="set-blocked">
        <header className="set-card-top">
          <h3 id="set-blocked" title={t('settings.schedule.blockedHint')}>{t('settings.schedule.blocked')}</h3>
          {blocked && blocked.length > 0 && <span className="set-count">{blocked.length}</span>}
        </header>
        {blocked?.length === 0 && <p className="set-empty">{t('settings.schedule.noBlocked')}</p>}
        {blocked && blocked.length > 0 && (
          <ul className="ent-list">
            {blocked.map((b) => (
              <li key={b.day} className="ent ent-compact">
                <span className="set-date">{fmtDay(b.day)}</span>
                <div className="ent-main"><div className="ent-title">{b.reason || <span className="muted">{t('settings.schedule.noReason')}</span>}</div></div>
                <div className="ent-side"><button className="btn btn-small btn-ghost" onClick={() => unblock.mutate(b.day)}>{t('settings.schedule.unblock')}</button></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ───────────────────────────── API tokens ─────────────────────────────

interface Token { id: string; name: string; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null; created_by_email?: string | null; created_by_name?: string | null }

function Tokens({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
      <section className="card set-card" aria-labelledby="set-tokens">
        <header className="set-card-top">
          <h3 id="set-tokens">{data && data.length > 0 ? t('settings.tokens.count', { count: data.length }) : t('settings.tokens.title')}</h3>
        </header>
        {error && <ErrorBox error={error} />}
        {!data && !error && <ListSkeleton square />}
        {data?.length === 0 && <p className="set-empty">{t('settings.tokens.empty')}</p>}
        {data && data.length > 0 && (
          <ul className="ent-list">
            {data.map((tk) => {
              const gone = !!tk.revoked_at || expired(tk.expires_at);
              const by = tk.created_by_email ? displayName(tk.created_by_name, tk.created_by_email) : null;
              return (
                <li key={tk.id} className={`ent ${gone ? 'ent-gone' : ''}`}>
                  <span className="set-token-icon" aria-hidden="true"><Icon name="key" /></span>
                  <div className="ent-main">
                    <div className="ent-title">{tk.name}</div>
                    <div className="ent-sub set-token-sub">
                      {by ? (
                        <span className="set-by" title={tk.created_by_email ?? undefined}>
                          <Avatar name={tk.created_by_name || tk.created_by_email} size={16} />
                          {t('settings.tokens.createdBy', { who: by, when: fmtShort(tk.created_at) })}
                        </span>
                      ) : (
                        <span>{t('settings.tokens.created', { when: fmtShort(tk.created_at) })}</span>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{tk.last_used_at ? <span title={fmtDateTime(tk.last_used_at, brand.timezone)}>{t('settings.tokens.usedWhen', { when: fmtShort(tk.last_used_at) })}</span> : t('settings.tokens.neverUsed')}</span>
                    </div>
                  </div>
                  <div className="ent-side">
                    {tk.revoked_at ? <Chip state="failed" label={t('settings.tokens.revoked')} /> : expired(tk.expires_at) ? <Chip state="draft" label={t('settings.tokens.expired')} /> : <Chip state="approved" label={t('settings.tokens.activeUntil', { date: fmtDay(tk.expires_at) })} />}
                    {!gone ? (
                      <MoreMenu
                        label={t('settings.tokens.actionsOf', { name: tk.name })}
                        items={[{
                          label: t('settings.tokens.revoke'), icon: 'ban', danger: true,
                          onSelect: async () => {
                            if (await confirm({ title: t('settings.tokens.revokeTitle', { name: tk.name }), text: t('settings.tokens.revokeConfirm', { name: tk.name }), confirmLabel: t('settings.tokens.revoke'), danger: true })) revoke.mutate(tk.id);
                          },
                        }]}
                      />
                    ) : <span className="menu-trigger-spacer" aria-hidden="true" />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <form className="card set-card" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} aria-labelledby="set-new-token">
        <header className="set-card-top">
          <h3 id="set-new-token" title={t('settings.tokens.newHint')}>{t('settings.tokens.newTitle')}</h3>
        </header>
        <div className="set-invite set-invite-token">
          <Field label={t('settings.tokens.name')}><input type="text" required placeholder={t('settings.tokens.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('settings.tokens.days')}><input type="number" min={1} max={365} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} /></Field>
          <button className="btn btn-primary" disabled={create.isPending}>{t('settings.tokens.create')}</button>
        </div>
        {create.error && <ErrorBox error={create.error} />}
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
      {data?.length === 0 && <p className="set-empty">{t('settings.audit.empty')}</p>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="set-table">
            <thead><tr><th>{t('settings.audit.when')}</th><th>{t('settings.audit.who')}</th><th>{t('settings.audit.what')}</th><th>{t('settings.audit.detail')}</th></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.at, zone)}</td>
                  <td data-label={t('settings.audit.who')}>
                    {e.actor ? <span className="set-by" title={e.actor}><Avatar name={e.actor} size={18} />{e.actor.includes('@') ? displayName(null, e.actor) : e.actor}</span> : <span className="muted">{t('settings.audit.system')}</span>}
                  </td>
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
      <PageBar crumbs={[{ label: t('settings.title'), to: '/settings' }, { label: t(`settings.tab.${current}` as Key) }]} />
      <div className="set">
        <nav ref={nav} className="set-nav" role="tablist" aria-orientation="vertical" aria-label={t('settings.sections')}>
          {groups.map((g) => {
            const items = g.items.filter(([, ok]) => ok);
            if (items.length === 0) return null;
            return [
              <div key={g.label} className="set-nav-group" aria-hidden="true">{t(g.label)}</div>,
              ...items.map(([k]) => (
                <Tip key={k} label={t(`settings.tabDesc.${k}` as Key)} side="right">
                  <button id={`tab-${k}`} role="tab" aria-selected={current === k} aria-controls="settings-panel" className="set-nav-item" onClick={() => open(k)}>
                    <span>{t(`settings.tab.${k}` as Key)}</span>
                    {attention[k] && (
                      <>
                        <span className="set-dot" aria-hidden="true" />
                        <span className="sr-only">{t('settings.needsAttention')}</span>
                      </>
                    )}
                  </button>
                </Tip>
              )),
            ];
          })}
        </nav>
        <div className="set-main" role="tabpanel" id="settings-panel" aria-labelledby={`tab-${current}`}>
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
