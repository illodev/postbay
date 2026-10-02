import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type PieceDetail, type PieceSummary, type VersionDetail } from '../api';
import type { Campaign } from '../components/Layout';
import { Icon, type IconName } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { ScheduleDialog } from '../components/publications';
import { ConfirmDialog, Dialog, ErrorBox, Field, NetMark, Skeleton, errorMessage, useToast } from '../components/ui';
import { t, type Key } from '../i18n';
import { NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { Dropdown } from './pieces/Dropdown';
import {
  DEFAULT_LOOK, DEFAULT_SORT, inState, isLook, isSort, isView, MENU_SORTS, sortPieces, STATE_FILTERS, stageOf, useStored, VIEWS,
  type Look, type Sort, type Stage, type View,
} from './pieces/model';
import { BoardSkeleton, BoardView, discardLocked, EmptyState, GridSkeleton, GridView, ListSkeleton, ListView, type CardActions } from './pieces/views';
import '../styles/pieces.css';

const KINDS = ['video', 'carousel', 'post', 'story', 'pdf'] as const;
const VIEW_ICON: Record<View, IconName> = { grid: 'grid', board: 'columns', list: 'list' };
const STATE_DOT: Record<string, string> = {
  draft: 'var(--muted)', in_review: 'var(--warn)', changes_requested: 'var(--bad)', approved: 'var(--good)', scheduled: 'var(--info)', published: 'var(--live)', discarded: 'var(--faint)',
};
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// ───────────────────────────── new piece ─────────────────────────────

function NewPiece({ campaigns, campaignId, onClose }: { campaigns: Campaign[]; campaignId: string | null; onClose: () => void }) {
  const { brand } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', kind: 'video', brief: '', targetDate: '', aiGenerated: false, campaignId: campaignId ?? '', source: '' });
  const titleRef = useRef<HTMLInputElement>(null);
  // The dialog gives the focus to its first control (the close button) as it opens: the title is where typing starts.
  useEffect(() => {
    const id = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/brands/${brand.id}/pieces`, {
        title: form.title,
        kind: form.kind,
        brief: form.brief,
        targetDate: form.targetDate || null,
        aiGenerated: form.aiGenerated,
        campaignId: form.campaignId || null,
        source: form.source.trim() || null,
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast(t('pieces.created'));
      navigate(`/pieces/${p.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title={t('pieces.newTitle')} onClose={onClose}>
      <form className="stack pz-form" onSubmit={submit}>
        <Field label={t('pieces.field.title')}>
          <input ref={titleRef} type="text" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <div className="pz-form-row">
          <Field label={t('pieces.field.kind')}>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`pieces.kindOption.${k}` as Key)}</option>)}
            </select>
          </Field>
          <Field label={t('pieces.field.campaign')}>
            <select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
              <option value="">{t('pieces.field.noCampaign')}</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('pieces.field.brief')} hint={t('pieces.field.briefHint')}>
          <textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
        </Field>
        <div className="pz-form-row">
          <Field label={t('pieces.field.target')}>
            <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} />
            <span>{t('pieces.field.ai')}<br /><span className="muted small">{t('pieces.field.aiHint')}</span></span>
          </label>
        </div>
        <Field label={t('pieces.field.source')} hint={t('pieces.field.sourceHint')}>
          <input
            type="text"
            className="pz-mono-input"
            maxLength={500}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('pieces.field.sourcePlaceholder')}
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value.replace(/[\r\n\t]/g, '') })}
          />
        </Field>
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={create.isPending || !form.title.trim()}>{t('pieces.create')}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── bulk actions ─────────────────────────────

function MoveDialog({ pieces, campaigns, onClose, onDone }: { pieces: PieceSummary[]; campaigns: Campaign[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const same = pieces.every((p) => p.campaign_id === pieces[0]?.campaign_id) ? pieces[0]?.campaign_id ?? null : undefined;
  const move = useMutation({
    mutationFn: async (target: Campaign | null) => {
      for (const p of pieces) if (p.campaign_id !== (target?.id ?? null)) await api.patch(`/api/pieces/${p.id}`, { campaignId: target?.id ?? null });
      return target;
    },
    onSuccess: (target) => {
      toast(target ? t('pieces.move.done', { count: pieces.length, campaign: target.name }) : t('pieces.move.doneNone', { count: pieces.length }));
      onDone();
      onClose();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['pieces'] }),
  });
  const option = (c: Campaign | null) => {
    const current = same !== undefined && (c?.id ?? null) === same;
    return (
      <button key={c?.id ?? 'none'} type="button" className={`pz-option ${current ? 'is-current' : ''}`} disabled={move.isPending} onClick={() => move.mutate(c)}>
        <Icon name={c ? 'folder' : 'x'} />
        <span className="pz-option-name">{c ? c.name : t('pieces.move.none')}</span>
        {current && <span className="pz-option-note">{t('pieces.move.current')}</span>}
      </button>
    );
  };
  return (
    <Dialog title={t('pieces.move.title', { count: pieces.length })} onClose={onClose}>
      {pieces.length === 1 && <p className="muted pz-dlg-sub">«{pieces[0]!.title}»</p>}
      <div className="pz-options" role="group" aria-label={t('pieces.list.campaign')}>
        {campaigns.map(option)}
        {option(null)}
      </div>
      {!campaigns.length && <p className="muted small">{t('pieces.move.empty')}</p>}
      {move.error && <ErrorBox error={move.error} />}
    </Dialog>
  );
}

function DiscardDialog({ pieces, canSchedule, onClose, onDone }: { pieces: PieceSummary[]; canSchedule: boolean; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const locked = pieces.filter((p) => discardLocked(p, canSchedule));
  const go = pieces.filter((p) => !locked.includes(p));
  const scheduled = go.filter((p) => p.next_publication).length;
  const discard = useMutation({
    mutationFn: async () => {
      const failed: { title: string; reason: string }[] = [];
      for (const p of go) {
        try {
          await api.post(`/api/pieces/${p.id}/discard`);
        } catch (e) {
          failed.push({ title: p.title, reason: errorMessage(e) });
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      const ok = go.length - failed.length;
      if (ok) toast(t('pieces.discard.done', { count: ok }));
      if (failed.length) toast(t('pieces.discard.failed', { count: failed.length, reason: failed[0]!.reason }), 'error');
      onDone();
      onClose();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['pieces'] }),
  });
  // None of them is this person's to discard: say so, without a dialog that can only be cancelled.
  useEffect(() => {
    if (go.length) return;
    toast(t('pieces.discard.noneYours', { count: locked.length }), 'error');
    onClose();
  }, [go.length, locked.length, toast, onClose]);
  if (!go.length) return null;
  return (
    <ConfirmDialog
      danger
      busy={discard.isPending}
      title={t('pieces.discard.title', { count: go.length })}
      confirmLabel={t('pieces.discard.submit', { count: go.length })}
      text={
        <>
          <p>{go.length === 1 ? t('pieces.discard.bodyOne', { title: go[0]!.title }) : t('pieces.discard.bodyMany', { count: go.length })}</p>
          {scheduled > 0 && <p className="pz-confirm-warn">{t('pieces.discard.cancels', { count: scheduled })}</p>}
          {locked.length > 0 && <p>{t('pieces.discard.locked', { count: locked.length })}</p>}
          <p>{t('pieces.discard.final')}</p>
        </>
      }
      onConfirm={() => discard.mutate()}
      onCancel={onClose}
    />
  );
}

/** Schedules a piece from the list: finds its approved version and opens the same dialog as the review. */
function ScheduleFromList({ pieceId, brandId, onClose }: { pieceId: string; brandId: string; onClose: () => void }) {
  const toast = useToast();
  const version = useQuery({
    queryKey: ['schedule-version', pieceId],
    staleTime: 0,
    queryFn: async () => {
      const piece = await api.get<PieceDetail>(`/api/pieces/${pieceId}`);
      const approved = piece.variants
        .map((v) => [...v.versions].sort((a, b) => b.number - a.number).find((x) => x.review_state === 'approved'))
        .find(Boolean);
      return approved ? api.get<VersionDetail>(`/api/versions/${approved.id}`) : null;
    },
  });
  useEffect(() => {
    if (version.error) {
      toast(errorMessage(version.error), 'error');
      onClose();
    } else if (version.data === null) {
      toast(t('pieces.board.noApproved'), 'error');
      onClose();
    }
  }, [version.error, version.data, toast, onClose]);
  if (!version.data) return version.isLoading ? <div className="toast pz-busy" role="status">{t('pieces.board.opening')}</div> : null;
  return <ScheduleDialog version={version.data} brandId={brandId} zone={version.data.brand.timezone} onClose={onClose} />;
}

/** Starts a download of every file of each piece's latest version (not its cover), one after the other. */
async function downloadLatest(pieces: PieceSummary[]): Promise<number> {
  const versions = await Promise.all(pieces.filter((p) => p.latest_version).map((p) => api.get<VersionDetail>(`/api/versions/${p.latest_version!.id}`)));
  const files = versions.flatMap((v) => v.assets.filter((a) => a.kind !== 'cover'));
  files.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      // If the browser ignores the name (files served from another address), the file opens in a tab: this page stays.
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    }, i * 450);
  });
  return files.length;
}

function SelectionBar({ pieces, actions, onClear, onDownload, downloading }: {
  pieces: PieceSummary[];
  actions: CardActions;
  onClear: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  const single = pieces.length === 1 ? pieces[0]! : null;
  const live = pieces.filter((p) => p.review_state !== 'discarded');
  return (
    <div className="pz-selbar" role="region" aria-label={t('pieces.sel.label')}>
      <button type="button" className="pz-selbar-x" onClick={onClear} aria-label={t('pieces.sel.clear')} title={t('pieces.sel.clear')}><Icon name="x" /></button>
      <span className="pz-selbar-count">{t('pieces.sel.count', { count: pieces.length })}</span>
      <span className="pz-selbar-sep" aria-hidden="true" />
      <button type="button" className="pz-sbtn" onClick={onDownload} disabled={downloading || !pieces.some((p) => p.latest_version)} title={t('pieces.sel.downloadHint')}>
        <Icon name="download" /><span>{t('pieces.sel.download')}</span>
      </button>
      {actions.canEdit && live.length > 0 && (
        <>
          <button type="button" className="pz-sbtn" onClick={() => actions.onMove(live.map((p) => p.id))}><Icon name="folder" /><span>{t('pieces.sel.move')}</span></button>
          <button type="button" className="pz-sbtn pz-sbtn-danger" onClick={() => actions.onDiscard(live.map((p) => p.id))}><Icon name="trash" /><span>{t('pieces.sel.discard')}</span></button>
        </>
      )}
      {single && actions.canSchedule && single.review_state === 'approved' && (
        <button type="button" className="pz-sbtn pz-sbtn-primary" onClick={() => actions.onSchedule(single.id)}><Icon name="calendar" /><span>{t('pieces.sel.schedule')}</span></button>
      )}
    </div>
  );
}

// ───────────────────────────── toolbar ─────────────────────────────

function Seg<T extends string>({ value, options, onChange, label, render }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string; render: (v: T) => string }) {
  return (
    <div className="pz-seg pz-seg-sm" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'is-on' : ''} onClick={() => onChange(o)}>{render(o)}</button>
      ))}
    </div>
  );
}

const ASPECT_ICON: Record<Look['aspect'], string> = { '4:5': 'pz-ar pz-ar-45', '1:1': 'pz-ar pz-ar-11', '16:9': 'pz-ar pz-ar-169' };

function AppearancePanel({ look, onChange }: { look: Look; onChange: (l: Look) => void }) {
  return (
    <div className="pz-look">
      <p className="pz-look-note"><Icon name="user" />{t('pieces.look.note')}</p>
      <div className="pz-look-row">
        <span>{t('pieces.look.size')}</span>
        <Seg value={look.size} options={['S', 'M', 'L'] as const} onChange={(size) => onChange({ ...look, size })} label={t('pieces.look.size')} render={(v) => v} />
      </div>
      <div className="pz-look-row">
        <span>{t('pieces.look.aspect')}</span>
        <div className="pz-seg pz-seg-sm" role="radiogroup" aria-label={t('pieces.look.aspect')}>
          {(['16:9', '1:1', '4:5'] as const).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={look.aspect === a} className={look.aspect === a ? 'is-on' : ''} onClick={() => onChange({ ...look, aspect: a })} title={a} aria-label={t(`pieces.look.aspect.${a.replace(':', '')}` as Key)}>
              <span className={ASPECT_ICON[a]} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div className="pz-look-row">
        <span>{t('pieces.look.thumb')}</span>
        <Seg value={look.fit} options={['fit', 'fill'] as const} onChange={(fit) => onChange({ ...look, fit })} label={t('pieces.look.thumb')} render={(v) => t(`pieces.look.${v}` as Key)} />
      </div>
      <label className="pz-look-row pz-switch-row">
        <span>{t('pieces.look.info')}</span>
        <input type="checkbox" role="switch" className="pz-switch" checked={look.info} onChange={(e) => onChange({ ...look, info: e.target.checked })} />
      </label>
    </div>
  );
}

function MenuButton({ icon, label, value, props, active }: { icon: IconName; label: string; value?: string; props: Record<string, unknown>; active?: boolean }) {
  return (
    <button type="button" className={`pz-tb ${active ? 'is-active' : ''}`} {...props}>
      <Icon name={icon} />
      <span className="pz-tb-label">{label}</span>
      {value && <span className="pz-tb-value">{value}</span>}
      <Icon name="chevronDown" className="pz-tb-chev" />
    </button>
  );
}

function MenuOption({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="menu-item pz-mi" role="menuitemradio" aria-checked={checked} onClick={onClick}>
      {children}
      <Icon name="check" className="pz-mi-check" style={{ visibility: checked ? 'visible' : 'hidden' }} />
    </button>
  );
}

// ───────────────────────────── the page ─────────────────────────────

export function PiecesPage() {
  const { brand, can } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  // The sidebar's folders and collections arrive as query parameters; the view is one too, and the last one is remembered.
  const [storedView, setStoredView] = useStored<View>('studio.pieces.view', 'grid', isView);
  const urlView = params.get('view');
  const view: View = isView(urlView) ? urlView : storedView;
  const state = (STATE_FILTERS as readonly string[]).includes(params.get('state') ?? '') ? params.get('state') ?? '' : '';
  const campaign = params.get('campaign');
  const byAgent = params.get('by') === 'agent';
  const creating = params.get('new') === '1';
  const [net, setNet] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useStored<Sort>('studio.pieces.sort', DEFAULT_SORT, isSort);
  const [look, setLook] = useStored<Look>('studio.pieces.look', DEFAULT_LOOK, isLook);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [discarding, setDiscarding] = useState<string[] | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [dragging, setDragging] = useState<PieceSummary | null>(null);
  const [downloading, setDownloading] = useState(false);

  const setParam = (key: string, value: string | null, push = true) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: !push });
  };
  const setView = (v: View) => {
    setStoredView(v);
    setParam('view', v === 'grid' ? null : v, false);
  };

  // The same request (and cache) as the sidebar's counts: every piece of the brand, filtered here.
  const { data: all, error, isLoading } = useQuery({
    queryKey: ['pieces', brand.id, '', ''],
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces`),
  });
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', brand.id], queryFn: () => api.get<Campaign[]>(`/api/brands/${brand.id}/campaigns`) });

  const scoped = useMemo(() => (all ?? []).filter((p) => (!campaign || p.campaign_id === campaign) && (!byAgent || p.latest_by_agent)), [all, campaign, byAgent]);
  const networks = useMemo(() => [...new Set(scoped.flatMap((p) => p.networks))].sort(), [scoped]);
  const shown = useMemo(() => {
    const needle = fold(q.trim());
    const list = scoped.filter(
      (p) => inState(p, state) && (!net || p.networks.includes(net)) && (!needle || fold(`${p.title} ${p.campaign_name ?? ''}`).includes(needle)),
    );
    return sortPieces(list, sort);
  }, [scoped, state, net, q, sort]);
  const chosen = useMemo(() => shown.filter((p) => selected.has(p.id)), [shown, selected]);
  const byId = useMemo(() => new Map((all ?? []).map((p) => [p.id, p])), [all]);

  // A new place in the sidebar, or another view, starts with nothing picked.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [campaign, state, byAgent, view, brand.id]);
  useEffect(() => setNet(''), [brand.id, campaign]);

  const toggle = useCallback(
    (id: string, range: boolean) => {
      // Read the anchor now: the updater below runs later, after it has moved to this piece.
      const ids = shown.map((p) => p.id);
      const a = anchor.current ? ids.indexOf(anchor.current) : -1;
      const b = ids.indexOf(id);
      setSelected((prev) => {
        const next = new Set(prev);
        if (range && a >= 0 && b >= 0) {
          for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
    },
    [shown],
  );

  // ⌘A / Ctrl+A picks everything showing, Escape lets go, / goes to the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing && view !== 'board' && shown.length) {
        e.preventDefault();
        setSelected(new Set(shown.map((p) => p.id)));
      } else if (e.key === 'Escape' && !typing && selected.size) {
        setSelected(new Set());
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown, selected.size, view]);

  const actions: CardActions = {
    canEdit: can('createPiece'),
    canSchedule: can('schedule'),
    onMove: setMoving,
    onDiscard: setDiscarding,
    onSchedule: setScheduling,
  };

  const download = async () => {
    setDownloading(true);
    try {
      const n = await downloadLatest(chosen);
      toast(n ? t('pieces.download.started', { count: n }) : t('pieces.download.nothing'), n ? 'ok' : 'error');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setDownloading(false);
    }
  };

  // Dropping on the board: only an approved piece on "Scheduled" means something; the rest of the states come from the review.
  const scheduleTarget = !!dragging && dragging.review_state === 'approved' && can('schedule');
  const drop = (to: Stage) => {
    const p = dragging;
    setDragging(null);
    if (!p) return;
    const from = stageOf(p);
    if (to === from) return;
    if (to === 'scheduled') {
      if (p.review_state !== 'approved') toast(t('pieces.board.refuse.notApproved'), 'error');
      else if (!can('schedule')) toast(t('pieces.board.refuse.cannotSchedule'), 'error');
      else setScheduling(p.id);
      return;
    }
    toast(t(`pieces.board.refuse.${to}` as Key), 'error');
  };

  const campaignName = campaign ? campaigns?.find((c) => c.id === campaign)?.name : undefined;
  const where = campaign ? campaignName ?? '…' : byAgent ? t('layout.collection.agent') : state ? t(`pieces.filter.crumb.${state}` as Key) : null;
  const waiting = scoped.filter((p) => p.review_state === 'in_review').length;
  const filtersOn = !!(net || q.trim());
  const clearFilters = () => {
    setNet('');
    setQ('');
  };

  const empty = () => {
    const create = can('createPiece') && (
      <button type="button" className="btn btn-primary btn-small" onClick={() => setParam('new', '1')}><Icon name="plus" />{t('pieces.new')}</button>
    );
    if (q.trim()) return <EmptyState icon="search" title={t('pieces.empty.search.title', { q: q.trim() })} action={<button className="btn btn-small" onClick={clearFilters}>{t('pieces.empty.clear')}</button>}>{t('pieces.empty.search.body')}</EmptyState>;
    if (net) return <EmptyState icon="filter" title={t('pieces.empty.network.title', { network: NETWORK_LABEL[net] ?? net })} action={<button className="btn btn-small" onClick={clearFilters}>{t('pieces.empty.clear')}</button>}>{t('pieces.empty.network.body')}</EmptyState>;
    if (byAgent) return <EmptyState icon="bot" title={t('pieces.empty.agent.title')}>{t('pieces.empty.agent.body')}</EmptyState>;
    if (state) return <EmptyState icon="filter" title={t(`pieces.empty.${state}.title` as Key)} action={<button className="btn btn-small" onClick={() => setParam('state', null)}>{t('pieces.empty.seeAll')}</button>}>{t(`pieces.empty.${state}.body` as Key)}</EmptyState>;
    if (campaign) return <EmptyState icon="folder" title={t('pieces.empty.campaign.title')} action={create}>{can('createPiece') ? t('pieces.empty.campaign.body', { campaign: campaignName ?? '' }) : t('pieces.empty.wait')}</EmptyState>;
    return <EmptyState icon="pieces" title={t('pieces.empty.all.title')} action={create}>{can('createPiece') ? t('pieces.empty.all.body') : t('pieces.empty.wait')}</EmptyState>;
  };

  const sortLabel = MENU_SORTS.includes(sort.key) ? t(`pieces.sort.${sort.key}` as Key) : t(`pieces.list.${sort.key}` as Key);
  return (
    <div className="pz">
      <PageBar
        crumbs={[{ label: t('pieces.title'), to: '/pieces' }, ...(where ? [{ label: where }] : [])]}
        actions={can('createPiece') && (
          <button className="btn btn-primary pz-new" onClick={() => setParam('new', '1')}><Icon name="plus" />{t('pieces.new')}</button>
        )}
      />

      <div className="pz-toolbar" role="toolbar" aria-label={t('pieces.toolbar')}>
        <div className="pz-tools">
          {view === 'grid' && (
            <Dropdown
              kind="dialog"
              label={t('pieces.look.title')}
              panelClassName="pz-pop-look"
              button={(props) => (
                <button type="button" className="pz-tb" {...props}><Icon name="grid" /><span className="pz-tb-label">{t('pieces.look.title')}</span></button>
              )}
            >
              {() => <AppearancePanel look={look} onChange={setLook} />}
            </Dropdown>
          )}
          <Dropdown label={t('pieces.filter.state')} button={(props) => (
            <MenuButton icon="filter" label={t('pieces.filter.stateShort')} value={state ? STATE_LABEL[state] : t('pieces.filter.allStates')} props={props} active={!!state} />
          )}>
            {(close) => STATE_FILTERS.map((s) => (
              <MenuOption key={s || 'all'} checked={state === s} onClick={() => { close(); setParam('state', s || null); }}>
                {s ? <span className="pz-mdot" style={{ background: STATE_DOT[s] }} /> : <Icon name="pieces" />}
                <span className="grow">{s ? STATE_LABEL[s] : t('pieces.filter.allStatesLong')}</span>
                <span className="pz-mcount">{scoped.filter((p) => inState(p, s)).length}</span>
              </MenuOption>
            ))}
          </Dropdown>
          <Dropdown label={t('pieces.filter.network')} button={(props) => (
            <MenuButton icon="send" label={t('pieces.filter.networkShort')} value={net ? NETWORK_LABEL[net] ?? net : t('pieces.filter.allNetworks')} props={props} active={!!net} />
          )}>
            {(close) => (
              <>
                <MenuOption checked={!net} onClick={() => { close(); setNet(''); }}><Icon name="globe" /><span className="grow">{t('pieces.filter.allNetworksLong')}</span></MenuOption>
                {networks.map((n) => (
                  <MenuOption key={n} checked={net === n} onClick={() => { close(); setNet(n); }}>
                    <NetMark network={n} size="sm" /><span className="grow">{NETWORK_LABEL[n] ?? n}</span>
                    <span className="pz-mcount">{scoped.filter((p) => p.networks.includes(n) && inState(p, state)).length}</span>
                  </MenuOption>
                ))}
                {!networks.length && <p className="pz-menu-note">{t('pieces.filter.noNetworks')}</p>}
              </>
            )}
          </Dropdown>
          <Dropdown label={t('pieces.sort.label')} button={(props) => <MenuButton icon="sort" label={t('pieces.sort.label')} value={sortLabel} props={props} />}>
            {(close) => (
              <>
                {MENU_SORTS.map((k) => (
                  <MenuOption key={k} checked={sort.key === k} onClick={() => { close(); setSort({ key: k, dir: k === 'updated' ? 'desc' : 'asc' }); }}>
                    <span className="grow">{t(`pieces.sort.${k}` as Key)}</span>
                  </MenuOption>
                ))}
                <div className="menu-sep" />
                <MenuOption checked={false} onClick={() => { close(); setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' }); }}>
                  <Icon name="chevronDown" style={{ transform: sort.dir === 'asc' ? 'rotate(180deg)' : undefined }} />
                  <span className="grow">{sort.dir === 'asc' ? t('pieces.sort.asc') : t('pieces.sort.desc')}</span>
                </MenuOption>
              </>
            )}
          </Dropdown>
          <label className="pz-search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              aria-label={t('pieces.searchLabel')}
              placeholder={t('pieces.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && q) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQ('');
                }
              }}
            />
            {!q && <kbd className="pz-kbd" aria-hidden="true">/</kbd>}
          </label>
        </div>
        <div className="pz-seg pz-views" role="radiogroup" aria-label={t('pieces.view.label')}>
          {VIEWS.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'is-on' : ''} onClick={() => setView(v)} title={t(`pieces.view.${v}` as Key)}>
              <Icon name={VIEW_ICON[v]} /><span className="pz-views-label">{t(`pieces.view.${v}` as Key)}</span>
            </button>
          ))}
        </div>
      </div>

      {all && (
        <p className="pz-summary">
          <span>{filtersOn || state ? t('pieces.summaryOf', { count: shown.length, total: scoped.filter((p) => p.review_state !== 'discarded').length }) : t('pieces.summary', { count: shown.length })}</span>
          {waiting > 0 && state !== 'in_review' && <><span className="pz-dot" aria-hidden="true">·</span><button type="button" className="pz-linkish" onClick={() => setParam('state', 'in_review')}>{t('pieces.summaryWaiting', { count: waiting })}</button></>}
          {filtersOn && <><span className="pz-dot" aria-hidden="true">·</span><button type="button" className="pz-linkish" onClick={clearFilters}>{t('pieces.empty.clear')}</button></>}
          {view === 'board' && can('schedule') && <span className="pz-summary-hint">{t('pieces.board.hint')}</span>}
          {view === 'list' && shown.length > 0 && <span className="pz-summary-hint">{t('pieces.list.keys')}</span>}
        </p>
      )}

      {isLoading && <p className="pz-summary" aria-hidden="true"><Skeleton width={120} height={10} /></p>}
      {error && <ErrorBox error={error} />}
      {isLoading && (view === 'board' ? <BoardSkeleton /> : view === 'list' ? <ListSkeleton /> : <GridSkeleton look={look} />)}
      {all && shown.length === 0 && view !== 'board' && empty()}
      {all && (shown.length > 0 || view === 'board') && (
        view === 'grid' ? (
          <GridView pieces={shown} look={look} selected={selected} onToggle={toggle} actions={actions} zone={brand.timezone} />
        ) : view === 'list' ? (
          <ListView
            pieces={shown}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onToggle={toggle}
            onToggleAll={() => setSelected(chosen.length === shown.length ? new Set() : new Set(shown.map((p) => p.id)))}
            zone={brand.timezone}
          />
        ) : (
          <BoardView
            pieces={shown}
            zone={brand.timezone}
            dragging={dragging}
            onDragStart={setDragging}
            onDragEnd={() => setDragging(null)}
            onDrop={drop}
            scheduleTarget={scheduleTarget}
          />
        )
      )}

      {chosen.length > 0 && view !== 'board' && (
        <SelectionBar pieces={chosen} actions={actions} onClear={() => setSelected(new Set())} onDownload={download} downloading={downloading} />
      )}
      {creating && <NewPiece campaigns={campaigns ?? []} campaignId={campaign} onClose={() => setParam('new', null, false)} />}
      {moving && (
        <MoveDialog pieces={moving.map((id) => byId.get(id)).filter((p): p is PieceSummary => !!p)} campaigns={campaigns ?? []} onClose={() => setMoving(null)} onDone={() => setSelected(new Set())} />
      )}
      {discarding && (
        <DiscardDialog pieces={discarding.map((id) => byId.get(id)).filter((p): p is PieceSummary => !!p)} canSchedule={can('schedule')} onClose={() => setDiscarding(null)} onDone={() => setSelected(new Set())} />
      )}
      {scheduling && <ScheduleFromList pieceId={scheduling} brandId={brand.id} onClose={() => setScheduling(null)} />}
    </div>
  );
}
