import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PieceSummary } from '../../api';
import { Avatar } from '../../components/Avatar';
import { Icon, type IconName } from '../../components/icons';
import { Chip, Menu, MenuItem, MenuSeparator, NetMark, Skeleton } from '../../components/ui';
import { t, tMaybe, type Key } from '../../i18n';
import { NETWORK_LABEL, STATE_LABEL } from '../../lib/format';
import { ago, BOARD, FIRST_DIR, mediaLabel, stageOf, when, type Look, type Sort, type SortKey, type Stage } from './model';

const netName = (n: string) => NETWORK_LABEL[n] ?? n;

/** The piece's preview, or a calm placeholder when there is nothing to draw (no version yet, or the preview failed). */
export function Thumb({ piece, width = 480 }: { piece: PieceSummary; width?: 240 | 480 | 960 }) {
  const [failed, setFailed] = useState(false);
  const v = piece.latest_version;
  if (!v || failed) {
    const icon: IconName = piece.kind === 'video' ? 'play' : piece.kind === 'pdf' ? 'square' : 'image';
    return (
      <span className="pz-ph">
        <Icon name={icon} />
        <span>{v ? t('pieces.card.noPreview') : t('pieces.card.noVersion')}</span>
      </span>
    );
  }
  // The version is in the address so a new version is a new image, not yesterday's from the cache.
  return <img src={`/api/pieces/${piece.id}/thumb?w=${width}&v=${v.id}`} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />;
}

export const STAGE_COLOUR: Record<Stage, string> = {
  draft: 'var(--muted)', in_review: 'var(--warn)', changes_requested: 'var(--bad)', approved: 'var(--good)', scheduled: 'var(--info)', published: 'var(--live)', discarded: 'var(--faint)',
};

/**
 * The one grey line under a card's name. What a person wants to know first: for a piece that is going out, when and where;
 * otherwise who made the latest version (the agent's own mark, or the person's avatar) and when.
 */
function MetaLine({ p, zone }: { p: PieceSummary; zone: string }) {
  const v = p.latest_version;
  const next = p.next_publication;
  if (stageOf(p) === 'scheduled' && next) {
    const at = when(next.scheduled_at, zone);
    return (
      <span className="pz-by" title={t('pieces.card.nextTitle', { when: at, network: netName(next.network) })}>
        <NetMark network={next.network} size="xs" />
        <span className="pz-by-name">{at}</span>
        {p.networks.length > 1 && <span className="pz-by-more">+{p.networks.length - 1}</span>}
      </span>
    );
  }
  if (!v) return <span className="pz-by"><span className="pz-by-name">{t('pieces.card.created', { when: ago(p.created_at) })}</span></span>;
  return (
    <span className="pz-by">
      {v.by_agent ? <Avatar agent size={16} /> : <Avatar name={v.author} size={16} />}
      <span className="pz-by-name">{v.by_agent ? t('common.agent') : v.author ?? '?'}</span>
      <span className="pz-dot" aria-hidden="true">·</span>
      <time dateTime={v.created_at} className="pz-by-when">{ago(v.created_at)}</time>
    </span>
  );
}

export interface CardActions {
  canEdit: boolean;
  canSchedule: boolean;
  onMove: (ids: string[]) => void;
  onDiscard: (ids: string[]) => void;
  onSchedule: (id: string) => void;
}

/** Whether a person may discard this piece themselves: a producer cannot once something is approved or scheduled. */
export const discardLocked = (p: PieceSummary, canSchedule: boolean) => !canSchedule && (p.review_state === 'approved' || !!p.next_publication);

function CardMenu({ p, actions }: { p: PieceSummary; actions: CardActions }) {
  const navigate = useNavigate();
  const locked = discardLocked(p, actions.canSchedule);
  return (
    <span className="pz-more-wrap">
      <Menu
        align="start"
        width={236}
        trigger={
          <button type="button" className="pz-more" aria-label={t('pieces.card.menu', { title: p.title })} title={t('pieces.card.menuShort')}>
            <Icon name="more" />
          </button>
        }
      >
        <MenuItem icon="arrow" onSelect={() => navigate(`/pieces/${p.id}`)}>{t('pieces.menu.open')}</MenuItem>
        {p.latest_version && (
          <MenuItem icon="play" onSelect={() => navigate(`/review/${p.latest_version!.id}`)}>{t('pieces.menu.review', { number: p.latest_version.number })}</MenuItem>
        )}
        {actions.canSchedule && p.review_state === 'approved' && (
          <MenuItem icon="calendar" onSelect={() => actions.onSchedule(p.id)}>{t('pieces.menu.schedule')}</MenuItem>
        )}
        {actions.canEdit && p.review_state !== 'discarded' && (
          <>
            <MenuItem icon="folder" onSelect={() => actions.onMove([p.id])}>{t('pieces.menu.move')}</MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger disabled={locked} onSelect={() => actions.onDiscard([p.id])}>{t('pieces.menu.discard')}</MenuItem>
            {locked && <p className="pz-menu-note">{t('pieces.menu.discardLocked')}</p>}
          </>
        )}
      </Menu>
    </span>
  );
}

/** A tick box that is a real control: Space toggles it, Shift-click takes the whole range from the last one ticked. */
function Check({ checked, label, onToggle, className }: { checked: boolean; label: string; onToggle: (range: boolean) => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={t('pieces.card.selectHint')}
      className={`pz-check ${className ?? ''}`}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
    >
      {checked && <Icon name="check" />}
    </button>
  );
}

// ───────────────────────────── grid ─────────────────────────────

function PieceCard({ p, look, selected, selecting, onToggle, actions, zone }: {
  p: PieceSummary;
  look: Look;
  selected: boolean;
  selecting: boolean;
  onToggle: (id: string, range: boolean) => void;
  actions: CardActions;
  zone: string;
}) {
  const v = p.latest_version;
  const media = mediaLabel(p);
  const stage = stageOf(p);
  return (
    <article className={`pz-card ${selected ? 'is-selected' : ''} ${selecting ? 'is-selecting' : ''}`} aria-label={p.title}>
      <div className="pz-thumb" data-fit={look.fit}>
        <Thumb piece={p} width={look.size === 'L' ? 960 : 480} />
        <Link
          to={`/pieces/${p.id}`}
          className="pz-hit"
          aria-label={p.title}
          onClick={(e) => {
            // While picking, a click (or Shift-click) on the picture picks; the title still opens the piece.
            if (selecting || e.shiftKey) {
              e.preventDefault();
              onToggle(p.id, e.shiftKey);
            }
          }}
        />
        <Check checked={selected} label={t('pieces.card.select', { title: p.title })} onToggle={(range) => onToggle(p.id, range)} />
        <span className="pz-ov pz-ov-state"><i style={{ background: STAGE_COLOUR[stage] }} aria-hidden="true" />{STATE_LABEL[stage]}</span>
        {v && <span className="pz-ov pz-ov-tr" title={t('pieces.card.version', { number: v.number })}>V{v.number}</span>}
        {p.open_comments > 0 && (
          <span className="pz-ov pz-ov-bl" title={t('pieces.card.comments', { count: p.open_comments })}>
            <Icon name="bubble" />{p.open_comments}
          </span>
        )}
        <span className="pz-ov-br">
          {p.variant_count > 1 && <span className="pz-ov" title={t('common.variants', { count: p.variant_count })}><Icon name="copy" />{p.variant_count}</span>}
          {media && <span className="pz-ov">{media}</span>}
        </span>
        {!look.info && <span className="pz-ov-title">{p.title}</span>}
      </div>
      {look.info && (
        <div className="pz-meta">
          <h3 className="pz-title"><Link to={`/pieces/${p.id}`} title={p.title}>{p.title}</Link></h3>
          <div className="pz-line">
            <MetaLine p={p} zone={zone} />
            <CardMenu p={p} actions={actions} />
          </div>
        </div>
      )}
    </article>
  );
}

export function GridView({ pieces, look, selected, onToggle, actions, zone }: {
  pieces: PieceSummary[];
  look: Look;
  selected: Set<string>;
  onToggle: (id: string, range: boolean) => void;
  actions: CardActions;
  zone: string;
}) {
  return (
    <div className="pz-grid" data-size={look.size} style={{ ['--pz-aspect' as string]: look.aspect.replace(':', ' / ') }}>
      {pieces.map((p) => (
        <PieceCard key={p.id} p={p} look={look} selected={selected.has(p.id)} selecting={selected.size > 0} onToggle={onToggle} actions={actions} zone={zone} />
      ))}
    </div>
  );
}

export function GridSkeleton({ look }: { look: Look }) {
  return (
    <div className="pz-grid" data-size={look.size} style={{ ['--pz-aspect' as string]: look.aspect.replace(':', ' / ') }} aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="pz-card pz-skel">
          <div className="pz-thumb"><Skeleton width="100%" height="100%" radius={0} /></div>
          {look.info && (
            <div className="pz-meta">
              <Skeleton width={`${64 + ((i * 13) % 28)}%`} height={12} />
              <Skeleton width="48%" height={10} />
              <Skeleton width={82} height={18} radius={99} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── board ─────────────────────────────

function BoardCard({ p, zone, onDragStart, onDragEnd }: { p: PieceSummary; zone: string; onDragStart: (p: PieceSummary) => void; onDragEnd: () => void }) {
  const v = p.latest_version;
  const stage = stageOf(p);
  const date = stage === 'scheduled' && p.next_publication ? when(p.next_publication.scheduled_at, zone) : ago(p.updated_at);
  return (
    <article
      className="pz-bcard"
      draggable
      aria-label={p.title}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
        onDragStart(p);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="pz-bthumb"><Thumb piece={p} width={240} /></div>
      <div className="pz-bbody">
        <Link to={`/pieces/${p.id}`} className="pz-btitle pz-hit-text" draggable={false}>{p.title}</Link>
        <div className="pz-bmeta">
          {v && <span className="pz-vtag">V{v.number}</span>}
          {p.open_comments > 0 && <span className="pz-bcount" title={t('pieces.card.comments', { count: p.open_comments })}><Icon name="bubble" />{p.open_comments}</span>}
          {p.latest_by_agent && <span className="pz-bagent" title={t('pieces.card.byAgent')}><Avatar agent size={14} /></span>}
        </div>
        <div
          className="pz-bmeta pz-bdate"
          title={stage === 'scheduled' && p.next_publication ? t('pieces.card.nextTitle', { when: date, network: netName(p.next_publication.network) }) : undefined}
        >
          {stage === 'scheduled' && <Icon name="calendar" />}
          <span>{date}</span>
        </div>
      </div>
    </article>
  );
}

export function BoardView({ pieces, zone, dragging, onDragStart, onDragEnd, onDrop, scheduleTarget }: {
  pieces: PieceSummary[];
  zone: string;
  dragging: PieceSummary | null;
  onDragStart: (p: PieceSummary) => void;
  onDragEnd: () => void;
  onDrop: (to: Stage) => void;
  /** While dragging: whether dropping on "Scheduled" means something for this piece and this person. */
  scheduleTarget: boolean;
}) {
  const [over, setOver] = useState<Stage | null>(null);
  useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);
  const groups = new Map<Stage, PieceSummary[]>(BOARD.map((s) => [s, []]));
  for (const p of pieces) groups.get(stageOf(p))?.push(p);
  const from = dragging ? stageOf(dragging) : null;
  return (
    <div className={`pz-board ${dragging ? 'is-dragging' : ''}`}>
      {BOARD.map((s) => {
        const items = groups.get(s)!;
        const accepts = s === 'scheduled' && scheduleTarget;
        return (
          <section
            key={s}
            className={`pz-col ${over === s ? (accepts ? 'is-over' : s === from ? '' : 'is-refused') : ''}`}
            aria-label={`${STATE_LABEL[s]} (${items.length})`}
            onDragOver={(e) => {
              if (!dragging) return;
              // Every other column takes the drop, so a refused one can say why; only its own column does nothing.
              e.preventDefault();
              e.dataTransfer.dropEffect = s === from ? 'none' : 'move';
              if (over !== s) setOver(s);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === s ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              onDrop(s);
            }}
          >
            <header className="pz-colh" title={s === 'scheduled' ? t('pieces.board.hint') : undefined}>
              <span className="pz-sdot" style={{ background: STAGE_COLOUR[s] }} aria-hidden="true" />
              <span className="pz-colname" style={{ color: STAGE_COLOUR[s] }}>{STATE_LABEL[s]}</span>
              <span className="pz-colcount">{items.length}</span>
            </header>
            <div className="pz-colbody">
              {accepts && <div className={`pz-drop ${over === s ? 'is-on' : ''}`}><Icon name="calendar" />{t('pieces.board.drop')}</div>}
              {items.map((p) => <BoardCard key={p.id} p={p} zone={zone} onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
              {!items.length && !accepts && <p className="pz-colempty">{t(`pieces.board.empty.${s}` as Key)}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="pz-board" aria-hidden="true">
      {BOARD.map((s, i) => (
        <section key={s} className="pz-col">
          <header className="pz-colh"><Skeleton width={96} height={12} /></header>
          <div className="pz-colbody">
            {Array.from({ length: (i % 3) + 1 }, (_, j) => (
              <div key={j} className="pz-bcard pz-skel">
                <div className="pz-bthumb"><Skeleton width="100%" height="100%" radius={0} /></div>
                <div className="pz-bbody"><Skeleton width="86%" height={10} /><Skeleton width="44%" height={10} /></div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────────── list ─────────────────────────────

const COLUMNS: { key: SortKey; label: Key; className?: string }[] = [
  { key: 'title', label: 'pieces.list.title', className: 'pz-c-title' },
  { key: 'campaign', label: 'pieces.list.campaign', className: 'pz-c-camp' },
  { key: 'state', label: 'pieces.list.state', className: 'pz-c-state' },
  { key: 'version', label: 'pieces.list.version', className: 'pz-c-ver' },
  { key: 'author', label: 'pieces.list.author', className: 'pz-c-author' },
  { key: 'comments', label: 'pieces.list.comments', className: 'pz-c-num' },
  { key: 'next', label: 'pieces.list.next', className: 'pz-c-next' },
  { key: 'updated', label: 'pieces.list.updated', className: 'pz-c-upd' },
];

export function ListView({ pieces, sort, onSort, selected, onToggle, onToggleAll, zone }: {
  pieces: PieceSummary[];
  sort: Sort;
  onSort: (s: Sort) => void;
  selected: Set<string>;
  onToggle: (id: string, range: boolean) => void;
  onToggleAll: () => void;
  zone: string;
}) {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const at = Math.min(active, Math.max(pieces.length - 1, 0));
  const all = pieces.length > 0 && pieces.every((p) => selected.has(p.id));
  const some = !all && pieces.some((p) => selected.has(p.id));
  const go = (i: number) => {
    const n = Math.max(0, Math.min(pieces.length - 1, i));
    setActive(n);
    rows.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number, p: PieceSummary) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(pieces.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); navigate(`/pieces/${p.id}`); }
    else if (e.key === ' ') { e.preventDefault(); onToggle(p.id, e.shiftKey); }
  };
  const header = (c: (typeof COLUMNS)[number]) => {
    const on = sort.key === c.key;
    return (
      <th key={c.key} className={c.className} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`pz-th ${on ? 'is-on' : ''}`} title={t(c.label)} onClick={() => onSort({ key: c.key, dir: on ? (sort.dir === 'asc' ? 'desc' : 'asc') : FIRST_DIR[c.key] })}>
          {c.key === 'comments' ? <><Icon name="bubble" className="pz-th-icon" /><span className="sr-only">{t(c.label)}</span></> : t(c.label)}
          <Icon name="chevronDown" className={`pz-th-arrow ${on && sort.dir === 'asc' ? 'is-up' : ''}`} />
        </button>
      </th>
    );
  };
  return (
    <div className="pz-table-wrap">
      <table className="pz-table">
        <caption className="sr-only">{t('pieces.list.keys')}</caption>
        <thead>
          <tr title={t('pieces.list.keys')}>
            <th className="pz-c-check">
              <button type="button" role="checkbox" aria-checked={all ? 'true' : some ? 'mixed' : 'false'} aria-label={t('pieces.list.selectAll')} title={t('pieces.list.selectAllHint')} className={`pz-check pz-check-inline ${some ? 'is-mixed' : ''}`} onClick={onToggleAll}>
                {all && <Icon name="check" />}
              </button>
            </th>
            <th className="pz-c-thumb"><span className="sr-only">{t('pieces.list.preview')}</span></th>
            {COLUMNS.map(header)}
          </tr>
        </thead>
        <tbody>
          {pieces.map((p, i) => {
            const v = p.latest_version;
            const on = selected.has(p.id);
            return (
              <tr
                key={p.id}
                ref={(el) => { rows.current[i] = el; }}
                tabIndex={i === at ? 0 : -1}
                className={on ? 'is-selected' : ''}
                aria-selected={on}
                onFocus={() => setActive(i)}
                onKeyDown={(e) => onKey(e, i, p)}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a, button')) return;
                  if (e.shiftKey || e.metaKey || e.ctrlKey || selected.size) onToggle(p.id, e.shiftKey);
                  else navigate(`/pieces/${p.id}`);
                }}
              >
                <td className="pz-c-check">
                  <Check checked={on} label={t('pieces.card.select', { title: p.title })} onToggle={(range) => onToggle(p.id, range)} className="pz-check-inline" />
                </td>
                <td className="pz-c-thumb"><span className="pz-lthumb"><Thumb piece={p} width={240} /></span></td>
                <td className="pz-c-title">
                  <Link to={`/pieces/${p.id}`} tabIndex={-1} className="pz-ltitle" title={p.title}>{p.title}</Link>
                  <span className="pz-lsub">
                    {[tMaybe(`kind.${p.kind}`, p.kind), mediaLabel(p)].filter(Boolean).join(' · ')}
                    {p.campaign_name && <span className="pz-lsub-camp"> · {p.campaign_name}</span>}
                  </span>
                </td>
                <td className="pz-c-camp">{p.campaign_name ?? <span className="pz-none">—</span>}</td>
                <td className="pz-c-state"><Chip state={stageOf(p)} /></td>
                <td className="pz-c-ver">{v ? <span className="pz-vtag">V{v.number}</span> : <span className="pz-none">—</span>}</td>
                <td className="pz-c-author">
                  {!v ? <span className="pz-none">—</span> : <span className="pz-by">{v.by_agent ? <Avatar agent size={18} /> : <Avatar name={v.author} size={18} />}<span className="pz-by-name">{v.by_agent ? t('common.agent') : v.author}</span></span>}
                </td>
                <td className="pz-c-num">{p.open_comments ? <span className="pz-lcount"><Icon name="bubble" />{p.open_comments}</span> : <span className="pz-none">—</span>}</td>
                <td className="pz-c-next">
                  {p.next_publication ? (
                    <span className="pz-lnext"><NetMark network={p.next_publication.network} size="sm" labelled />{when(p.next_publication.scheduled_at, zone)}</span>
                  ) : (
                    <span className="pz-none">—</span>
                  )}
                </td>
                <td className="pz-c-upd"><time dateTime={p.updated_at}>{ago(p.updated_at)}</time></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="pz-table-wrap" aria-hidden="true">
      <table className="pz-table">
        <tbody>
          {Array.from({ length: 8 }, (_, i) => (
            <tr key={i}>
              <td className="pz-c-check" />
              <td className="pz-c-thumb"><Skeleton width={32} height={40} radius={5} /></td>
              <td className="pz-c-title"><Skeleton width={`${50 + ((i * 17) % 40)}%`} height={11} /><Skeleton width="30%" height={9} style={{ marginTop: 6 }} /></td>
              <td colSpan={7}><Skeleton width={`${30 + ((i * 11) % 30)}%`} height={11} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── empty ─────────────────────────────

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="pz-empty" role="status">
      <p>{title}</p>
      {action}
    </div>
  );
}
