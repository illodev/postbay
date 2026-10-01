import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, type NotificationItem } from '../api';
import { fmtShort } from '../lib/format';
import { useSession } from '../lib/session';
import { useToast, errorMessage } from './ui';

const KIND_TEXT: Record<string, string> = {
  'version.uploaded': 'New version ready for review',
  'comment.created': 'New comment',
  'version.changes_requested': 'Changes requested',
  'version.approved': 'Version approved',
  'publication.due': 'A publication is due',
  'publication.reapproval': 'A change needs your confirmation',
  'publication.on_hold': 'Scheduled posts put on hold by a new version',
  'publication.published': 'A post went out',
  'publication.failed': 'A post could not be published',
  'publication.private': 'A video is private: it needs making public',
  'account.reconnect': 'An account needs reconnecting',
  'account.expiring': 'An account connection is about to expire',
};

function Bell() {
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
    <div style={{ position: 'relative' }}>
      <button className="btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="badge-count">{unread}</span>}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 'min(360px, 92vw)', zIndex: 30, maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="card-head">
            <strong>Notifications</strong>
            <button className="btn btn-small" onClick={readAll} disabled={!unread}>Mark all read</button>
          </div>
          {data?.items.length ? (
            data.items.slice(0, 20).map((n) => (
              <button
                key={n.id}
                className="btn"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', marginBottom: 4, fontWeight: n.read_at ? 400 : 700 }}
                onClick={() => {
                  setOpen(false);
                  if (n.payload.pieceId) navigate(`/pieces/${n.payload.pieceId}`);
                  else navigate('/today');
                }}
              >
                <span className="grow">
                  {KIND_TEXT[n.kind] ?? n.kind}
                  {n.piece_title && <span className="muted"> · {n.piece_title}</span>}
                  <br />
                  <span className="muted small">{n.brand} · {fmtShort(n.created_at)}</span>
                </span>
              </button>
            ))
          ) : (
            <p className="muted">Nothing yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { me, brand, setBrandId, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
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
    <>
      <header className="shell-header">
        <NavLink to="/" className="logo" aria-label="Content Studio home">
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M9 22V10l14 6z" fill="var(--accent-contrast)" /></svg>
          <span>Studio</span>
        </NavLink>
        {me.brands.length > 1 ? (
          <select aria-label="Brand" value={brand.id} onChange={(e) => setBrandId(e.target.value)} style={{ width: 'auto', maxWidth: 200 }}>
            {me.brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        ) : (
          <strong>{brand.name}</strong>
        )}
        <nav className="nav" aria-label="Main">
          <NavLink to="/pieces">Pieces</NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/today">Publish</NavLink>
          {(can('manage') || can('audit')) && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <Bell />
        <div className="row">
          <span className="muted small user-name" title={me.user.email}>{me.user.name ?? me.user.email}</span>
          <button className="btn btn-small" onClick={signOut}>Sign out</button>
        </div>
      </header>
      {brand.paused && <div className="banner" role="status">This brand is paused: nothing can be scheduled or moved until it is resumed.</div>}
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
