import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useResolvedPath, useSearchParams } from 'react-router-dom';
import { api, type NotificationItem, type PieceSummary } from '../api';
import { LOCALES, t, tMaybe, useLocale, type Locale } from '../i18n';
import { fmtShort } from '../lib/format';
import { useSession } from '../lib/session';
import { Avatar, displayName } from './Avatar';
import { PaletteProvider, usePalette } from './CommandPalette';
import { Icon, type IconName } from './icons';
import { Dialog, ErrorBox, Field, Menu, MenuItem, MenuLabel, MenuSeparator, Popover, Select, Tip, useToast, errorMessage } from './ui';

export interface Campaign {
  id: string;
  name: string;
}

function RailLink({ to, icon, label, end, dot }: { to: string; icon: IconName; label: string; end?: boolean; dot?: boolean }) {
  // A plain Link with the class worked out here: the tooltip's trigger merges classes as strings, and NavLink's is a function.
  const active = !!useMatch({ path: useResolvedPath(to).pathname, end: !!end });
  return (
    <Tip label={label} side="right">
      <Link to={to} className={`rail-btn ${active ? 'active' : ''}`} aria-label={label} aria-current={active ? 'page' : undefined}>
        <Icon name={icon} />
        {dot && <span className="rail-dot" />}
      </Link>
    </Tip>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: NotificationItem[]; unread: number }>('/api/notifications'),
    refetchInterval: 30_000,
  });
  const unread = data?.unread ?? 0;
  const readAll = async () => {
    await api.post('/api/notifications/read', {});
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="right"
      align="start"
      width={380}
      label={t('notif.title')}
      trigger={
        <button className="rail-btn" aria-label={unread ? t('notif.buttonUnread', { count: unread }) : t('notif.button')}>
          <Icon name="bell" />
          {unread > 0 && <span className="rail-dot" />}
        </button>
      }
    >
      <div className="card-head" style={{ padding: '.35rem .4rem 0' }}>
        <strong>{t('notif.title')}</strong>
        <button className="btn btn-small" onClick={readAll} disabled={!unread}>{t('notif.markAll')}</button>
      </div>
      {data?.items.length ? (
        data.items.slice(0, 20).map((n) => (
          <button
            key={n.id}
            className={`notif-item ${n.read_at ? '' : 'unread'}`}
            onClick={() => {
              setOpen(false);
              navigate(n.payload.pieceId ? `/pieces/${n.payload.pieceId}` : '/today');
            }}
          >
            <span style={{ fontWeight: n.read_at ? 400 : 600 }}>{tMaybe(`notif.kind.${n.kind}`, n.kind)}</span>
            {n.piece_title && <span className="muted"> · {n.piece_title}</span>}
            <br />
            <span className="muted small">{n.brand} · {fmtShort(n.created_at)}</span>
          </button>
        ))
      ) : (
        <p className="muted" style={{ padding: '.5rem .6rem' }}>{t('notif.empty')}</p>
      )}
    </Popover>
  );
}

function AccountMenu() {
  const { me } = useSession();
  const { locale, setLocale } = useLocale();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const name = displayName(me.user.name, me.user.email);
  const signOut = async () => {
    try {
      await api.post('/api/auth/logout');
      qc.clear();
      navigate('/login');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Menu
      side="right"
      align="end"
      width={260}
      trigger={
        <button className="rail-btn" aria-label={t('layout.account')}>
          <Avatar name={me.user.name ?? me.user.email} size={30} />
        </button>
      }
    >
      <div className="menu-who">
        <Avatar name={me.user.name ?? me.user.email} size={32} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{name}</div>
          <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.user.email}</div>
        </div>
      </div>
      <MenuSeparator />
      <MenuItem icon="user" onSelect={() => navigate('/security')}>{t('layout.account')}</MenuItem>
      <MenuLabel>{t('layout.language')}</MenuLabel>
      {LOCALES.map((l) => (
        <MenuItem key={l.value} icon="globe" checked={locale === l.value} onSelect={() => setLocale(l.value as Locale)}>{l.label}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon="logout" onSelect={signOut}>{t('layout.signOut')}</MenuItem>
    </Menu>
  );
}

function NewCampaign({ onClose }: { onClose: () => void }) {
  const { brand } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<Campaign>(`/api/brands/${brand.id}/campaigns`, { name }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['campaigns', brand.id] });
      navigate(`/pieces?campaign=${c.id}`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title={t('layout.newCampaign')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('layout.campaignName')}>
          <input type="text" required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>{t('common.create')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewBrand({ onClose }: { onClose: () => void }) {
  const { brand, setBrandId } = useSession();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const zones = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return [brand.timezone];
    }
  })();
  const [form, setForm] = useState({ name: '', timezone: brand.timezone, locale: locale as string });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/brands', { fromBrandId: brand.id, ...form }),
    onSuccess: async (b) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      setBrandId(b.id);
      navigate('/');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title={t('layout.newBrand')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>{t('layout.newBrandHint')}</p>
        <Field label={t('layout.brandName')}>
          <input type="text" required autoFocus maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('layout.brandTimezone')} hint={t('layout.brandTimezoneHint')}>
          <Select
            label={t('layout.brandTimezone')}
            value={form.timezone}
            onChange={(timezone) => setForm({ ...form, timezone })}
            options={(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((z) => ({ value: z, label: z }))}
          />
        </Field>
        <Field label={t('layout.brandLanguage')} hint={t('layout.brandLanguageHint')}>
          <Select
            label={t('layout.brandLanguage')}
            value={form.locale}
            onChange={(locale) => setForm({ ...form, locale })}
            options={LOCALES.map((l) => ({ value: l.value, label: l.label }))}
          />
        </Field>
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!form.name.trim() || create.isPending}>{t('layout.createBrand')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Smart collections: pieces gathered by what is happening to them, wherever they live. */
const COLLECTIONS: { key: string; param: string; colour: string; count?: (p: PieceSummary) => boolean }[] = [
  { key: 'in_review', param: 'state=in_review', colour: 'var(--warn)', count: (p) => p.review_state === 'in_review' },
  { key: 'agent', param: 'by=agent', colour: 'var(--agent)', count: (p) => !!p.latest_by_agent },
  { key: 'changes_requested', param: 'state=changes_requested', colour: 'var(--bad)', count: (p) => p.review_state === 'changes_requested' },
  { key: 'approved', param: 'state=approved', colour: 'var(--good)', count: (p) => p.review_state === 'approved' },
  { key: 'draft', param: 'state=draft', colour: 'var(--muted)', count: (p) => p.review_state === 'draft' },
];

function Sidebar() {
  const { me, brand, setBrandId, can } = useSession();
  const palette = usePalette();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [newBrand, setNewBrand] = useState(false);
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', brand.id], queryFn: () => api.get<Campaign[]>(`/api/brands/${brand.id}/campaigns`) });
  const { data: all } = useQuery({ queryKey: ['pieces', brand.id, '', ''], queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces`) });
  const live = (all ?? []).filter((p) => p.review_state !== 'discarded');
  const onPieces = location.pathname === '/pieces';
  const current = (q: string) => onPieces && [...new URLSearchParams(q)].every(([k, v]) => params.get(k) === v) && [...params.keys()].filter((k) => k !== 'view').length === [...new URLSearchParams(q)].length;
  const byCampaign = (id: string) => live.filter((p) => p.campaign_id === id).length;
  return (
    <aside className="sidebar" aria-label={t('layout.nav.main')}>
      <Menu
        align="start"
        width="var(--radix-dropdown-menu-trigger-width)"
        trigger={
          <button className="brand-switch">
            <span className="brand-mark" aria-hidden="true">{brand.name.slice(0, 1).toUpperCase()}</span>
            <span className="name">{brand.name}</span>
            <Icon name="chevronDown" />
          </button>
        }
      >
        <MenuLabel>{t('layout.brands')}</MenuLabel>
        {me.brands.map((b) => (
          <MenuItem
            key={b.id}
            lead={<span className="brand-mark brand-mark-sm" aria-hidden="true">{b.name.slice(0, 1).toUpperCase()}</span>}
            checked={b.id === brand.id}
            onSelect={() => { setBrandId(b.id); navigate('/'); }}
          >
            {b.name}
          </MenuItem>
        ))}
        {can('manage') && (
          <>
            <MenuSeparator />
            <MenuItem icon="plus" onSelect={() => setNewBrand(true)}>{t('layout.newBrand')}</MenuItem>
          </>
        )}
      </Menu>
      <button className="sb-search" onClick={palette.open}>
        <Icon name="search" /><span className="label">{t('common.search')}</span><span className="kbd">⌘K</span>
      </button>
      <nav className="nav">
        <NavLink to="/" end><Icon name="home" /><span className="label">{t('layout.nav.home')}</span></NavLink>
      </nav>
      <div className="sb-section">
        <span>{t('layout.nav.pieces')}</span>
        {can('createPiece') && <Tip label={t('layout.newCampaign')}><button onClick={() => setCreating(true)} aria-label={t('layout.newCampaign')}><Icon name="plus" /></button></Tip>}
      </div>
      <nav className="nav">
        <NavLink to="/pieces" className={() => (current('') ? 'active' : '')}><Icon name="pieces" /><span className="label">{t('layout.allPieces')}</span><span className="nav-count">{live.length || ''}</span></NavLink>
        {campaigns?.map((c) => (
          <NavLink key={c.id} to={`/pieces?campaign=${c.id}`} className={() => (current(`campaign=${c.id}`) ? 'active' : '')}>
            <Icon name="folder" /><span className="label">{c.name}</span><span className="nav-count">{byCampaign(c.id) || ''}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sb-section"><span>{t('layout.collections')}</span></div>
      <nav className="nav">
        {COLLECTIONS.map((c) => {
          const n = c.count ? live.filter(c.count).length : 0;
          return (
            <NavLink key={c.key} to={`/pieces?${c.param}`} className={() => (current(c.param) ? 'active' : '')}>
              <span className="coll-sq" style={{ color: c.colour }} aria-hidden="true" />
              <span className="label">{t(`layout.collection.${c.key}` as 'layout.collection.in_review')}</span>
              <span className="nav-count">{n || ''}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="sb-grow" />
      <nav className="nav">
        <NavLink to="/calendar"><Icon name="calendar" /><span className="label">{t('layout.nav.calendar')}</span></NavLink>
        <NavLink to="/today"><Icon name="send" /><span className="label">{t('layout.nav.publish')}</span></NavLink>
        <NavLink to="/results"><Icon name="chart" /><span className="label">{t('layout.nav.results')}</span></NavLink>
        {(can('manage') || can('audit')) && <NavLink to="/settings"><Icon name="settings" /><span className="label">{t('layout.nav.settings')}</span></NavLink>}
      </nav>
      {creating && <NewCampaign onClose={() => setCreating(false)} />}
      {newBrand && <NewBrand onClose={() => setNewBrand(false)} />}
    </aside>
  );
}

function Shell() {
  const { brand, can } = useSession();
  const location = useLocation();
  const palette = usePalette();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname, location.search]);
  const due = useQuery({
    queryKey: ['due-count', brand.id],
    queryFn: () => api.get<unknown[]>(`/api/brands/${brand.id}/publications/due`),
    refetchInterval: 60_000,
  });
  return (
    <div className={`shell ${menu ? 'menu-open' : ''}`}>
      <nav className="rail" aria-label={t('layout.nav.main')}>
        <NavLink to="/" className="rail-logo" aria-label={t('layout.home')}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l7-4.5z" fill="#fff" /></svg>
        </NavLink>
        <RailLink to="/" end icon="home" label={t('layout.nav.home')} />
        <RailLink to="/pieces" icon="pieces" label={t('layout.nav.pieces')} />
        <RailLink to="/calendar" icon="calendar" label={t('layout.nav.calendar')} />
        <RailLink to="/today" icon="send" label={t('layout.nav.publish')} dot={(due.data?.length ?? 0) > 0} />
        <RailLink to="/results" icon="chart" label={t('layout.nav.results')} />
        <Tip label={t('common.search')} shortcut="⌘K" side="right"><button className="rail-btn" onClick={palette.open} aria-label={t('common.search')}><Icon name="search" /></button></Tip>
        <Notifications />
        <div className="rail-spacer" />
        {(can('manage') || can('audit')) && <RailLink to="/settings" icon="settings" label={t('layout.nav.settings')} />}
        <AccountMenu />
      </nav>
      <Sidebar />
      {menu && <div className="scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
      <div className="content">
        {/* Only on a phone: the rail is hidden, and this is where the menu lives. */}
        <header className="mobilebar">
          <button className="icon-btn" aria-label={t('layout.menu')} aria-expanded={menu} onClick={() => setMenu(true)}>
            <Icon name="menu" size={20} />
          </button>
          <span className="mobilebar-brand">{brand.name}</span>
          <button className="icon-btn" onClick={palette.open} aria-label={t('layout.palette.title')}><Icon name="search" size={18} /></button>
        </header>
        {brand.paused && <div className="banner" role="status">{t('layout.paused')}</div>}
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function Layout() {
  return (
    <PaletteProvider>
      <Shell />
    </PaletteProvider>
  );
}
