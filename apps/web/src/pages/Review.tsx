import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Account, type Anchor, type CommentThread, type DrawColour, type Integrations, type PieceDetail, type Shape, type VersionDetail, type VersionSummary } from '../api';
import { Avatar, displayName } from '../components/Avatar';
import { ago, CommentsPanel, NO_FILTER, numberThreads, type CommentFilter, type ComposeHint } from '../components/comments';
import type { Tool } from '../components/Drawing';
import { Icon } from '../components/icons';
import { approvedAccountIds, ScheduleDialog } from '../components/publications';
import { SubtitlePanel } from '../components/Subtitles';
import { Chip, ConfirmDialog, CopyButton, Dialog, ErrorBox, Field, Menu, MenuItem, MenuLabel, MenuSeparator, NetMark, Select, Skeleton, Tip, useToast } from '../components/ui';
import { CompareStage, liveVideo, shortName, Stage, timecode, type DrawProps, type Jump, type SafeZone } from '../components/viewer';
import { t, tMaybe } from '../i18n';
import { fmtBytes, fmtDateTime, NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import { playhead } from '../lib/playhead';
import { useSession } from '../lib/session';
import { useStableUrls } from '../lib/stableUrls';
import '../styles/review.css';

const LIVE = ['in_review', 'changes_requested', 'approved'];

/** Something kept in this browser between visits (which panel is open, the colour to draw with), and never required. */
function useKept<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T | null) ?? initial; } catch { return initial; }
  });
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, x); } catch { /* not kept */ } }, [key]);
  return [v, set];
}

/** "3 min ago", or "just now". */
function agoPhrase(iso: string): string {
  const short = ago(iso);
  return short === t('review.ago.now') ? t('review.ago.justNow') : t('review.ago.phrase', { when: short });
}

const formatName = (format: string) => tMaybe(`piece.formatName.${format}`, format);
const variantName = (v: { format: string; style: string }) => `${formatName(v.format)} · ${v.style || tMaybe(`piece.formatHint.${v.format}`, v.format)}`;

/** Who uploaded a version, said for people: a person's short name, or the agent and whose token it used. */
function uploaderOf(v: VersionDetail): { who: string; via?: string; agent: boolean; title?: string } {
  const u = v.uploaded_by;
  if (u?.kind === 'token') {
    const owner = shortName(displayName(u.created_by.name, u.created_by.email ?? null));
    const known = owner && owner !== '?';
    return {
      who: t('review.left.agent'),
      via: known ? t('review.uploader.tokenOf', { owner }) : undefined,
      agent: true,
      title: known ? t('review.uploader.agent', { owner, name: u.name }) : t('review.uploader.agentAlone', { name: u.name }),
    };
  }
  if (u?.kind === 'user') return { who: shortName(displayName(u.name, u.email ?? null)), agent: false };
  return { who: v.author ? shortName(v.author) : t('review.decision.unknown'), agent: v.by_agent };
}

// ───────────────────────────── decisions ─────────────────────────────

function DecisionDialog({ version, decision, openCount, onClose, onSeeComments }: {
  version: VersionDetail;
  decision: 'approve' | 'reject';
  openCount: number;
  onClose: () => void;
  onSeeComments: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { brand } = useSession();
  const rules = version.brand.approval_rules;
  const { data: accounts } = useQuery({ queryKey: ['accounts', brand.id], queryFn: () => api.get<Account[]>(`/api/brands/${brand.id}/accounts`) });
  const usable = (accounts ?? []).filter((a) => a.status !== 'reconnect_required');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(usable.length === 1 ? [usable[0]!.id] : []);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const approving = decision === 'approve';
  const send = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/approvals`, { decision, accountIds: [...chosen], checklist: checks, note }),
    onSuccess: () => {
      for (const k of ['version', 'comments', 'piece', 'pieces']) qc.invalidateQueries({ queryKey: [k] });
      toast(approving ? t('review.approve.done') : t('review.reject.done'));
      onClose();
    },
  });
  const toggle = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  const allChecked = rules.checklist.every((c) => checks[c]);
  const ready = approving ? chosen.size > 0 && allChecked && openCount === 0 : note.trim().length > 0;

  return (
    <Dialog title={approving ? t('review.approve.title', { n: version.number }) : t('review.reject.title', { n: version.number })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        {approving ? (
          <>
            <p className="muted">
              {t('review.approve.tied')}
              {rules.required_approvals > 1 && <> {t('review.approve.needs', { count: rules.required_approvals })}</>}
            </p>
            <p className="small muted rv-fp">{t('review.details.fingerprint')} <span className="mono">{version.fingerprint.slice(0, 12)}</span></p>
            {openCount > 0 && (
              <div className="notice notice-warn rv-notice-row" role="alert">
                <span>{t('review.approve.openBlock', { count: openCount })}</span>
                <button type="button" className="btn btn-small" onClick={() => { onClose(); onSeeComments(); }}>{t('review.approve.seeComments')}</button>
              </div>
            )}
            <fieldset className="options">
              <legend>{t('review.approve.accounts')}</legend>
              <div className="stack">
                {usable.length === 0 && <span className="muted">{t('review.approve.noAccounts')}</span>}
                {usable.map((a) => (
                  <label key={a.id} className="check rv-acct">
                    <input type="checkbox" checked={chosen.has(a.id)} onChange={() => toggle(a.id)} />
                    <NetMark network={a.network} size="sm" />
                    <span>{NETWORK_LABEL[a.network] ?? a.network} · {a.display_name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {rules.checklist.length > 0 && (
              <fieldset className="options">
                <legend>{t('review.approve.checklist')}</legend>
                <div className="stack">
                  {rules.checklist.map((item) => (
                    <label key={item} className="check">
                      <input type="checkbox" checked={!!checks[item]} onChange={(e) => setChecks({ ...checks, [item]: e.target.checked })} />
                      <span>{item}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <Field label={t('review.approve.note')}><textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 56 }} /></Field>
          </>
        ) : (
          <>
            <p className="muted">{t('review.reject.lead')}</p>
            <Field label={t('review.reject.reason')}><textarea required autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </>
        )}
        {send.error && <ErrorBox error={send.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className={`btn ${approving ? 'btn-primary' : 'btn-danger'}`} disabled={!ready || send.isPending}>{approving ? t('review.approve.submit') : t('review.reject.submit')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Asking for changes: the open comments go back with the version; with none open, a note says what to change. */
function RequestChanges({ version, openCount, onClose }: { version: VersionDetail; openCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/request-changes`, { note }),
    onSuccess: () => {
      for (const k of ['version', 'comments', 'piece', 'pieces']) qc.invalidateQueries({ queryKey: [k] });
      toast(t('review.changes.done'));
      onClose();
    },
    onError: () => {},
  });
  return (
    <ConfirmDialog
      title={t('review.changes.title')}
      confirmLabel={t('review.changes.submit')}
      busy={send.isPending || (openCount === 0 && !note.trim())}
      onConfirm={() => send.mutate()}
      onCancel={onClose}
      text={
        <div className="stack rv-changes">
          <p className="muted">{openCount > 0 ? t('review.changes.withOpen', { count: openCount }) : t('review.changes.noneOpen')}</p>
          <Field label={openCount > 0 ? t('review.changes.noteOptional') : t('review.changes.what')}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus={openCount === 0} />
          </Field>
          {send.error && <ErrorBox error={send.error} />}
        </div>
      }
    />
  );
}

type DialogKind = null | 'approve' | 'reject' | 'changes' | 'schedule';

/** What the person looking at a version can decide on it, and what to say when they cannot. */
function useDecision(v: VersionDetail, openCount: number) {
  const { me, can } = useSession();
  const mine = v.approvals.find((a) => a.approver === (me.user.name ?? me.user.email) || a.approver === me.user.email);
  const isAuthor = v.author_user_id === me.user.id;
  const valid = v.approvals.filter((a) => a.decision === 'approve' && a.matches_fingerprint).length;
  const required = v.brand.approval_rules.required_approvals;
  const latest = [...v.versions].sort((a, b) => b.number - a.number)[0];
  const inReview = v.review_state === 'in_review';
  const canDecide = inReview && can('approve') && !isAuthor && !mine;
  const approveBlocked = inReview && can('approve') ? (isAuthor ? t('review.decision.isAuthor') : mine ? (mine.decision === 'approve' ? t('review.decision.alreadyApproved') : t('review.decision.alreadyRejected')) : null) : null;
  // What the state chip says: the state, and for an approved version, for how many accounts.
  const stateLabel = v.review_state === 'approved' ? t('review.decision.approvedFor', { count: approvedAccountIds(v).length }) : undefined;
  const approvals = inReview && required > 1 ? { done: valid, count: required } : null;
  return { can, inReview, canDecide, approveBlocked, latest, mine, isAuthor, stateLabel, approvals };
}

/** The state, quietly: a dot and a word, and how many approvals it has when it needs more than one. */
function StateLine({ v, openCount }: { v: VersionDetail; openCount: number }) {
  const d = useDecision(v, openCount);
  return (
    <span className="rv-state">
      <Chip state={v.review_state} label={d.stateLabel} />
      {d.approvals && <span className="rv-meta-n" title={t('review.decision.approvalsOf', d.approvals)}><Icon name="check" size={13} />{d.approvals.done}/{d.approvals.count}</span>}
    </span>
  );
}

/** The decision buttons: in the top bar on a wide screen, at the bottom of the screen on a phone. */
function DecisionButtons({ v, openCount, onDialog, compact }: { v: VersionDetail; openCount: number; onDialog: (d: DialogKind) => void; compact?: boolean }) {
  const d = useDecision(v, openCount);
  if (d.inReview) {
    return (
      <>
        {d.can('requestChanges') && <button type="button" className="btn rv-btn" onClick={() => onDialog('changes')}>{t('review.decision.requestChanges')}</button>}
        {d.can('approve') && (d.approveBlocked ? (
          <Tip label={d.approveBlocked}>
            <span className="rv-btn-wrap" tabIndex={0}>
              <button type="button" className="btn btn-primary rv-btn" disabled>{!compact && <Icon name="check" size={15} />}{t('review.decision.approve')}</button>
            </span>
          </Tip>
        ) : (
          <button type="button" className="btn btn-primary rv-btn" onClick={() => onDialog('approve')}>
            {!compact && <Icon name="check" size={15} />}{t('review.decision.approve')}
          </button>
        ))}
      </>
    );
  }
  if (v.review_state === 'changes_requested' && d.can('upload')) {
    return <Link className="btn rv-btn" to={`/pieces/${v.piece.id}`}><Icon name="upload" size={15} />{t('review.decision.uploadNew')}</Link>;
  }
  if (v.review_state === 'approved' && d.can('schedule')) {
    return <button type="button" className="btn btn-primary rv-btn" onClick={() => onDialog('schedule')}><Icon name="calendar" size={15} />{t('review.decision.schedule')}</button>;
  }
  if (v.review_state === 'superseded' && d.latest && d.latest.id !== v.id) {
    return <Link className="btn rv-btn" to={`/review/${d.latest.id}`}>{t('review.decision.toLatest', { n: d.latest.number })}</Link>;
  }
  return null;
}

/** The "⋯" menu: rejecting (the decision nobody should press by mistake), the piece, and the link to this review. */
function MoreMenu({ v, openCount, onDialog }: { v: VersionDetail; openCount: number; onDialog: (d: DialogKind) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const d = useDecision(v, openCount);
  return (
    <Menu trigger={<button type="button" className="rv-ic" aria-label={t('review.decision.menu')}><Icon name="more" size={18} /></button>} width={220}>
      {d.canDecide && <MenuItem icon="ban" danger onSelect={() => onDialog('reject')}>{t('review.decision.reject')}</MenuItem>}
      <MenuItem icon="external" onSelect={() => navigate(`/pieces/${v.piece.id}`)}>{t('review.decision.toPiece')}</MenuItem>
      <MenuItem
        icon="link"
        onSelect={async () => {
          try { await navigator.clipboard.writeText(window.location.href); toast(t('common.copied')); } catch { toast(t('common.copyFailed'), 'error'); }
        }}
      >
        {t('review.decision.copyLink')}
      </MenuItem>
    </Menu>
  );
}

// ───────────────────────────── top bar ─────────────────────────────

/** The version being looked at, as a button: its menu lists every version of the variant, who made it and when. */
function VersionMenu({ v, versions }: { v: VersionDetail; versions: VersionSummary[] }) {
  const navigate = useNavigate();
  const list: (Partial<VersionSummary> & { id: string; number: number })[] = [...(versions.length ? versions : v.versions)].sort((a, b) => b.number - a.number);
  return (
    <Menu
      align="start"
      width={290}
      trigger={
        <button type="button" className="rv-vbtn" aria-label={t('review.versions.button', { n: v.number })}>
          <span className="mono">V{v.number}</span><Icon name="chevronDown" size={14} />
        </button>
      }
    >
      <MenuLabel>{t('review.versions.label')}</MenuLabel>
      {list.map((x) => (
        <MenuItem
          key={x.id}
          checked={x.id === v.id}
          lead={<span className="rv-vrow-n mono">V{x.number}</span>}
          hint={<span className="rv-vrow-meta">{x.review_state && <Chip state={x.review_state} />}{x.created_at && <span>{ago(x.created_at)}</span>}</span>}
          onSelect={() => { if (x.id !== v.id) navigate(`/review/${x.id}`); }}
        >
          <span className={x.by_agent ? 'rv-agent-name' : ''}>{x.by_agent ? t('review.left.agent') : x.author ? shortName(x.author) : ''}</span>
        </MenuItem>
      ))}
    </Menu>
  );
}

/** Comparing with another version: the previous one at a click, any other from the menu, and off again. */
function CompareControl({ v, compareId, onCompare }: { v: VersionDetail; compareId: string; onCompare: (id: string) => void }) {
  const others = [...v.versions].filter((x) => x.id !== v.id).sort((a, b) => b.number - a.number);
  if (!others.length) return null;
  const previous = others.find((x) => x.number < v.number) ?? others[0]!;
  const on = others.find((x) => x.id === compareId);
  const pick = (
    <>
      <MenuLabel>{t('review.compare.with')}</MenuLabel>
      {others.map((x) => (
        <MenuItem key={x.id} checked={x.id === compareId} lead={<span className="rv-vrow-n mono">V{x.number}</span>} onSelect={() => onCompare(x.id)}>
          {x.number < v.number ? t('review.compare.earlier') : t('review.compare.later')}
        </MenuItem>
      ))}
      {on && (
        <>
          <MenuSeparator />
          <MenuItem icon="x" onSelect={() => onCompare('')}>{t('review.compare.stop')}</MenuItem>
        </>
      )}
    </>
  );
  return (
    <div className={`rv-menu-wrap rv-cmpctl ${on ? 'on' : ''}`}>
      {on ? (
        <>
          <Menu align="start" width={220} trigger={
            <button type="button" className="rv-cmp-on" aria-label={t('review.compare.pick')}>
              <Icon name="compare" size={15} /><span className="rv-cmp-label">{t('review.compare.comparing', { n: on.number })}</span><Icon name="chevronDown" size={13} />
            </button>
          }>
            {pick}
          </Menu>
          <Tip label={t('review.compare.stop')} shortcut="Esc">
            <button type="button" className="rv-cmp-x" onClick={() => onCompare('')} aria-label={t('review.compare.stop')}><Icon name="x" size={14} /></button>
          </Tip>
        </>
      ) : (
        <>
          <Tip label={t('review.compare.withN', { n: previous.number })}>
            <button type="button" className="rv-ghost" onClick={() => onCompare(previous.id)}>
              <Icon name="compare" size={15} /><span className="rv-cmp-label">{t('review.compare.withN', { n: previous.number })}</span>
            </button>
          </Tip>
          {others.length > 1 && (
            <Menu align="start" width={220} trigger={
              <button type="button" className="rv-ghost rv-ghost-ic" aria-label={t('review.compare.pick')}><Icon name="chevronDown" size={13} /></button>
            }>
              {pick}
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

/** Everyone who took part in this version: who uploaded it, who commented or answered, who decided. */
function Participants({ v, threads }: { v: VersionDetail; threads: CommentThread[] }) {
  const people = new Map<string, number>();
  let agent = v.by_agent;
  const add = (name: string | null | undefined) => { if (name) people.set(shortName(name), (people.get(shortName(name)) ?? 0) + 1); };
  if (!v.by_agent) add(v.author);
  for (const c of threads) {
    add(c.author);
    for (const r of c.replies) if (r.by_agent) agent = true; else add(r.author);
  }
  for (const a of v.approvals) add(a.approver);
  const names = [...people].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const shown = names.slice(0, agent ? 3 : 4);
  const more = names.length - shown.length;
  if (!names.length && !agent) return null;
  const all = [...names, ...(agent ? [t('review.left.agent')] : [])].join(', ');
  return (
    <span className="avatars rv-people" title={all} role="group" aria-label={`${t('review.people.label')}: ${all}`}>
      {shown.map((n) => <Avatar key={n} name={n} size={26} title="" />)}
      {agent && <Avatar agent size={26} title="" />}
      {more > 0 && <span className="avatar rv-people-more">+{more}</span>}
    </span>
  );
}

// ───────────────────────────── left pane ─────────────────────────────

/** What this version brings, a few lines until asked for the rest. */
function Notes({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <>
      <p ref={ref} className={`rv-notes ${open ? '' : 'clamp'}`}>{text}</p>
      {(long || open) && <button type="button" className="rv-link" onClick={() => setOpen(!open)}>{open ? t('review.decision.less') : t('review.decision.more')}</button>}
    </>
  );
}

/** Who uploaded the version and when, as a meta line: the agent's mark and whose token, or the person. */
function Uploader({ v, full }: { v: VersionDetail; full?: boolean }) {
  const up = uploaderOf(v);
  return (
    <p className="rv-up" title={up.title}>
      {up.agent ? <Avatar agent size={18} /> : <Avatar name={up.who} size={18} />}
      <span>
        <b className={up.agent ? 'agent' : ''}>{up.who}</b>
        {up.via && <> · {up.via}</>}
        {' · '}<time dateTime={v.created_at} title={fmtDateTime(v.created_at, v.brand.timezone)}>{full ? fmtDateTime(v.created_at, v.brand.timezone) : agoPhrase(v.created_at)}</time>
      </span>
    </p>
  );
}

function VariantThumb({ versionId }: { versionId?: string }) {
  const [failed, setFailed] = useState(false);
  if (!versionId || failed) return <span className="rv-vthumb ph" aria-hidden="true"><Icon name="image" size={16} /></span>;
  return <img className="rv-vthumb" src={`/api/versions/${versionId}/thumb?w=240`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** The left pane: the piece's variants, the versions of this one, and what this version changes. */
function LeftPane({ v, piece, threads, onShowResolved }: { v: VersionDetail; piece: PieceDetail | undefined; threads: CommentThread[]; onShowResolved: () => void }) {
  const variant = piece?.variants.find((x) => x.id === v.variant.id);
  const versions = [...(variant?.versions ?? [])].sort((a, b) => b.number - a.number);
  const carried = threads.filter((c) => c.version_id !== v.id);
  const fixedHere = carried.filter((c) => c.status === 'resolved' && c.resolved_in_number === v.number).length;
  return (
    <aside className="rv-left" aria-label={t('review.left.label')}>
      <div className="rv-left-scroll">
        <h2 className="rv-lab">{t('review.left.variants')}</h2>
        {!piece ? (
          <div className="rv-vlist"><Skeleton height={64} radius={10} /><Skeleton height={64} radius={10} /></div>
        ) : (
          <nav className="rv-vlist" aria-label={t('review.left.variants')}>
            {piece.variants.map((x) => {
              const latest = [...x.versions].sort((a, b) => b.number - a.number)[0];
              const here = x.id === v.variant.id;
              const open = x.versions.reduce((n, y) => n + (y.open_comments ?? 0), 0);
              const body = (
                <>
                  <VariantThumb versionId={latest?.id} />
                  <span className="rv-vtext">
                    <b title={variantName(x)}>{variantName(x)}</b>
                    <span>
                      {latest ? `V${latest.number}` : t('review.left.noVersion')}
                      {open > 0 && <span className="rv-meta-n" title={t('review.left.openCount', { count: open })}><Icon name="bubble" size={12} />{open}</span>}
                      {latest && latest.review_state !== 'in_review' && <Chip state={latest.review_state} />}
                    </span>
                  </span>
                </>
              );
              return here || !latest ? (
                <div key={x.id} className={`rv-vitem ${here ? 'on' : ''}`} aria-current={here ? 'true' : undefined}>{body}</div>
              ) : (
                <Link key={x.id} className="rv-vitem" to={`/review/${latest.id}`}>{body}</Link>
              );
            })}
          </nav>
        )}

        <h2 className="rv-lab">{t('review.left.versions')}</h2>
        <nav className="rv-vers" aria-label={t('review.left.versions')}>
          {(versions.length ? versions : [...v.versions].sort((a, b) => b.number - a.number)).map((x) => {
            const s = x as Partial<VersionSummary> & { id: string; number: number };
            const here = s.id === v.id;
            const row = (
              <>
                <span className="rv-vn mono">V{s.number}</span>
                <span className={`rv-vwho ${s.by_agent ? 'agent' : ''}`}>{s.by_agent ? t('review.left.agent') : s.author ? shortName(s.author) : ''}</span>
                <span className="rv-vwhen">{s.created_at ? ago(s.created_at) : ''}</span>
              </>
            );
            return here ? (
              <div key={s.id} className="rv-vr on" aria-current="page">{row}</div>
            ) : (
              <Link key={s.id} className="rv-vr" to={`/review/${s.id}`} title={s.review_state ? STATE_LABEL[s.review_state] : undefined}>{row}</Link>
            );
          })}
        </nav>

        <h2 className="rv-lab">{t('review.left.changes', { n: v.number })}</h2>
        <div className="rv-changes-box">
          {v.notes ? <Notes text={v.notes} /> : <p className="rv-notes muted">{t('review.left.noNotes')}</p>}
          {carried.length > 0 && (
            <button type="button" className="rv-resolves" onClick={onShowResolved} title={t('review.left.resolvesHint')}>
              <Icon name="check" size={13} />{t('review.left.resolves', { done: fixedHere, count: carried.length })}
            </button>
          )}
          <Uploader v={v} />
        </div>
      </div>
    </aside>
  );
}

// ───────────────────────────── details ─────────────────────────────

const ASSET_KIND: Record<string, () => string> = {
  video: () => t('review.asset.video'),
  image: () => t('review.asset.image'),
  pdf: () => t('review.asset.pdf'),
  subtitles: () => t('review.asset.subtitles'),
  cover: () => t('review.asset.cover'),
};

function Details({ v }: { v: VersionDetail }) {
  return (
    <div className="rv-details">
      <section className="rv-block">
        <h3>{t('review.details.version')}</h3>
        <p className="rv-meta">
          <span className="tag">{variantName(v.variant)}</span>
          <span className="tag">V{v.number}</span>
          {v.piece.ai_generated && <span className="tag">{t('review.meta.ai')}</span>}
        </p>
        <Uploader v={v} full />
        {v.notes && <p className="rv-prose">{v.notes}</p>}
      </section>
      <section className="rv-block">
        <h3>{t('review.details.approvals')}</h3>
        {v.approvals.length === 0 && <p className="muted small">{t('review.details.noDecisions')}</p>}
        {v.approvals.map((a) => (
          <div key={a.id} className="rv-approval">
            <div className="rv-approval-h">
              <Avatar name={shortName(a.approver)} size={22} />
              <strong>{shortName(a.approver)}</strong>
              <Chip state={a.decision === 'approve' ? 'approved' : 'rejected'} label={a.decision === 'approve' ? t('review.details.approved') : t('review.details.rejected')} />
              <span className="grow" />
              <time className="muted small" dateTime={a.created_at}>{fmtDateTime(a.created_at, v.brand.timezone)}</time>
            </div>
            {!a.matches_fingerprint && <span className="chip chip-failed">{t('review.details.changedSince')}</span>}
            {a.note && <p className="rv-quote">“{a.note}”</p>}
          </div>
        ))}
      </section>
      <section className="rv-block">
        <div className="row-between"><h3>{t('review.details.fingerprint')}</h3><CopyButton text={v.fingerprint} /></div>
        <span className="mono rv-hash" title={t('review.details.fingerprintHint')}>{v.fingerprint}</span>
      </section>
      <section className="rv-block">
        <h3>{t('review.details.files')}</h3>
        {v.assets.map((a) => (
          <div key={a.id} className="rv-file">
            <div className="rv-file-main">
              <span className="rv-file-name" title={a.name}>{a.name}</span>
              <span className="muted small">
                {ASSET_KIND[a.kind]?.() ?? a.kind} · <span className="mono">{fmtBytes(a.bytes)}</span>
                {a.width && a.height ? <> · <span className="mono">{a.width}×{a.height}</span></> : null}
                {a.kind === 'video' && Number(a.duration_ms) > 0 ? <> · <span className="mono">{timecode(Number(a.duration_ms) / 1000)}</span></> : null}
              </span>
            </div>
            <Tip label={t('common.download')}>
              <a className="rv-ic rv-ic-filled" href={a.url} download={a.name} aria-label={`${t('common.download')} ${a.name}`}><Icon name="download" size={16} /></a>
            </Tip>
          </div>
        ))}
      </section>
      {v.piece.brief && (
        <section className="rv-block">
          <h3>{t('review.details.brief')}</h3>
          <p className="rv-prose">{v.piece.brief}</p>
        </section>
      )}
    </div>
  );
}

// ───────────────────────────── the page ─────────────────────────────

export function ReviewPage() {
  const { versionId = '' } = useParams();
  // Another version is another review: the place being commented, the comparison and the open tab start afresh.
  return <Review key={versionId} versionId={versionId} />;
}

type Tab = 'comments' | 'subtitles' | 'details';

/** Whether two places are on the same picture (the same video, or the same page), so a drawing made on one fits the other. */
function samePicture(a: Anchor | null, b: Anchor | null) {
  if (!a || !b || a.type !== b.type) return false;
  return a.type === 'time' ? (a.position ?? 0) === ((b as typeof a).position ?? 0) : a.page === (b as typeof a).page;
}

function ReviewSkeleton() {
  return (
    <div className="rv rv-loading" aria-busy="true">
      <header className="rv-top"><Skeleton width={260} height={18} /><span className="grow" /><Skeleton width={200} height={32} radius={8} /></header>
      <div className="rv-body">
        <div className="rv-left"><div className="rv-left-scroll"><Skeleton height={64} radius={10} /><Skeleton height={140} radius={10} /></div></div>
        <div className="rv-center"><Skeleton className="rv-skel-stage" /></div>
        <div className="rv-side"><div className="rv-scroll"><Skeleton height={96} radius={12} /><Skeleton height={96} radius={12} /><Skeleton height={96} radius={12} /></div></div>
      </div>
    </div>
  );
}

/**
 * The review: a full-height workspace, Frame.io's way. A top bar with where this is, the version, the comparison, who took part
 * and the decision; under it three panels: the piece's variants and versions (it folds away), the picture with its controls and
 * timeline, and the comments. Only the lists scroll. On a phone the picture sticks to the top, the comments scroll under it and
 * the decision waits at the bottom.
 */
function Review({ versionId }: { versionId: string }) {
  const { me, brand, can } = useSession();
  const [draft, setDraftState] = useState<Anchor | null>(null);
  const [sketch, setSketch] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [colour, setColour] = useKept<DrawColour>('studio.review.colour', 'yellow');
  const [left, setLeft] = useKept<'open' | 'closed'>('studio.review.left', 'open');
  const sketchOwnsDraft = useRef(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [tab, setTab] = useState<Tab>('comments');
  const [filter, setFilter] = useState<CommentFilter>(NO_FILTER);
  const [compareId, setCompareId] = useState('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [zoneId, setZoneId] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef<HTMLDivElement>(null);
  const stable = useStableUrls();
  const { data: integ } = useQuery({ queryKey: ['integrations', brand.id], queryFn: () => api.get<Integrations>(`/api/brands/${brand.id}/integrations`) });

  const { data: v, error, isLoading } = useQuery({ queryKey: ['version', versionId], queryFn: () => api.get<VersionDetail>(`/api/versions/${versionId}`) });
  const { data: threads = [] } = useQuery({
    queryKey: ['comments', versionId],
    queryFn: () => api.get<CommentThread[]>(`/api/versions/${versionId}/comments?carried=true`),
  });
  const { data: other } = useQuery({
    queryKey: ['version', compareId],
    enabled: !!compareId,
    queryFn: () => api.get<VersionDetail>(`/api/versions/${compareId}`),
  });
  const pieceId = v?.piece.id;
  const { data: piece } = useQuery({
    queryKey: ['piece', pieceId],
    enabled: !!pieceId,
    queryFn: () => api.get<PieceDetail & { campaign_id?: string | null }>(`/api/pieces/${pieceId}`),
  });
  const campaignId = (piece as (PieceDetail & { campaign_id?: string | null }) | undefined)?.campaign_id;
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', brand.id], enabled: !!campaignId, queryFn: () => api.get<{ id: string; name: string }[]>(`/api/brands/${brand.id}/campaigns`) });

  // On a phone the stage sticks to the top: the comments brought into view leave room for it.
  useEffect(() => {
    const el = stick.current, top = root.current;
    if (!el || !top) return;
    const ro = new ResizeObserver(() => top.style.setProperty('--rv-stick', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [v?.id, compareId]);

  // A place chosen by hand (a click, a drag, a subtitle line) keeps the drawing only if it is on the same picture.
  const setDraft = useCallback((a: Anchor | null) => {
    sketchOwnsDraft.current = false;
    setDraftState((before) => {
      if (!a || !samePicture(a, before)) setSketch([]);
      return a;
    });
    if (!a) setTool(null);
  }, []);
  const clearAll = useCallback(() => { sketchOwnsDraft.current = false; setDraftState(null); setSketch([]); setTool(null); }, []);
  const draw: DrawProps = {
    tool,
    onTool: setTool,
    colour,
    onColour: setColour,
    sketch,
    onSketch: (shapes, base) => {
      setSketch(shapes);
      setTab('comments');
      setDraftState((d) => {
        // The first stroke places the comment (the moment, or the box the drawing covers); after that a drawn box follows the drawing.
        if (!d) { sketchOwnsDraft.current = true; return base; }
        if (sketchOwnsDraft.current && d.type === 'region' && base.type === 'region') return base;
        return d;
      });
    },
    onUndo: () => setSketch((s) => {
      const next = s.slice(0, -1);
      if (!next.length && sketchOwnsDraft.current) { sketchOwnsDraft.current = false; setDraftState(null); }
      return next;
    }),
    onClear: () => { setSketch([]); if (sketchOwnsDraft.current) { sketchOwnsDraft.current = false; setDraftState(null); } },
  };

  if (isLoading) return <ReviewSkeleton />;
  if (error) return <div className="rv-error"><ErrorBox error={error} /></div>;
  if (!v) return null;

  const assets = v.assets.map((a) => ({ ...a, url: stable(a.id, a.url) }));
  const otherAssets = other?.assets.map((a) => ({ ...a, url: stable(a.id, a.url) }));
  const stableThreads = threads.map((c) => (c.frame_url ? { ...c, frame_url: stable(c.id, c.frame_url) } : c));
  const numbers = numberThreads(stableThreads);
  const live = LIVE.includes(v.review_state);
  const hasPdf = assets.some((a) => a.kind === 'pdf');
  const hasVideo = assets.some((a) => a.kind === 'video');
  const hasImage = assets.some((a) => a.kind === 'image');
  const hasSubtitles = assets.some((a) => a.kind === 'subtitles');
  const hint: ComposeHint = compareId ? 'none' : hasPdf ? 'pdf' : hasImage && !hasVideo ? 'image' : hasVideo ? 'video' : 'none';
  // Every placement that knows what its network draws over the picture, for the "what the network covers" overlay.
  const safeZones: (SafeZone & { id: string })[] = Object.values(integ?.capabilities ?? {}).flatMap((c) =>
    c.placements.flatMap((pl) => (pl.safeZones ? [{ id: `${c.network}:${pl.id}`, label: `${NETWORK_LABEL[c.network] ?? c.network} · ${pl.label}`, ...pl.safeZones }] : [])));
  const openCount = stableThreads.filter((c) => c.status === 'open').length;
  const canAnnotate = can('comment') && live;
  const shownTab: Tab = tab === 'subtitles' && (!hasSubtitles || compareId) ? 'comments' : tab;
  const variantVersions = piece?.variants.find((x) => x.id === v.variant.id)?.versions ?? [];
  const campaign = campaigns?.find((c) => c.id === campaignId);
  const leftOpen = left === 'open';
  // A comment takes the stage to its place: the moment (paused there) or the page, and lights up its mark.
  const jumpTo = (c: CommentThread) => {
    setFocus(c.id);
    const a = c.anchor;
    if (a?.type === 'time') setJump({ nonce: Date.now(), t: a.t, position: a.position });
    else if (a?.type === 'region') setJump({ nonce: Date.now(), page: a.page });
  };
  const toComments = (id?: string) => { if (id) setFocus(id); setTab('comments'); };
  const onDialog = (d: DialogKind) => setDialog(d);

  const zoneTools = !compareId && !hasPdf && safeZones.length > 0 ? (
    <Select
      className={`rv-zone ${zoneId ? 'on' : ''}`}
      label={t('review.zone.label')}
      placeholder={t('review.zone.prompt')}
      value={zoneId || undefined}
      onChange={(id) => setZoneId(id === 'none' ? '' : id)}
      options={[
        ...(zoneId ? [{ value: 'none', label: t('review.zone.off') }] : []),
        ...safeZones.map((z) => ({ value: z.id, label: z.label, icon: <NetMark network={z.id.split(':')[0]!} size="xs" /> })),
      ]}
    />
  ) : null;

  return (
    <div ref={root} className={`rv ${leftOpen ? 'left-open' : 'left-closed'}`}>
      <header className="rv-top">
        <Tip label={t('review.left.toggle')} side="bottom">
          <button type="button" className="rv-ic rv-left-toggle" aria-pressed={leftOpen} onClick={() => setLeft(leftOpen ? 'closed' : 'open')} aria-label={t('review.left.toggle')}>
            <Icon name="panel" size={17} />
          </button>
        </Tip>
        <Tip label={t('review.back')} side="bottom">
          <Link to={`/pieces/${v.piece.id}`} className="rv-ic rv-back" aria-label={t('review.back')}><Icon name="arrowLeft" size={17} /></Link>
        </Tip>
        <nav className="rv-crumbs" aria-label={t('review.crumbs.label')}>
          {campaign ? <Link to={`/pieces?campaign=${campaign.id}`} className="rv-crumb">{campaign.name}</Link> : <Link to="/pieces" className="rv-crumb">{t('review.crumbs.pieces')}</Link>}
          <span className="rv-crumb-sep" aria-hidden="true">/</span>
          <h1 className="rv-title" title={v.piece.title}><Link to={`/pieces/${v.piece.id}`}>{v.piece.title}</Link></h1>
        </nav>
        <VersionMenu v={v} versions={variantVersions} />
        <CompareControl v={v} compareId={compareId} onCompare={setCompareId} />
        <span className="grow" />
        <StateLine v={v} openCount={openCount} />
        <Participants v={v} threads={stableThreads} />
        <div className="rv-decide">
          <DecisionButtons v={v} openCount={openCount} onDialog={onDialog} />
        </div>
        <MoreMenu v={v} openCount={openCount} onDialog={onDialog} />
      </header>

      <div className="rv-body">
        {leftOpen && <LeftPane v={v} piece={piece} threads={stableThreads} onShowResolved={() => { setTab('comments'); setFilter({ ...NO_FILTER, status: 'resolved' }); }} />}

        <main className="rv-center" aria-label={t('review.stage.label')}>
          <div ref={stick} className="rv-stick">
            {compareId && other && otherAssets ? (
              <CompareStage left={otherAssets} right={assets} leftLabel={`V${other.number}`} rightLabel={t('review.compare.thisOne', { n: v.number })} />
            ) : compareId ? (
              <div className="rv-stage"><Skeleton className="rv-skel-stage" /></div>
            ) : (
              <Stage
                assets={assets}
                threads={stableThreads}
                numbers={numbers}
                draft={draft}
                onDraft={(a) => { setDraft(a); if (a) setTab('comments'); }}
                canAnnotate={canAnnotate}
                focus={focus}
                onFocus={(id) => toComments(id)}
                jump={jump}
                safeZone={safeZones.find((z) => z.id === zoneId) ?? null}
                tools={zoneTools}
                draw={draw}
              />
            )}
          </div>
        </main>

        <aside className="rv-side" aria-label={t('review.side.label')}>
          <div className="rv-tabs" role="tablist" aria-label={t('review.tabs.label')}>
            <button type="button" role="tab" aria-selected={shownTab === 'comments'} onClick={() => setTab('comments')}>
              {t('review.tabs.comments')}
              {stableThreads.length > 0 && <span className="rv-tab-n">{stableThreads.length}</span>}
            </button>
            {hasSubtitles && !compareId && (
              <button type="button" role="tab" aria-selected={shownTab === 'subtitles'} onClick={() => setTab('subtitles')}>{t('review.tabs.subtitles')}</button>
            )}
            <button type="button" role="tab" aria-selected={shownTab === 'details'} onClick={() => setTab('details')}>{t('review.tabs.details')}</button>
          </div>
          {shownTab === 'comments' ? (
            <CommentsPanel
              versionId={v.id}
              threads={stableThreads}
              numbers={numbers}
              me={me.user.name ?? me.user.email}
              draft={draft}
              onDraft={setDraft}
              onClearDraft={clearAll}
              onHold={() => setJump({ nonce: Date.now(), t: playhead.t, position: liveVideo.position })}
              canComment={can('comment')}
              canReply={can('reply')}
              canResolve={can('resolve')}
              canReopen={can('comment')}
              focus={focus}
              onJump={jumpTo}
              commentable={live}
              hint={hint}
              filter={filter}
              onFilter={setFilter}
              sketch={sketch}
              tool={tool}
              onTool={canAnnotate && !compareId ? setTool : undefined}
              onPosted={(id) => { setSketch([]); setTool(null); sketchOwnsDraft.current = false; setFocus(id ?? null); }}
            />
          ) : shownTab === 'subtitles' ? (
            <div className="rv-scroll rv-subs-tab">
              <SubtitlePanel
                versionId={v.id}
                threads={stableThreads}
                canAnnotate={canAnnotate}
                firstVideoPosition={assets.find((a) => a.kind === 'video')?.position ?? 0}
                onDraft={(a) => { setDraft(a); setTab('comments'); }}
                onSeek={(s, position) => setJump({ nonce: Date.now(), t: s, position })}
                onFocus={(id) => toComments(id)}
              />
            </div>
          ) : (
            <div className="rv-scroll"><Details v={v} /></div>
          )}
        </aside>
      </div>

      <footer className="rv-phone-decide">
        <DecisionButtons v={v} openCount={openCount} onDialog={onDialog} compact />
      </footer>

      {(dialog === 'approve' || dialog === 'reject') && (
        <DecisionDialog version={v} decision={dialog} openCount={openCount} onClose={() => setDialog(null)} onSeeComments={() => { setTab('comments'); setFilter({ ...NO_FILTER, status: 'open' }); }} />
      )}
      {dialog === 'changes' && <RequestChanges version={v} openCount={openCount} onClose={() => setDialog(null)} />}
      {dialog === 'schedule' && <ScheduleDialog version={v} brandId={brand.id} zone={v.brand.timezone} onClose={() => setDialog(null)} />}
    </div>
  );
}
