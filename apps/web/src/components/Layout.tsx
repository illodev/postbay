import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type NotificationItem, type PieceSummary } from '../api';
import { LOCALES, t, tMaybe, useLocale, type Locale } from '../i18n';
import { fmtShort } from '../lib/format';
import { useSession } from '../lib/session';
import { Avatar, displayName } from './Avatar';
import { PaletteProvider, usePalette } from './CommandPalette';
import { Icon, type IconName } from './icons';
import { PageBarSlots } from './PageBar';
import { Dialog, ErrorBox, Field, useToast, errorMessage } from './ui';

export interface Campaign {
  id: string;
  name: string;
}

/** Closes a popover when the pointer goes down outside it. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function RailLink({ to, icon, label, end, dot }: { to: string; icon: IconName; label: string; end?: boolean; dot?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`} title={label} aria-label={label}>
      <Icon name={icon} />
      {dot && <span className="rail-dot" />}
    </NavLink>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
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
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="rail-btn"
        title={t('notif.title')}
        aria-label={unread ? t('notif.buttonUnread', { count: unread }) : t('notif.button')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="rail-dot" />}
      </button>
      {open && (
        <div className="popover" style={{ left: 'calc(100% + 10px)', top: -8 }}>
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
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { me } = useSession();
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
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
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="rail-btn" aria-label={t('layout.account')} aria-expanded={open} onClick={() => setOpen(!open)} title={me.user.email}>
        <Avatar name={me.user.name ?? me.user.email} size={30} />
      </button>
      {open && (
        <div className="popover" style={{ left: 'calc(100% + 10px)', bottom: 0, width: 260 }} role="menu">
          <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.45rem .6rem .6rem' }}>
            <Avatar name={me.user.name ?? me.user.email} size={32} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.user.email}</div>
            </div>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); navigate('/security'); }}><Icon name="user" />{t('layout.account')}</button>
          <div className="menu-label">{t('layout.language')}</div>
          {LOCALES.map((l) => (
            <button key={l.value} className="menu-item" role="menuitemradio" aria-checked={locale === l.value} onClick={() => setLocale(l.value as Locale)}>
              <Icon name={locale === l.value ? 'check' : 'globe'} style={{ visibility: locale === l.value ? 'visible' : 'hidden' }} />
              {l.label}
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={signOut}><Icon name="logout" />{t('layout.signOut')}</button>
        </div>
      )}
    </div>
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
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [brandsOpen, setBrandsOpen] = useState(false);
  const brandsRef = useOutside(brandsOpen, () => setBrandsOpen(false));
  const [creating, setCreating] = useState(false);
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', brand.id], queryFn: () => api.get<Campaign[]>(`/api/brands/${brand.id}/campaigns`) });
  const { data: all } = useQuery({ queryKey: ['pieces', brand.id, '', ''], queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces`) });
  const live = (all ?? []).filter((p) => p.review_state !== 'discarded');
  const onPieces = location.pathname === '/pieces';
  const current = (q: string) => onPieces && [...new URLSearchParams(q)].every(([k, v]) => params.get(k) === v) && [...params.keys()].filter((k) => k !== 'view').length === [...new URLSearchParams(q)].length;
  const byCampaign = (id: string) => live.filter((p) => p.campaign_id === id).length;
  return (
    <aside className="sidebar" aria-label={t('layout.nav.main')}>
      <div ref={brandsRef} style={{ position: 'relative' }}>
        <button className="brand-switch" onClick={() => me.brands.length > 1 && setBrandsOpen(!brandsOpen)} aria-expanded={brandsOpen} aria-haspopup={me.brands.length > 1 ? 'menu' : undefined}>
          <span className="brand-mark" aria-hidden="true">{brand.name.slice(0, 1).toUpperCase()}</span>
          <span className="name">{brand.name}</span>
          {me.brands.length > 1 && <Icon name="chevronDown" />}
        </button>
        {brandsOpen && (
          <div className="popover" style={{ left: 0, top: 'calc(100% + 4px)', width: '100%' }} role="menu">
            <div className="menu-label">{t('layout.brands')}</div>
            {me.brands.map((b) => (
              <button key={b.id} className="menu-item" role="menuitemradio" aria-checked={b.id === brand.id} onClick={() => { setBrandId(b.id); setBrandsOpen(false); navigate('/'); }}>
                <span className="brand-mark" style={{ width: 20, height: 20, fontSize: '.6875rem' }}>{b.name.slice(0, 1).toUpperCase()}</span>
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
                {b.id === brand.id && <Icon name="check" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <nav className="nav">
        <NavLink to="/" end><Icon name="home" /><span className="label">{t('layout.nav.home')}</span></NavLink>
      </nav>
      <div className="sb-section">
        <span>{t('layout.nav.pieces')}</span>
        {can('createPiece') && <button onClick={() => setCreating(true)} title={t('layout.newCampaign')} aria-label={t('layout.newCampaign')}><Icon name="plus" /></button>}
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
    </aside>
  );
}

function Shell() {
  const { brand, can } = useSession();
  const location = useLocation();
  const palette = usePalette();
  const [menu, setMenu] = useState(false);
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
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
        <button className="rail-btn" onClick={palette.open} title={`${t('common.search')} (⌘K)`} aria-label={t('common.search')}><Icon name="search" /></button>
        <Notifications />
        <div className="rail-spacer" />
        {(can('manage') || can('audit')) && <RailLink to="/settings" icon="settings" label={t('layout.nav.settings')} />}
        <AccountMenu />
      </nav>
      <Sidebar />
      {menu && <div className="scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
      <div className="content">
        <header className="pagebar">
          <button className="icon-btn menu-btn" aria-label={t('layout.menu')} aria-expanded={menu} onClick={() => setMenu(true)}>
            <Icon name="menu" size={20} />
          </button>
          <div ref={setCrumbs} style={{ minWidth: 0, display: 'flex' }} />
          <div className="pagebar-actions">
            <div ref={setActions} style={{ display: 'flex', gap: 8, alignItems: 'center' }} />
            <button className="search-trigger" onClick={palette.open} aria-label={t('layout.palette.title')}>
              <Icon name="search" /><span className="label">{t('layout.palette.placeholderShort')}</span><span className="kbd">⌘K</span>
            </button>
          </div>
        </header>
        {brand.paused && <div className="banner" role="status">{t('layout.paused')}</div>}
        <main className="page">
          <PageBarSlots.Provider value={{ crumbs, actions }}>
            <Outlet />
          </PageBarSlots.Provider>
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
