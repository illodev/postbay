import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type PieceSummary } from '../api';
import { LOCALES, t, tMaybe, useLocale } from '../i18n';
import { useSession } from '../lib/session';
import { Icon, type IconName } from './icons';

/** ⌘K / Ctrl+K anywhere: find a piece, go to a section or run an action, from the keyboard. */

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(Ctx);

interface Item {
  id: string;
  group: 'pieces' | 'go' | 'actions';
  label: string;
  sub?: string;
  icon?: IconName;
  thumb?: string;
  keywords?: string;
  run: () => void;
}

/** Lower case and without accents, so "revision" finds "revisión". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function Palette({ onClose }: { onClose: () => void }) {
  const { me, brand, setBrandId, can } = useSession();
  const { locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 120);
  const { data: found } = useQuery({
    queryKey: ['palette', brand.id, dq],
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces?${new URLSearchParams(dq ? { q: dq } : {})}`),
    staleTime: 10_000,
  });
  useEffect(() => input.current?.focus(), []);

  const go = useCallback((to: string) => () => { navigate(to); onClose(); }, [navigate, onClose]);
  const items = useMemo<Item[]>(() => {
    const pieces: Item[] = (found ?? []).slice(0, dq ? 8 : 5).map((p) => ({
      id: `p-${p.id}`,
      group: 'pieces',
      label: p.title,
      sub: [tMaybe(`kind.${p.kind}`, p.kind), tMaybe(`state.${p.review_state}`, p.review_state)].join(' · '),
      thumb: `/api/pieces/${p.id}/thumb?w=240`,
      run: go(`/pieces/${p.id}`),
    }));
    const nav: Item[] = [
      { id: 'g-home', group: 'go', label: t('layout.nav.home'), icon: 'home', run: go('/') },
      { id: 'g-pieces', group: 'go', label: t('layout.nav.pieces'), icon: 'pieces', run: go('/pieces') },
      { id: 'g-cal', group: 'go', label: t('layout.nav.calendar'), icon: 'calendar', run: go('/calendar') },
      { id: 'g-today', group: 'go', label: t('layout.nav.publish'), icon: 'send', run: go('/today') },
      { id: 'g-results', group: 'go', label: t('layout.nav.results'), icon: 'chart', run: go('/results') },
      ...(can('manage') || can('audit') ? [{ id: 'g-settings', group: 'go' as const, label: t('layout.nav.settings'), icon: 'settings' as const, run: go('/settings') }] : []),
      { id: 'g-account', group: 'go', label: t('layout.account'), icon: 'user', run: go('/security') },
    ];
    const actions: Item[] = [
      ...(can('createPiece') ? [{ id: 'a-new', group: 'actions' as const, label: t('pieces.new'), icon: 'plus' as const, run: go('/pieces?new=1') }] : []),
      ...me.brands.filter((b) => b.id !== brand.id).map((b) => ({
        id: `a-brand-${b.id}`, group: 'actions' as const, label: t('layout.palette.switchBrand', { brand: b.name }), icon: 'folder' as const,
        run: () => { setBrandId(b.id); navigate('/'); onClose(); },
      })),
      ...LOCALES.filter((l) => l.value !== locale).map((l) => ({
        id: `a-lang-${l.value}`, group: 'actions' as const, label: t('layout.palette.language', { language: l.label }), icon: 'globe' as const, keywords: 'idioma language',
        run: () => { setLocale(l.value); onClose(); },
      })),
    ];
    const f = fold(q.trim());
    const match = (i: Item) => !f || fold(`${i.label} ${i.keywords ?? ''}`).includes(f);
    return [...pieces, ...nav.filter(match), ...actions.filter(match)];
  }, [found, dq, q, go, can, me.brands, brand.id, setBrandId, navigate, onClose, locale, setLocale]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <>
      <div className="palette-scrim" onClick={onClose} aria-hidden="true" />
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('layout.palette.title')} onKeyDown={onKey}>
        <div className="palette-q">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel]?.id}
            placeholder={t('layout.palette.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <p className="muted small" style={{ padding: '12px 16px' }}>{t('layout.palette.empty')}</p>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group" role="presentation">{t(`layout.palette.group.${it.group}`)}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id} role="presentation">
                {head}
                <button id={it.id} role="option" aria-selected={i === sel} className="palette-item" onMouseEnter={() => setSel(i)} onClick={it.run}>
                  {it.thumb ? <img src={it.thumb} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="pi-icon"><Icon name={it.icon ?? 'chevronRight'} /></span>}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.label}{it.sub && <span className="pi-sub"> · {it.sub}</span>}
                  </span>
                  {i === sel && <span className="kbd">↵</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>↑↓ {t('layout.palette.move')}</span>
          <span>↵ {t('layout.palette.open')}</span>
          <span style={{ marginLeft: 'auto' }}>⌘K</span>
        </div>
      </div>
    </>
  );
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open && <Palette onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}
