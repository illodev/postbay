import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Account, type BrandSettings, type Role } from '../api';
import { CopyButton, Dialog, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
import { fmtDateTime, NETWORK_LABEL, ROLE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';

type Tab = 'general' | 'members' | 'accounts' | 'schedule' | 'tokens' | 'audit';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ROLES: Role[] = ['admin', 'approver', 'reviewer', 'producer', 'reader'];
const ROLE_HELP: Record<Role, string> = {
  admin: 'Manages the brand, accounts, members and API tokens. Can do everything an approver can.',
  approver: 'Reviews, approves or rejects, schedules and moves dates, pauses the brand. Cannot approve what they uploaded.',
  reviewer: 'Views, comments, requests changes and resolves comments. Cannot approve or schedule.',
  producer: 'Creates pieces, uploads versions, replies to and resolves comments. Cannot approve or schedule.',
  reader: 'Views pieces, calendar and results. Cannot comment.',
};

function useBrandSettings(brandId: string) {
  return useQuery({ queryKey: ['brand', brandId], queryFn: () => api.get<BrandSettings>(`/api/brands/${brandId}`) });
}

function General({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: b } = useBrandSettings(brandId);
  const [form, setForm] = useState<null | { name: string; timezone: string; locale: string; required: number; reapprove: boolean; checklist: string }>(null);
  const f = form ?? (b && { name: b.name, timezone: b.timezone, locale: b.locale, required: b.rules.required_approvals, reapprove: b.rules.reapprove_on_move, checklist: b.rules.checklist.join('\n') });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/brands/${brandId}`, {
      name: f!.name, timezone: f!.timezone, locale: f!.locale,
      rules: { required_approvals: f!.required, reapprove_on_move: f!.reapprove, checklist: f!.checklist.split('\n').map((x) => x.trim()).filter(Boolean) },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['brand'] }); qc.invalidateQueries({ queryKey: ['me'] }); setForm(null); toast('Saved'); },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.post(`/api/brands/${brandId}/pause`, { paused }),
    onSuccess: (_d, paused) => { qc.invalidateQueries({ queryKey: ['brand'] }); qc.invalidateQueries({ queryKey: ['me'] }); toast(paused ? 'Brand paused' : 'Brand resumed'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!b || !f) return <Spinner />;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return (
    <div className="stack">
      {can('pause') && (
        <div className="card row-between">
          <div>
            <h3>Pause everything</h3>
            <p className="muted" style={{ margin: 0 }}>For a crisis: freezes what is scheduled without losing the dates. Nothing can be scheduled or moved while paused.</p>
          </div>
          <button className={`btn ${b.paused ? 'btn-primary' : 'btn-danger'}`} onClick={() => pause.mutate(!b.paused)} disabled={pause.isPending}>{b.paused ? 'Resume brand' : 'Pause brand'}</button>
        </div>
      )}
      {can('manage') && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <h3>Brand</h3>
          <Field label="Name"><input type="text" required value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} /></Field>
          <div className="row">
            <div className="grow">
              <Field label="Time zone" hint="IANA name, such as Europe/Madrid. Dates and slots follow it, including clock changes.">
                <input type="text" list="zones" required value={f.timezone} onChange={(e) => setForm({ ...f, timezone: e.target.value })} />
                <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              </Field>
            </div>
            <div style={{ width: 120 }}><Field label="Language"><input type="text" required maxLength={10} value={f.locale} onChange={(e) => setForm({ ...f, locale: e.target.value })} /></Field></div>
          </div>
          <h3>Approval rules</h3>
          <Field label="Approvals needed" hint="Different people who must approve a version before it counts. Whoever uploaded a version can never approve it.">
            <input type="number" min={1} max={5} value={f.required} onChange={(e) => setForm({ ...f, required: Number(e.target.value) })} style={{ maxWidth: 100 }} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={f.reapprove} onChange={(e) => setForm({ ...f, reapprove: e.target.checked })} />
            <span>Changing something already scheduled needs a second approver to confirm<br /><span className="muted small">Applies to moving the date and to editing the text.</span></span>
          </label>
          <Field label="Checklist" hint="One item per line. The approver ticks every item before approving.">
            <textarea value={f.checklist} onChange={(e) => setForm({ ...f, checklist: e.target.value })} placeholder={'Facts verified\nNo music we do not have rights to\nSubtitles reviewed'} />
          </Field>
          {save.error && <ErrorBox error={save.error} />}
          <div><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
        </form>
      )}
    </div>
  );
}

function Members({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useSession();
  const { data, error } = useQuery({ queryKey: ['members', brandId], queryFn: () => api.get<{ id: string; role: Role; user_id: string; email: string; name: string | null }[]>(`/api/brands/${brandId}/members`) });
  const [form, setForm] = useState({ email: '', name: '', role: 'reviewer' as Role });
  const refresh = () => qc.invalidateQueries({ queryKey: ['members', brandId] });
  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/members`, { email: form.email, name: form.name || undefined, role: form.role }),
    onSuccess: () => { refresh(); setForm({ email: '', name: '', role: 'reviewer' }); toast('Member added: they can sign in with their email'); },
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/api/brands/${brandId}/members/${id}`, { role }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['me'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/members/${id}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <div className="stack">
      <div className="card">
        {error && <ErrorBox error={error} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
            <tbody>
              {data?.map((m) => (
                <tr key={m.id}>
                  <td>{m.name ?? m.email}{m.name && <><br /><span className="muted small">{m.email}</span></>}{m.user_id === me.user.id && <span className="chip" style={{ marginLeft: 6 }}>you</span>}</td>
                  <td>
                    <select aria-label={`Role of ${m.email}`} value={m.role} onChange={(e) => change.mutate({ id: m.id, role: e.target.value as Role })} style={{ width: 'auto' }}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </td>
                  <td><button className="btn btn-small btn-danger" onClick={() => confirm(`Remove ${m.email} from this brand?`) && remove.mutate(m.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>Add a person</h3>
        <div className="row">
          <div className="grow"><Field label="Email"><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field></div>
          <div className="grow"><Field label="Name (optional)"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field></div>
          <div><Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field></div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{ROLE_HELP[form.role]} The same person can have a different role in another brand.</p>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending}>Add</button></div>
      </form>
    </div>
  );
}

function Accounts({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const [form, setForm] = useState({ network: 'instagram', externalId: '', displayName: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounts', brandId] });
  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/accounts`, form),
    onSuccess: () => { refresh(); setForm({ ...form, externalId: '', displayName: '' }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/accounts/${id}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <div className="stack">
      <div className="notice notice-info">For now accounts are registered by hand and someone publishes to them manually. Connecting them through each network's official API comes in a later phase.</div>
      <div className="card">
        {data?.length === 0 && <Empty title="No accounts yet" />}
        <div className="table-wrap">
          <table>
            <tbody>
              {data?.map((a) => (
                <tr key={a.id}>
                  <td><strong>{NETWORK_LABEL[a.network] ?? a.network}</strong></td>
                  <td>{a.display_name}<br /><span className="muted small">{a.external_id}</span></td>
                  <td><button className="btn btn-small btn-danger" onClick={() => confirm(`Remove ${a.display_name}?`) && remove.mutate(a.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>Add an account</h3>
        <div className="row">
          <div><Field label="Network"><select value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })}>{Object.entries(NETWORK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field></div>
          <div className="grow"><Field label="Display name"><input type="text" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field></div>
          <div className="grow"><Field label="Handle or ID"><input type="text" required value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} /></Field></div>
        </div>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending}>Add account</button></div>
      </form>
    </div>
  );
}

function Schedule({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: accounts } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const { data: slots } = useQuery({ queryKey: ['slots', brandId], queryFn: () => api.get<{ id: string; weekday: number; local_time: string; label: string; network: string; account_name: string }[]>(`/api/brands/${brandId}/slots`) });
  const { data: blocked } = useQuery({ queryKey: ['blocked', brandId], queryFn: () => api.get<{ day: string; reason: string }[]>(`/api/brands/${brandId}/blocked-dates`) });
  const [form, setForm] = useState({ accountId: '', weekday: 2, localTime: '19:00', label: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['slots', brandId] }); qc.invalidateQueries({ queryKey: ['calendar'] }); };
  const add = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/slots`, { ...form, accountId: form.accountId || accounts?.[0]?.id }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/brands/${brandId}/slots/${id}`), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'error') });
  const unblock = useMutation({
    mutationFn: (day: string) => api.del(`/api/brands/${brandId}/blocked-dates/${day}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['blocked', brandId] }); qc.invalidateQueries({ queryKey: ['calendar'] }); },
  });
  return (
    <div className="stack">
      <div className="card">
        <h3>Weekly slots</h3>
        <p className="muted">Fixed times when an account should post, in the brand's time zone. An empty slot shows up on the calendar as a request for content.</p>
        {slots?.length === 0 && <p className="muted">No slots yet.</p>}
        {slots?.map((s) => (
          <div key={s.id} className="version-row">
            <strong>{WEEKDAYS[s.weekday - 1]}s {s.local_time}</strong>
            <span className="grow muted">{s.label || 'Slot'} · {NETWORK_LABEL[s.network] ?? s.network} · {s.account_name}</span>
            <button className="btn btn-small btn-danger" onClick={() => remove.mutate(s.id)}>Remove</button>
          </div>
        ))}
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>Add a slot</h3>
        <div className="row">
          <div className="grow"><Field label="Account"><select value={form.accountId || accounts?.[0]?.id || ''} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>{accounts?.map((a) => <option key={a.id} value={a.id}>{NETWORK_LABEL[a.network]} · {a.display_name}</option>)}</select></Field></div>
          <div><Field label="Day"><select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></Field></div>
          <div><Field label="Time"><input type="time" required value={form.localTime} onChange={(e) => setForm({ ...form, localTime: e.target.value })} /></Field></div>
          <div className="grow"><Field label="Label"><input type="text" placeholder="Reels" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field></div>
        </div>
        {add.error && <ErrorBox error={add.error} />}
        <div><button className="btn btn-primary" disabled={add.isPending || !accounts?.length}>Add slot</button></div>
      </form>
      <div className="card">
        <h3>Blocked dates</h3>
        {blocked?.length === 0 && <p className="muted">No blocked dates. Approvers can block one from the calendar.</p>}
        {blocked?.map((b) => (
          <div key={b.day} className="version-row">
            <strong>{b.day}</strong><span className="grow muted">{b.reason}</span>
            <button className="btn btn-small" onClick={() => unblock.mutate(b.day)}>Unblock</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tokens({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['tokens', brandId], queryFn: () => api.get<{ id: string; name: string; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null }[]>(`/api/brands/${brandId}/tokens`) });
  const [form, setForm] = useState({ name: '', days: 90 });
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens', brandId] });
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/api/brands/${brandId}/tokens`, { name: form.name, expiresInDays: form.days }),
    onSuccess: (r) => { setShown(r.token); setForm({ name: '', days: 90 }); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/brands/${brandId}/tokens/${id}`), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'error') });
  return (
    <div className="stack">
      <div className="notice notice-info">A token lets an agent or a script produce for this brand: create pieces, upload versions and answer comments. It can never approve, schedule or change settings.</div>
      <div className="card">
        {data?.length === 0 && <p className="muted">No tokens yet.</p>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Expires</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {data?.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}{t.revoked_at && <span className="chip chip-failed" style={{ marginLeft: 6 }}>revoked</span>}</td>
                  <td>{fmtDateTime(t.expires_at, 'UTC').replace(/,.*/, '')}</td>
                  <td>{t.last_used_at ? fmtDateTime(t.last_used_at, 'UTC') : 'never'}</td>
                  <td>{!t.revoked_at && <button className="btn btn-small btn-danger" onClick={() => confirm(`Revoke ${t.name}? It stops working immediately.`) && revoke.mutate(t.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h3>New token</h3>
        <div className="row">
          <div className="grow"><Field label="Name"><input type="text" required placeholder="Video agent" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field></div>
          <div style={{ width: 150 }}><Field label="Valid for (days)"><input type="number" min={1} max={365} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} /></Field></div>
        </div>
        {create.error && <ErrorBox error={create.error} />}
        <div><button className="btn btn-primary" disabled={create.isPending}>Create token</button></div>
      </form>
      {shown && (
        <Dialog title="Copy your token now" onClose={() => setShown(null)}>
          <p className="muted">This is the only time it is shown. It is stored as a hash, so nobody (including us) can read it again.</p>
          <pre className="card mono" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{shown}</pre>
          <div className="row" style={{ justifyContent: 'flex-end' }}><CopyButton text={shown} label="Copy token" /><button className="btn btn-primary" onClick={() => setShown(null)}>Done</button></div>
        </Dialog>
      )}
    </div>
  );
}

function Audit({ brandId, zone }: { brandId: string; zone: string }) {
  const { data, error } = useQuery({ queryKey: ['audit', brandId], queryFn: () => api.get<{ id: number; action: string; entity: string; at: string; actor: string | null; after: Record<string, unknown> | null }[]>(`/api/brands/${brandId}/audit?limit=200`) });
  return (
    <div className="card">
      <p className="muted">Every approval, connection and publication attempt, newest first. It can only be added to, never edited.</p>
      {error && <ErrorBox error={error} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id}>
                <td className="small">{fmtDateTime(e.at, zone)}</td>
                <td>{e.actor ?? 'system'}</td>
                <td><span className="mono">{e.action}</span></td>
                <td className="muted small mono">{e.after ? JSON.stringify(e.after).slice(0, 120) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { brand, can } = useSession();
  const tabs: [Tab, string, boolean][] = [
    ['general', 'General', can('manage') || can('pause')],
    ['members', 'People', can('manage')],
    ['accounts', 'Accounts', can('manage')],
    ['schedule', 'Slots & dates', can('manage')],
    ['tokens', 'API tokens', can('manage')],
    ['audit', 'Audit log', can('audit')],
  ];
  const visible = tabs.filter((t) => t[2]);
  const [tab, setTab] = useState<Tab>(visible[0]?.[0] ?? 'general');
  const current = visible.find((t) => t[0] === tab)?.[0] ?? visible[0]?.[0];
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p className="muted">{brand.name}</p></div></div>
      <div className="tabs" role="tablist" style={{ overflowX: 'auto' }}>
        {visible.map(([k, label]) => <button key={k} role="tab" aria-selected={current === k} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {current === 'general' && <General brandId={brand.id} />}
      {current === 'members' && <Members brandId={brand.id} />}
      {current === 'accounts' && <Accounts brandId={brand.id} />}
      {current === 'schedule' && <Schedule brandId={brand.id} />}
      {current === 'tokens' && <Tokens brandId={brand.id} />}
      {current === 'audit' && <Audit brandId={brand.id} zone={brand.timezone} />}
    </>
  );
}
