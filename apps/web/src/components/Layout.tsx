import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, type NotificationItem } from '../api';
import { LOCALES, t, tMaybe, useLocale, type Locale } from '../i18n';
import { fmtShort } from '../lib/format';
import { useSession } from '../lib/session';
import { useToast, errorMessage } from './ui';

function Logo() {
  return (
    <NavLink to="/" className="logo" aria-label={t('layout.home')}>
      <span className="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="#1a1205" /></svg>
      </span>
      <span>{t('layout.appName')}</span>
    </NavLink>
  );
}

function Bell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: NotificationItem[]; unread: number }>('/api/notifications'),
    refetchInterval: 30_000,
  });
  const unread = data?.unread ?? 0;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const readAll = async () => {
    await api.post('/api/notifications/read', {});
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="sb-item"
        aria-label={unread ? t('notif.buttonUnread', { count: unread }) : t('notif.button')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="row" style={{ gap: '.6rem' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {t('notif.title')}
        </span>
        {unread > 0 && <span className="badge-count">{unread}</span>}
      </button>
      {open && (
        <div className="popover" style={{ left: 'calc(100% + 10px)', bottom: 0 }}>
          <div className="card-head">
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
                  if (n.payload.pieceId) navigate(`/pieces/${n.payload.pieceId}`);
                  else navigate('/today');
                }}
              >
                <span style={{ fontWeight: n.read_at ? 400 : 600 }}>{tMaybe(`notif.kind.${n.kind}`, n.kind)}</span>
                {n.piece_title && <span className="muted"> · {n.piece_title}</span>}
                <br />
                <span className="muted small">{n.brand} · {fmtShort(n.created_at)}</span>
              </button>
            ))
          ) : (
            <p className="muted">{t('notif.empty')}</p>
          )}
        </div>
      )}
    </div>
  );
}

const initials = (s: string) =>
  s
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function Layout() {
  const { me, brand, setBrandId, can } = useSession();
  const { locale, setLocale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);
  const due = useQuery({
    queryKey: ['due-count', brand.id],
    queryFn: () => api.get<unknown[]>(`/api/brands/${brand.id}/publications/due`),
    refetchInterval: 60_000,
  });
  const dueCount = due.data?.length ?? 0;
  const signOut = async () => {
    try {
      await api.post('/api/auth/logout');
      qc.clear();
      navigate('/login');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const name = me.user.name ?? me.user.email;
  return (
    <div className={`shell ${menu ? 'menu-open' : ''}`}>
      <aside className="sidebar">
        <Logo />
        <nav className="nav" aria-label={t('layout.nav.main')}>
          <NavLink to="/pieces">{t('layout.nav.pieces')}</NavLink>
          <NavLink to="/calendar">{t('layout.nav.calendar')}</NavLink>
          <NavLink to="/today">
            {t('layout.nav.publish')}
            {dueCount > 0 && <span className="nav-count">{dueCount}</span>}
          </NavLink>
          <NavLink to="/results">{t('layout.nav.results')}</NavLink>
          {(can('manage') || can('audit')) && <NavLink to="/settings">{t('layout.nav.settings')}</NavLink>}
        </nav>
        <div className="sb-sep" />
        <div className="sb-section">{me.brands.length > 1 ? t('layout.brands') : t('layout.brand')}</div>
        <div className="nav" role="group" aria-label={t('layout.brands')}>
          {me.brands.map((b) => (
            <button key={b.id} className={`sb-item ${b.id === brand.id ? 'on' : ''}`} aria-pressed={b.id === brand.id} onClick={() => setBrandId(b.id)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
            </button>
          ))}
        </div>
        <div className="sb-foot">
          <Bell />
          <label className="sb-item" style={{ cursor: 'default' }}>
            <span>{t('layout.language')}</span>
            <select
              aria-label={t('layout.language')}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              style={{ width: 'auto', minHeight: 28, padding: '.1rem 1.8rem .1rem .5rem', fontSize: '.8125rem' }}
            >
              {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </label>
          <NavLink to="/security" className="sb-user" title={t('layout.accountHint', { email: me.user.email })}>
            <span className="avatar" aria-hidden="true">{initials(name)}</span>
            <span className="who">{name}</span>
          </NavLink>
          <button className="sb-item" onClick={signOut}>{t('layout.signOut')}</button>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
      <div className="content">
        <header className="topbar">
          <button className="icon-btn" aria-label={t('layout.menu')} aria-expanded={menu} onClick={() => setMenu(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <Logo />
          <span className="muted small" style={{ marginLeft: 'auto' }}>{brand.name}</span>
        </header>
        {brand.paused && <div className="banner" role="status">{t('layout.paused')}</div>}
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
