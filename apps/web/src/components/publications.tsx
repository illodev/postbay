import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Account, type AccountOptionsReply, type Attempt, type CalendarData, type Capabilities, type Integrations, type Issue, type Plan, type PublicationRow, type VersionDetail } from '../api';
import { getLocale, t, type Key } from '../i18n';
import { countHashtags, countLength, countMentions, truncatePreview } from '../lib/text';
import { ERROR_CLASS_LABEL, fmtBytes, fmtDateTime, isoToZonedInput, NETWORK_LABEL, STEP_LABEL, VISIBILITY_LABEL, zonedToIso } from '../lib/format';
import { Chip, CopyButton, Dialog, ErrorBox, errorMessage, Field, Menu, MenuItem, MenuSeparator, Tip, Tipped, useConfirm, useToast } from './ui';
import { defaultValues, NetMark, NetworkOptions, sendableOptions, type OptionValues } from './NetworkOptions';
import { Icon as UiIcon, type IconName } from './icons';
import { PrizeDialog } from './PrizeDialog';
import '../styles/publications.css';

/** Accounts a version is approved for right now: the ones every counted approver agreed on. */
export function approvedAccountIds(v: VersionDetail): string[] {
  const rows = v.approvals.filter((a) => a.decision === 'approve' && a.matches_fingerprint);
  if (!rows.length) return [];
  return rows.map((r) => r.account_ids).reduce((acc, ids) => acc.filter((x) => ids.includes(x)));
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['piece', 'version', 'calendar', 'due', 'pieces']) qc.invalidateQueries({ queryKey: [key] });
  };
}

const num = (n: number) => new Intl.NumberFormat(getLocale()).format(n);
const netName = (network: string) => NETWORK_LABEL[network] ?? network;
/** A reason the server wrote, closed with a full stop so the sentence after it reads right. */
const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

function Icon({ d, className = 'pb-icon' }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const ICON = {
  auto: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L2.6 15a1.5 1.5 0 0 1 2.3-2l2.1 2.2V8a1.5 1.5 0 0 1 3 0',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  info: 'M12 11v5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  chevron: 'm6 9 6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};

// ───────────────────────────── per-network text ─────────────────────────────

function Counter({ label, value, max }: { label: string; value: number; max?: number }) {
  const over = max !== undefined && value > max;
  const near = max !== undefined && !over && value > max * 0.9;
  return (
    <span className="pb-count" data-over={over || undefined} data-near={near || undefined}>
      <span className="pb-count-label">{label}</span>
      <span className="pb-count-num">
        {num(value)}
        {max !== undefined && <span className="pb-count-max"> / {num(max)}</span>}
      </span>
      {over && <span className="pb-count-over">{t('publications.count.over', { count: value - max })}</span>}
    </span>
  );
}

/** A thin bar under a text box: how much of the network's limit is used. */
function Meter({ value, max }: { value: number; max: number }) {
  const over = value > max;
  const near = !over && value > max * 0.9;
  return (
    <div className="pb-meter" aria-hidden="true">
      <span style={{ width: `${Math.min(100, (value / max) * 100)}%` }} data-over={over || undefined} data-near={near || undefined} />
    </div>
  );
}

/** What a feed shows of the text before "more", under the account it goes out from. */
function FeedPreview({ text, cutoff, account, network }: { text: string; cutoff?: number; account?: string; network?: string }) {
  const cut = cutoff ? truncatePreview(text, cutoff) : null;
  const has = text.trim() !== '';
  return (
    <aside className="pb-feed" aria-label={t('publications.feed.title')}>
      <span className="field-label">{t('publications.feed.title')}</span>
      <div className="pb-feed-card">
        {account && (
          <div className="pb-feed-who">
            {network && <NetMark network={network} />}
            <strong>{account}</strong>
          </div>
        )}
        {has ? (
          <p className="pb-feed-text">
            {cut ? <>{cut.shown.trimEnd()}<span className="pb-feed-more">… {t('publications.feed.more')}</span></> : text}
          </p>
        ) : (
          <p className="pb-feed-text pb-feed-empty">{t('publications.feed.empty')}</p>
        )}
      </div>
      {has && cutoff !== undefined && <p className="muted small pb-feed-hint">{cut ? t('publications.feed.cut', { count: cutoff }) : t('publications.feed.fits')}</p>}
    </aside>
  );
}

/**
 * The text box for one network: its limits next to what has been typed, and beside it what a feed shows before "more".
 * `account` and `network` put the preview under the account's name; `issues` are the server's notes on this text.
 */
export function NetworkText({ caps, label, hint, value, onChange, account, network, issues, children }: {
  caps: Capabilities | undefined;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  account?: string;
  network?: string;
  issues?: Issue[];
  /** More boxes under this one, in the same column (the first comment). */
  children?: ReactNode;
}) {
  const tx = caps?.text;
  const id = useId();
  const length = countLength(value, tx?.unit);
  return (
    <div className="pb-compose">
      <div className="pb-compose-grid">
      <div className="pb-compose-edit">
        <label className="field-label" htmlFor={id}>{label}</label>
        <textarea id={id} className="pb-textarea" value={value} placeholder={t('publications.text.placeholder')} onChange={(e) => onChange(e.target.value)} />
        {tx && <Meter value={length} max={tx.maxChars} />}
        {tx && (
          <div className="pb-counters">
            <Counter label={tx.unit === 'graphemes' ? t('publications.count.graphemes') : t('publications.count.chars')} value={length} max={tx.maxChars} />
            {tx.maxHashtags !== undefined && <Counter label={t('publications.count.hashtags')} value={countHashtags(value)} max={tx.maxHashtags} />}
            {tx.maxMentions !== undefined && <Counter label={t('publications.count.mentions')} value={countMentions(value)} max={tx.maxMentions} />}
          </div>
        )}
        {hint && <span className="muted small">{hint}</span>}
        {issues && <IssueList issues={issues} />}
        {children}
      </div>
      <FeedPreview text={value} cutoff={tx?.previewCutoff} account={account} network={network} />
      </div>
    </div>
  );
}

// ───────────────────────────── issues ─────────────────────────────

function IssueList({ issues, id }: { issues: Issue[]; id?: string }) {
  if (!issues.length) return null;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return (
    <ul className="pb-issues" id={id} aria-label={t('publications.issue.list')}>
      {sorted.map((i, n) => (
        <li key={`${i.code}-${n}`} className="pb-issue" data-severity={i.severity}>
          <strong>{i.severity === 'error' ? t('publications.issue.error') : t('publications.issue.warning')}</strong>
          {/* The server's words, in the interface's language. */}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── when ─────────────────────────────

/** "Europe/Madrid" → "Madrid": what a person calls the brand's hour. */
const cityOf = (zone: string) => (zone.split('/').pop() ?? zone).replace(/_/g, ' ');

/**
 * A date and an hour, in the brand's zone, as the "2027-03-29T19:00" the dialogs keep. Under it, what that means: the moment
 * written out, the viewer's own hour when it differs, and why it would not go out (gone by, or a blocked day).
 */
function WhenField({ value, onChange, zone, required = true, label, hint, blocked }: {
  value: string;
  onChange: (v: string) => void;
  zone: string;
  required?: boolean;
  label?: string;
  hint?: string;
  blocked?: { day: string; reason: string }[];
}) {
  const [date, setDate] = useState(value.split('T')[0] ?? '');
  const [time, setTime] = useState(value.split('T')[1] ?? '');
  // A value set from outside (a slot picked) replaces what is typed.
  useEffect(() => {
    if (value && value !== `${date}T${time}`) {
      setDate(value.split('T')[0] ?? '');
      setTime(value.split('T')[1] ?? '');
    }
  }, [value]);
  const set = (d: string, h: string) => {
    setDate(d);
    setTime(h);
    onChange(d && h ? `${d}T${h}` : '');
  };
  const at = date && time ? DateTime.fromISO(`${date}T${time}`, { zone }) : null;
  const valid = !!at?.isValid;
  const local = valid ? at!.toLocal() : null;
  const differs = valid && local!.offset !== at!.offset;
  const blockedDay = date ? blocked?.find((b) => b.day === date) : undefined;
  const id = useId();
  return (
    <div className="pb-when-wrap">
      {label && <span className="field-label" id={`${id}-l`}>{label}</span>}
      <div className="pb-when" role="group" aria-labelledby={label ? `${id}-l` : undefined}>
        <Field label={t('publications.when.date')}>
          <input type="date" required={required} value={date} onChange={(e) => set(e.target.value, time)} />
        </Field>
        <Field label={t('publications.when.time')}>
          <input type="time" required={required || !!date} value={time} onChange={(e) => set(date, e.target.value)} />
        </Field>
      </div>
      <div className="pb-when-facts">
        <span className="pb-zone">
          <Icon d={ICON.clock} />
          {t('publications.when.zone', { city: cityOf(zone) })}
          <span className="pb-zone-id">{zone}</span>
        </span>
        {valid && <span className="pb-when-sum">{t('publications.when.summary', { when: fmtDateTime(at!.toISO()!, zone) })}</span>}
        {differs && <span className="muted">{t('publications.when.yours', { when: local!.toFormat('ccc d LLL, HH:mm') })}</span>}
      </div>
      {hint && <span className="muted small">{hint}</span>}
      {valid && at! < DateTime.now() && <div className="pb-inline-warn" role="status">{t('publications.when.past')}</div>}
      {blockedDay && (
        <div className="pb-inline-warn" role="status">
          {blockedDay.reason ? t('publications.when.blocked', { reason: blockedDay.reason }) : t('publications.when.blockedNoReason')}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── schedule ─────────────────────────────

/** The value a moment after it stopped changing. Compared by content: a new object with the same fields is not a change. */
function useDebounced<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(JSON.parse(key) as T), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return v;
}

function Section({ title, hint, children, className }: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`pb-step${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="pb-step-head">
        <h3 id={id}>{title}</h3>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const accountMode = (a: Account) =>
  a.automated ? t('publications.account.auto') : a.status === 'reconnect_required' ? t('publications.account.reconnect') : t('publications.account.manual');

export function ScheduleDialog({ version, brandId, zone, initialWhen, onClose }: {
  version: VersionDetail;
  brandId: string;
  zone: string;
  /** Where the date field starts, as a wall-clock time in the brand's zone ('yyyy-MM-ddTHH:mm'), e.g. the day a piece was dropped on. */
  initialWhen?: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const { data: accounts } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const { data: integ } = useQuery({ queryKey: ['integrations', brandId], queryFn: () => api.get<Integrations>(`/api/brands/${brandId}/integrations`) });
  // The next four weeks of the calendar: the account's free slots to offer, and the days nobody may publish.
  const from = DateTime.now().setZone(zone).toISODate()!;
  const to = DateTime.now().setZone(zone).plus({ days: 28 }).toISODate()!;
  const cal = useQuery({ queryKey: ['calendar', brandId, from, to], queryFn: () => api.get<CalendarData>(`/api/brands/${brandId}/calendar?from=${from}&to=${to}`) });
  const allowed = approvedAccountIds(version);
  const options = (accounts ?? []).filter((a) => allowed.includes(a.id));
  const [accountId, setAccountId] = useState('');
  const [when, setWhen] = useState(initialWhen ?? '');
  const [text, setText] = useState('');
  const [firstComment, setFirstComment] = useState('');
  const [placement, setPlacement] = useState('');
  const [byHand, setByHand] = useState(false);
  const [typed, setTyped] = useState<OptionValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const chosen = accountId || options[0]?.id || '';
  const account = options.find((a) => a.id === chosen);
  const caps = account ? integ?.capabilities[account.network] : undefined;
  const mode = byHand ? 'manual' : undefined;
  // The settings for this account, asked when the account is chosen: TikTok has to be asked, as the post is written, what this
  // creator may do, and only that is offered.
  const accountOpts = useQuery({
    queryKey: ['account-options', brandId, chosen],
    enabled: !!account?.automated && !byHand,
    staleTime: 0,
    queryFn: () => api.get<AccountOptionsReply>(`/api/brands/${brandId}/accounts/${chosen}/options`),
  });
  const fields = account?.automated && !byHand ? accountOpts.data?.fields : undefined;
  // What the network asks for, with its defaults under whatever the person has changed. Only what is showing is sent.
  const values: OptionValues = { ...defaultValues(fields), ...typed };

  // The server decides how it would go out and what would stop it. Asked again a moment after typing stops.
  const probe = useDebounced({ chosen, text, firstComment, placement, mode, when, options: sendableOptions(fields, placement || undefined, values) }, 350);
  const plan = useQuery({
    queryKey: ['plan', version.id, probe],
    enabled: !!probe.chosen,
    placeholderData: keepPreviousData,
    queryFn: () => {
      let scheduledAt: string | undefined;
      try { scheduledAt = probe.when ? zonedToIso(probe.when, zone) : undefined; } catch { scheduledAt = undefined; }
      return api.post<Plan>(`/api/versions/${version.id}/publications/validate`, {
        accountId: probe.chosen, text: probe.text, firstComment: probe.firstComment, placement: probe.placement || undefined, mode: probe.mode, scheduledAt, options: probe.options,
      });
    },
  });
  const p = plan.data;
  const issues = p?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');
  const blocked = !!p?.automated && errors.length > 0;
  const textIssues = issues.filter((i) => i.field === 'text');
  const commentIssues = issues.filter((i) => i.field === 'firstComment');
  const otherIssues = issues.filter((i) => i.field !== 'text' && i.field !== 'firstComment');
  const issuesId = useId();

  const create = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/publications`, {
      accountId: chosen, scheduledAt: zonedToIso(when, zone), text, firstComment, placement: placement || undefined, mode,
      options: sendableOptions(fields, p?.placement ?? (placement || undefined), values),
    }),
    onSuccess: () => {
      invalidate();
      toast(p?.automated ? t('publications.schedule.doneAuto') : t('publications.schedule.doneManual'));
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      zonedToIso(when, zone);
    } catch (err) {
      setFormError((err as Error).message);
      return;
    }
    create.mutate();
  };
  const pick = (id: string) => {
    setAccountId(id);
    setPlacement('');
    setTyped({});
  };
  const canComment = caps ? caps.text.firstComment : true;
  const placementNow = placement || p?.placement || '';
  const placementLabel = p?.placements.find((x) => x.id === p.placement)?.label;
  const free = (cal.data?.slots ?? []).filter((s) => s.account_id === chosen && !s.filled && !s.past && !s.blocked).slice(0, 4);

  return (
    <Dialog title={t('publications.schedule.title')} onClose={onClose} wide>
      <form className="pb-form" onSubmit={submit}>
        <p className="pb-sub">
          <span className="pb-sub-title">{version.piece.title}</span>
          <span className="tag">v{version.number}</span>
        </p>

        <Section title={t('publications.account.title')} hint={t('publications.account.hint')}>
          {accounts && options.length === 0 && <div className="notice notice-warn">{t('publications.account.none')}</div>}
          {options.length > 0 && (
            <div className="pb-accounts" role="radiogroup" aria-label={t('publications.account.title')}>
              {options.map((a) => (
                <label key={a.id} className="pb-acct" data-on={a.id === chosen || undefined}>
                  <input type="radio" className="sr-only" name="pb-account" value={a.id} checked={a.id === chosen} onChange={() => pick(a.id)} />
                  <NetMark network={a.network} />
                  <span className="pb-acct-who">
                    <strong>{a.display_name}</strong>
                    <span className="pb-acct-meta">
                      {netName(a.network)} · <span data-auto={a.automated || undefined}>{accountMode(a)}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {p && (
            <div className="pb-plan" data-mode={p.automated ? 'auto' : 'manual'} data-testid="plan">
              <Icon d={p.automated ? ICON.auto : ICON.hand} className="pb-plan-icon" />
              <div>
                <strong>{p.automated ? t('publications.plan.autoTitle') : t('publications.plan.manualTitle')}</strong>
                {p.automated && placementLabel && <> {t('publications.plan.autoAs', { placement: placementLabel })}</>}
                <p>
                  {!p.automated && p.manualReason && <>{sentence(p.manualReason)} </>}
                  {p.automated ? t('publications.plan.autoBody') : t('publications.plan.manualBody')}
                </p>
              </div>
            </div>
          )}
          {!p && chosen && plan.isFetching && <p className="muted small pb-quiet">{t('publications.plan.checking')}</p>}

          {p?.automated && p.placements.length > 1 && (
            <fieldset className="pb-choice-set">
              <legend className="field-label">{t('publications.placement.title')}</legend>
              <div className="pb-choices">
                {p.placements.map((x) => (
                  <label key={x.id} className="pb-choice" data-on={placementNow === x.id || undefined}>
                    <input type="radio" className="sr-only" name="pb-placement" value={x.id} checked={placementNow === x.id} onChange={() => setPlacement(x.id)} />
                    <span>{x.label}</span>
                  </label>
                ))}
              </div>
              {!placement && <span className="muted small">{t('publications.placement.hint')}</span>}
            </fieldset>
          )}
          {p && (p.automated || byHand) && account?.automated && (
            <label className="check pb-byhand">
              <input type="checkbox" checked={byHand} onChange={(e) => setByHand(e.target.checked)} />
              <span>
                {t('publications.byHand.label')}
                <span className="muted small pb-help">{t('publications.byHand.hint')}</span>
              </span>
            </label>
          )}
        </Section>

        <Section title={t('publications.when.title')}>
          <WhenField value={when} onChange={setWhen} zone={zone} blocked={cal.data?.blocked} />
          {free.length > 0 && (
            <div className="pb-slots">
              <span className="field-label">{t('publications.when.slots')}</span>
              <div className="pb-slot-list">
                {free.map((s) => {
                  const v = isoToZonedInput(s.at, zone);
                  const label = DateTime.fromISO(s.at, { zone }).toFormat('ccc d LLL · HH:mm');
                  return (
                    <button key={s.id + s.at} type="button" className="pb-slot" aria-pressed={when === v} aria-label={t('publications.when.slotUse', { when: label })} onClick={() => setWhen(v)}>
                      <span className="mono">{label}</span>
                      {s.label && <span className="pb-slot-label">{s.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Section>

        <Section title={t('publications.text.title')}>
          <NetworkText
            caps={caps}
            label={t('publications.text.label')}
            hint={t('publications.text.hint')}
            value={text}
            onChange={setText}
            account={account?.display_name}
            network={account?.network}
            issues={textIssues}
          >
          {canComment && (
            <div className="pb-comment">
              <label className="field">
                <span className="field-label">
                  {t('publications.firstComment.label')} <span className="pb-opt">{t('publications.optional')}</span>
                </span>
                <textarea className="pb-textarea pb-textarea-short" value={firstComment} onChange={(e) => setFirstComment(e.target.value)} />
              </label>
              {caps?.text.firstCommentMaxChars !== undefined && (
                <div className="pb-counters">
                  <Counter label={t('publications.count.chars')} value={countLength(firstComment, caps.text.unit)} max={caps.text.firstCommentMaxChars} />
                </div>
              )}
              <span className="muted small">{t('publications.firstComment.hint')}</span>
              <IssueList issues={commentIssues} />
            </div>
          )}
          {account && integ && !canComment && <p className="muted small pb-quiet">{t('publications.firstComment.none', { network: netName(account.network) })}</p>}
          </NetworkText>
        </Section>

        {account && !byHand && accountOpts.isLoading && <p className="muted small pb-quiet">{t('publications.opt.asking', { network: netName(account.network) })}</p>}
        {account && !byHand && accountOpts.error && <ErrorBox error={accountOpts.error} />}
        {account && !byHand && (
          <NetworkOptions network={account.network} fields={fields} placement={p?.placement ?? (placement || undefined)} values={values} onChange={(k, v) => setTyped((x) => ({ ...x, [k]: v }))} />
        )}

        <IssueList issues={otherIssues} id={issuesId} />
        {formError && <div className="notice notice-bad" role="alert">{formError}</div>}
        {create.error && <ErrorBox error={create.error} />}

        <footer className="pb-foot">
          <span className="pb-foot-status">
            {errors.length > 0 && (
              <button type="button" className="pb-foot-link" data-severity="error" onClick={() => document.getElementById(issuesId)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
                {t('publications.schedule.blocked', { count: errors.length })}
              </button>
            )}
            {errors.length === 0 && warnings.length > 0 && (
              <button type="button" className="pb-foot-link" data-severity="warning" onClick={() => document.getElementById(issuesId)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
                {t('publications.schedule.warnings', { count: warnings.length })}
              </button>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          {/* A disabled button takes no pointer: the tooltip that says why hangs on a wrapper. */}
          <Tipped label={blocked ? t('publications.schedule.blockedHint') : !when ? t('publications.schedule.needsWhen') : undefined}>
            <span className="tip-host">
              <button className="btn btn-primary" disabled={create.isPending || !chosen || blocked}>
                {create.isPending ? t('publications.schedule.submitting') : t('publications.schedule.submit')}
              </button>
            </span>
          </Tipped>
        </footer>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── move / edit ─────────────────────────────

function AccountLine({ network, name, children }: { network: string; name?: string; children?: ReactNode }) {
  return (
    <div className="pb-acct-line">
      <NetMark network={network} />
      <span className="pb-acct-who">
        {name && <strong>{name}</strong>}
        <span className="pb-acct-meta">{netName(network)}</span>
      </span>
      {children}
    </div>
  );
}

export function MoveDialog({ pub, brandId, zone, needsConfirmation, onClose }: {
  pub: { id: string; scheduled_at: string; text: string; network: string; account_name?: string };
  brandId: string;
  zone: string;
  needsConfirmation: boolean;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [when, setWhen] = useState(isoToZonedInput(pub.scheduled_at, zone));
  const [text, setText] = useState(pub.text);
  const { data: integ } = useQuery({ queryKey: ['integrations', brandId], queryFn: () => api.get<Integrations>(`/api/brands/${brandId}/integrations`) });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/publications/${pub.id}`, { scheduledAt: zonedToIso(when, zone), text }),
    onSuccess: () => {
      invalidate();
      toast(needsConfirmation ? t('publications.move.savedConfirm') : t('publications.move.saved'));
      onClose();
    },
  });
  return (
    <Dialog title={t('publications.move.title')} onClose={onClose} wide>
      <form className="pb-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <AccountLine network={pub.network} name={pub.account_name} />
        {needsConfirmation && <div className="notice notice-info">{t('publications.move.confirmNeeded')}</div>}
        <Section title={t('publications.when.title')}>
          <WhenField value={when} onChange={setWhen} zone={zone} />
        </Section>
        <Section title={t('publications.text.title')}>
          <NetworkText caps={integ?.capabilities[pub.network]} label={t('publications.text.label')} value={text} onChange={setText} account={pub.account_name} network={pub.network} />
        </Section>
        {save.error && <ErrorBox error={save.error} />}
        <footer className="pb-foot">
          <span className="pb-foot-status" />
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending || !when}>{save.isPending ? t('common.saving') : t('common.save')}</button>
        </footer>
      </form>
    </Dialog>
  );
}

export function MarkPublishedDialog({ pubId, onClose }: { pubId: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const mark = useMutation({
    mutationFn: () => api.post(`/api/publications/${pubId}/mark-published`, url ? { url } : {}),
    onSuccess: () => {
      invalidate();
      toast(t('publications.mark.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('publications.mark.title')} onClose={onClose}>
      <form className="pb-form" onSubmit={(e) => { e.preventDefault(); mark.mutate(); }}>
        <p className="pb-lead">{t('publications.mark.body')}</p>
        <label className="field">
          <span className="field-label">{t('publications.mark.link')} <span className="pb-opt">{t('publications.optional')}</span></span>
          <input type="url" placeholder={t('publications.mark.placeholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        {mark.error && <ErrorBox error={mark.error} />}
        <footer className="pb-foot">
          <span className="pb-foot-status" />
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={mark.isPending}>{t('publications.mark.submit')}</button>
        </footer>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── reschedule a held publication ─────────────────────────────

export function RescheduleDialog({ pub, approvedVersions, zone, onClose }: {
  pub: PublicationRow;
  approvedVersions: { id: string; number: number }[];
  zone: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const toast = useToast();
  // Newest first: a held publication is almost always waiting for the version that replaced its own.
  const versions = [...approvedVersions].sort((a, b) => b.number - a.number);
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  const [when, setWhen] = useState(isoToZonedInput(pub.scheduled_at, zone));
  const go = useMutation({
    mutationFn: () => api.post(`/api/publications/${pub.id}/reschedule`, { versionId, scheduledAt: zonedToIso(when, zone) }),
    onSuccess: () => {
      invalidate();
      toast(t('publications.reschedule.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('publications.reschedule.title')} onClose={onClose}>
      <form className="pb-form" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <AccountLine network={pub.network} name={pub.account_name} />
        <p className="pb-lead">{t('publications.reschedule.body')}</p>
        {pub.hold_reason && <div className="notice notice-warn">{pub.hold_reason}</div>}
        {versions.length === 0 ? (
          <div className="notice notice-warn">{t('publications.reschedule.none')}</div>
        ) : (
          <fieldset className="pb-choice-set">
            <legend className="field-label">{t('publications.reschedule.version')}</legend>
            <div className="pb-choices">
              {versions.map((v, i) => (
                <label key={v.id} className="pb-choice" data-on={versionId === v.id || undefined}>
                  <input type="radio" className="sr-only" name="pb-version" value={v.id} checked={versionId === v.id} onChange={() => setVersionId(v.id)} aria-label={t('publications.reschedule.versionN', { n: v.number })} />
                  <span className="mono">v{v.number}</span>
                  {i === 0 && versions.length > 1 && <span className="muted small">{t('publications.reschedule.latest')}</span>}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <WhenField value={when} onChange={setWhen} zone={zone} />
        {go.error && <ErrorBox error={go.error} />}
        <footer className="pb-foot">
          <span className="pb-foot-status" />
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={go.isPending || !versionId || !when}>{t('publications.reschedule.submit')}</button>
        </footer>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── automatic publications: how they are going ─────────────────────────────

/** Why a post a network accepted is still hidden from other people, in that network's own terms. */
const privateNote = (network: string) =>
  ['youtube', 'tiktok', 'pinterest'].includes(network) ? t(`publications.note.private.${network}` as Key) : t('publications.note.private.other');

/** Where an automatic publication stands, in a few words a person can act on. */
export function PublicationNote({ pub }: { pub: Pick<PublicationRow, 'status' | 'manual' | 'visibility' | 'last_error' | 'last_error_class' | 'native_scheduled' | 'url' | 'network'> }) {
  if (pub.manual) return null;
  return (
    <>
      {pub.native_scheduled && ['scheduled', 'ready'].includes(pub.status) && <div className="pb-note">{t('publications.note.native')}</div>}
      {pub.status === 'published' && pub.visibility === 'private' && <div className="pb-note" data-tone="warn">{privateNote(pub.network)}</div>}
      {pub.status === 'published' && pub.visibility === 'processing' && <div className="pb-note">{t('publications.note.processing')}</div>}
      {pub.status === 'published' && pub.visibility === 'unknown' && <div className="pb-note" data-tone="warn">{t('publications.note.gone')}</div>}
      {pub.last_error && ['scheduled', 'preparing', 'ready', 'publishing', 'failed'].includes(pub.status) && (
        <div className="pb-note" data-tone={pub.status === 'failed' ? 'bad' : 'warn'}>
          {pub.last_error_class && <strong>{ERROR_CLASS_LABEL[pub.last_error_class] ?? pub.last_error_class}: </strong>}
          {pub.last_error}
        </div>
      )}
    </>
  );
}

/** How a publication goes out (the app or a person) and, once out, whether it is not public yet. */
export function PublicationBadges({ pub }: { pub: Pick<PublicationRow, 'manual' | 'visibility' | 'status'> }) {
  return (
    <>
      <Tipped label={pub.manual ? t('publications.mode.manualHint') : t('publications.mode.autoHint')}>
        <span className="pb-mode" data-mode={pub.manual ? 'manual' : 'auto'}>
          <Icon d={pub.manual ? ICON.hand : ICON.auto} />
          {pub.manual ? t('publications.mode.manual') : t('publications.mode.auto')}
        </span>
      </Tipped>
      {!pub.manual && pub.status === 'published' && pub.visibility && pub.visibility !== 'public' && (
        <span className={`chip ${pub.visibility === 'processing' ? 'chip-publishing' : 'chip-on_hold'}`}>{VISIBILITY_LABEL[pub.visibility]}</span>
      )}
    </>
  );
}

export function AttemptsDialog({ pubId, zone, onClose }: { pubId: string; zone: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['attempts', pubId], queryFn: () => api.get<Attempt[]>(`/api/publications/${pubId}/attempts`) });
  const outcome = (o: Attempt['outcome']) =>
    o === 'ok' ? { state: 'approved', label: t('publications.attempts.ok') } : o === 'pending' ? { state: 'scheduled', label: t('publications.attempts.pending') } : { state: 'failed', label: t('publications.attempts.error') };
  return (
    <Dialog title={t('publications.attempts.title')} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && <p className="muted">{t('publications.attempts.empty')}</p>}
      {data && data.length > 0 && (
        <ol className="pb-attempts">
          {data.map((a) => {
            const o = outcome(a.outcome);
            return (
              <li key={a.id} className="pb-att" data-outcome={a.outcome}>
                <div className="pb-att-head">
                  <strong>{STEP_LABEL[a.step] ?? a.step}</strong>
                  {a.attempt > 1 && <span className="tag">{t('publications.attempts.try', { n: a.attempt })}</span>}
                  <Chip state={o.state} label={o.label} />
                  <time className="pb-att-time" dateTime={a.started_at}>{fmtDateTime(a.started_at, zone)}</time>
                </div>
                {(a.error_class || a.http_status) && (
                  <div className="pb-att-class">
                    {a.error_class && <span>{ERROR_CLASS_LABEL[a.error_class] ?? a.error_class}</span>}
                    {a.http_status && <span className="tag">{t('publications.attempts.http', { status: a.http_status })}</span>}
                  </div>
                )}
                {/* What the network or the app said: written by the server, in the interface's language. */}
                {a.detail.message && <p className="pb-att-msg">{a.detail.message}</p>}
                {a.detail.visibility && <p className="pb-att-extra">{t('publications.attempts.visibility', { visibility: VISIBILITY_LABEL[a.detail.visibility] ?? a.detail.visibility })}</p>}
                {a.detail.note && <p className="pb-att-extra">{a.detail.note}</p>}
                {a.detail.retryAfterSec !== undefined && (
                  <p className="pb-att-extra">{t('publications.attempts.retryIn', { count: Math.ceil(a.detail.retryAfterSec / 60) })}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted small pb-quiet">{t('publications.attempts.footnote')}</p>
    </Dialog>
  );
}

export function RetryDialog({ pub, zone, onClose }: { pub: PublicationRow; zone: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [when, setWhen] = useState('');
  const go = useMutation({
    mutationFn: () => api.post(`/api/publications/${pub.id}/retry`, when ? { scheduledAt: zonedToIso(when, zone) } : {}),
    onSuccess: () => {
      invalidate();
      toast(t('publications.retry.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('publications.retry.title')} onClose={onClose}>
      <form className="pb-form" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <AccountLine network={pub.network} name={pub.account_name} />
        {pub.last_error && (
          <div className="pb-last-error">
            <span className="field-label">
              {t('publications.retry.lastError')}
              {pub.last_error_class && <> · {ERROR_CLASS_LABEL[pub.last_error_class] ?? pub.last_error_class}</>}
            </span>
            <p>{pub.last_error}</p>
          </div>
        )}
        <p className="pb-lead">{t('publications.retry.body')}</p>
        <WhenField value={when} onChange={setWhen} zone={zone} required={false} label={t('publications.when.optional')} hint={t('publications.when.optionalHint')} />
        {go.error && <ErrorBox error={go.error} />}
        <footer className="pb-foot">
          <span className="pb-foot-status" />
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={go.isPending}>{t('publications.retry.submit')}</button>
        </footer>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── the pack for publishing by hand ─────────────────────────────

interface Pack {
  id: string;
  status: string;
  scheduled_at: string;
  text: string;
  first_comment: string;
  account: { network: string; display_name: string };
  piece: { id: string; title: string };
  files: { kind: string; position: number; name: string; mime: string; bytes: number; url: string }[];
}

const fileLabel = (f: Pack['files'][number]) =>
  f.kind === 'image' ? t('publications.pack.file.image', { n: f.position + 1 })
  : ['video', 'cover', 'subtitles', 'pdf'].includes(f.kind) ? t(`publications.pack.file.${f.kind}` as Key)
  : f.kind;

export function PackDialog({ pubId, zone, onClose, onPublished }: { pubId: string; zone: string; onClose: () => void; onPublished: () => void }) {
  const { data, error } = useQuery({ queryKey: ['pack', pubId], queryFn: () => api.get<Pack>(`/api/publications/${pubId}/pack`) });
  return (
    <Dialog title={t('publications.pack.title')} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {data && (
        <div className="pb-form">
          <AccountLine network={data.account.network} name={data.account.display_name}>
            <span className="pb-pack-state">
              <Chip state={data.status} />
              <span className="mono">{fmtDateTime(data.scheduled_at, zone)}</span>
            </span>
          </AccountLine>
          <p className="pb-sub"><span className="pb-sub-title">{data.piece.title}</span></p>

          <Section title={t('publications.pack.files')}>
            {data.files.length === 0 ? (
              <p className="muted small pb-quiet">{t('publications.pack.noFiles')}</p>
            ) : (
              <ul className="pb-files">
                {data.files.map((f) => (
                  <li key={`${f.kind}-${f.position}`} className="pb-file">
                    <span className="pb-file-kind">{fileLabel(f)}</span>
                    <span className="pb-file-name mono">{f.name}</span>
                    <span className="pb-file-size mono">{fmtBytes(f.bytes)}</span>
                    <a className="btn btn-small" href={f.url} download={f.name} aria-label={t('publications.pack.download', { name: f.name })}>
                      <Icon d={ICON.download} />
                      {t('common.download')}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <section className="pb-step">
            <div className="pb-step-head pb-step-head-row">
              <h3>{t('publications.pack.text')}</h3>
              {data.text && <CopyButton text={data.text} />}
            </div>
            <div className="pb-copytext">{data.text || <span className="muted">{t('publications.pack.noText')}</span>}</div>
          </section>
          {data.first_comment && (
            <section className="pb-step">
              <div className="pb-step-head pb-step-head-row">
                <h3>{t('publications.pack.firstComment')}</h3>
                <CopyButton text={data.first_comment} />
              </div>
              <div className="pb-copytext">{data.first_comment}</div>
            </section>
          )}
          <footer className="pb-foot">
            <span className="pb-foot-status" />
            <button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>
            {data.status === 'scheduled' && <button type="button" className="btn btn-primary" onClick={onPublished}>{t('publications.pack.published')}</button>}
          </footer>
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────────── a piece's publications, as a list ─────────────────────────────

/** A publication as the piece sends it: with the moment it went out, when it has. */
type ListedPublication = PublicationRow & { published_at?: string | null };

/** The variants of the piece, to name the version each publication carries. */
export interface ListVariant {
  id: string;
  format: string;
  style: string;
  versions?: { id: string; number: number; review_state: string }[];
}

type Group = 'attention' | 'upcoming' | 'published' | 'cancelled';
/** One line of a row's "⋯" menu, or the line between its actions and cancelling. */
type Entry = { sep: true } | { sep?: false; label: string; icon: IconName; danger?: boolean; onSelect: () => void };
type Tone = 'bad' | 'warn' | 'info';
interface Detail { tone: Tone; summary: string; text?: string }

const UPCOMING = ['scheduled', 'preparing', 'ready', 'publishing'];

/** A manual publication whose time has come: someone has to publish it now. */
const dueByHand = (p: ListedPublication) => p.manual && p.status === 'scheduled' && DateTime.fromISO(p.scheduled_at) <= DateTime.now();

function groupOf(p: ListedPublication): Group {
  if (p.status === 'cancelled') return 'cancelled';
  if (['failed', 'on_hold', 'awaiting_reapproval'].includes(p.status)) return 'attention';
  if (p.status === 'published' && !p.manual && (p.visibility === 'private' || p.visibility === 'unknown')) return 'attention';
  if (dueByHand(p)) return 'attention';
  if (p.status === 'published') return 'published';
  return 'upcoming';
}

/** What there is to know about a publication beyond its state: one line to read at a glance, the whole text on demand. */
function detailsOf(p: ListedPublication): Detail[] {
  const out: Detail[] = [];
  if (p.status === 'on_hold') out.push({ tone: 'warn', summary: p.hold_reason || t('publications.list.held') });
  if (p.status === 'awaiting_reapproval') out.push({ tone: 'warn', summary: t('publications.list.awaiting') });
  if (dueByHand(p)) out.push({ tone: 'warn', summary: t('publications.list.dueByHand') });
  if (p.manual) return out;
  if (p.last_error && ['scheduled', 'preparing', 'ready', 'publishing', 'failed'].includes(p.status)) {
    const label = p.last_error_class ? (ERROR_CLASS_LABEL[p.last_error_class] ?? null) : null;
    out.push({ tone: p.status === 'failed' ? 'bad' : 'warn', summary: label ?? p.last_error, text: label ? p.last_error : undefined });
  }
  if (p.status === 'published' && p.visibility === 'private') out.push({ tone: 'warn', summary: privateNote(p.network) });
  if (p.status === 'published' && p.visibility === 'unknown') out.push({ tone: 'warn', summary: t('publications.note.gone') });
  if (p.status === 'published' && p.visibility === 'processing') out.push({ tone: 'info', summary: t('publications.note.processing') });
  if (p.native_scheduled && ['scheduled', 'ready'].includes(p.status)) out.push({ tone: 'info', summary: t('publications.note.native') });
  return out;
}

/** "jue 16 oct · 19:00", with the year only when it is not this one. */
function shortWhen(iso: string, zone: string): string {
  const d = DateTime.fromISO(iso, { zone });
  return d.toFormat(d.year === DateTime.now().setZone(zone).year ? 'ccc d LLL · HH:mm' : 'd LLL yyyy · HH:mm');
}

function RowDetails({ details, id }: { details: Detail[]; id: string }) {
  const [open, setOpen] = useState(false);
  const first = details[0]!;
  const more = details.length > 1 || !!first.text || first.summary.length > 90;
  const icon = first.tone === 'info' ? ICON.info : ICON.alert;
  if (!more) {
    return (
      <div className="pb-detail" data-tone={first.tone}>
        <span className="pb-detail-line"><Icon d={icon} /><span className="pb-detail-sum">{first.summary}</span></span>
      </div>
    );
  }
  return (
    <div className="pb-detail" data-tone={first.tone} data-open={open || undefined}>
      <button type="button" className="pb-detail-line" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon d={icon} />
        <span className="pb-detail-sum">{first.summary}</span>
        <span className="pb-detail-more">{open ? t('publications.list.less') : t('publications.list.more')}</span>
        <Icon d={ICON.chevron} className="pb-icon pb-detail-chev" />
      </button>
      {open && (
        <div id={id} className="pb-detail-body">
          {details.map((d, i) => (
            <p key={i} data-tone={d.tone}>
              {d.text ? <><strong>{sentence(d.summary)}</strong> {sentence(d.text)}</> : sentence(d.summary)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The publications of a piece, one line each and grouped by what they need: the ones that need someone first, then what is
 * coming, then what is out. Each line names the account, the moment, the version it carries and its state; its one obvious
 * action is beside it (try again, publish now, open the post) and everything else is in its "⋯" menu. What went wrong or
 * what a network says about it is a line under it, opened for the whole text.
 */
export function PublicationList({ pubs, variants = [], brandId, zone, brand, canSchedule, me }: {
  pubs: ListedPublication[];
  variants?: ListVariant[];
  brandId: string;
  zone: string;
  /** The brand's settings: whether prizes are on and whether moving needs a second person. */
  brand?: { prizes?: { enabled: boolean }; rules?: { reapprove_on_move: boolean } };
  canSchedule: boolean;
  /** Who is looking, to say why they cannot confirm their own change. */
  me?: string;
}) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const ask = useConfirm();
  const baseId = useId();
  const [move, setMove] = useState<ListedPublication | null>(null);
  const [resched, setResched] = useState<ListedPublication | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const [pack, setPack] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<string | null>(null);
  const [retry, setRetry] = useState<ListedPublication | null>(null);
  const [prize, setPrize] = useState<ListedPublication | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'confirm' | 'hand-over' | 'recheck' }) => api.post(`/api/publications/${id}/${action}`),
    onSuccess: (_r, v) => {
      invalidate();
      toast(t(`publications.list.done.${v.action === 'hand-over' ? 'handOver' : v.action}` as Key));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const sameFormat = (format: string) => variants.filter((v) => v.format === format).length > 1;
  const versionTag = (p: ListedPublication) => {
    const v = variants.find((x) => x.id === p.variant_id);
    const format = v ? (v.format === 'carousel' || v.format === 'document' ? t(`publications.list.format.${v.format}` as Key) : v.format) : null;
    const full = [format, v?.style || null, `v${p.version_number}`].filter(Boolean).join(' · ');
    const short = [format, v && sameFormat(v.format) && v.style ? v.style : null, `v${p.version_number}`].filter(Boolean).join(' · ');
    return { full, short };
  };

  const groups: Group[] = ['attention', 'upcoming', 'published', 'cancelled'];
  const by = (g: Group) => {
    const list = pubs.filter((p) => groupOf(p) === g);
    const when = (p: ListedPublication) => DateTime.fromISO((g === 'published' && p.published_at) || p.scheduled_at).toMillis();
    return list.sort((a, b) => (g === 'published' || g === 'cancelled' ? when(b) - when(a) : when(a) - when(b)));
  };

  const row = (p: ListedPublication, g: Group) => {
    const tag = versionTag(p);
    const details = detailsOf(p);
    const pending = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'failed'].includes(p.status);
    const at = g === 'published' && p.published_at ? p.published_at : p.scheduled_at;
    const isPrivate = p.status === 'published' && !p.manual && p.visibility && p.visibility !== 'public';

    // The one action the line shows: what anyone would do next with it.
    let primary: ReactNode = null;
    let primaryKey: string | null = null;
    if (canSchedule && p.status === 'failed' && !p.manual) {
      primaryKey = 'retry';
      primary = <button type="button" className="btn btn-small" onClick={() => setRetry(p)}>{t('publications.list.retry')}</button>;
    } else if (canSchedule && dueByHand(p)) {
      primaryKey = 'publish';
      primary = <button type="button" className="btn btn-small" onClick={() => setPack(p.id)}>{t('publications.list.publish')}</button>;
    } else if (canSchedule && p.status === 'awaiting_reapproval') {
      primaryKey = 'confirm';
      const button = <button type="button" className="btn btn-small" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: 'confirm' })}>{t('publications.list.confirm')}</button>;
      primary = me ? <Tip label={t('publications.list.confirmHint', { email: me })}>{button}</Tip> : button;
    } else if (canSchedule && p.status === 'on_hold') {
      primaryKey = 'reschedule';
      primary = <button type="button" className="btn btn-small" onClick={() => setResched(p)}>{t('publications.list.reschedule')}</button>;
    } else if (p.url && p.status === 'published') {
      primaryKey = 'open';
      primary = (
        <Tip label={t('publications.list.openHint', { network: netName(p.network) })}>
          <a className="btn btn-small" href={p.url} target="_blank" rel="noreferrer">
            {t('publications.list.open')}<Icon d={ICON.external} className="pb-icon pb-btn-ext" />
          </a>
        </Tip>
      );
    }

    const items: Entry[] = [];
    if (p.url && primaryKey !== 'open') items.push({ label: t('publications.list.open'), icon: 'external', onSelect: () => window.open(p.url!, '_blank', 'noopener,noreferrer') });
    if (canSchedule && p.status === 'scheduled' && p.manual && primaryKey !== 'publish') items.push({ label: t('publications.list.publish'), icon: 'send', onSelect: () => setPack(p.id) });
    if (canSchedule && p.status === 'scheduled') items.push({ label: t('publications.list.move'), icon: 'calendar', onSelect: () => setMove(p) });
    if (canSchedule && p.status === 'published' && !p.manual && p.visibility === 'private') {
      items.push({ label: t('publications.list.recheck'), icon: 'refresh', onSelect: () => act.mutate({ id: p.id, action: 'recheck' }) });
    }
    if (canSchedule && !p.manual && (p.status === 'failed' || (p.status === 'scheduled' && !p.native_scheduled))) {
      items.push({
        label: t('publications.list.handOver'),
        icon: 'hand',
        onSelect: async () => {
          const ok = await ask({ title: t('publications.list.handOverTitle'), text: t('publications.list.handOverText', { account: p.account_name, network: netName(p.network) }), confirmLabel: t('publications.list.handOverGo') });
          if (ok) act.mutate({ id: p.id, action: 'hand-over' });
        },
      });
    }
    if (brand?.prizes?.enabled && canSchedule && ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'awaiting_reapproval', 'on_hold'].includes(p.status)) {
      items.push({ label: t('publications.list.prize'), icon: 'gift', onSelect: () => setPrize(p) });
    }
    if (!p.manual) items.push({ label: t('publications.list.history'), icon: 'history', onSelect: () => setAttempts(p.id) });
    if (canSchedule && pending) {
      items.push({ sep: true });
      items.push({
        label: t('publications.list.cancel'),
        icon: 'x',
        danger: true,
        onSelect: async () => {
          const ok = await ask({
            title: t('publications.list.cancelTitle'),
            text: t(p.native_scheduled ? 'publications.list.cancelTextNative' : 'publications.list.cancelText', { account: p.account_name, network: netName(p.network), when: fmtDateTime(p.scheduled_at, zone) }),
            confirmLabel: t('publications.list.cancelGo'),
            danger: true,
          });
          if (ok) act.mutate({ id: p.id, action: 'cancel' });
        },
      });
    }

    return (
      <li key={p.id} className="pb-row" data-group={g}>
        <div className="pb-row-main">
          <span className="pb-row-net"><NetMark network={p.network} labelled /></span>
          <span className="pb-row-who">
            <Tipped label={p.account_name}><strong>{p.account_name}</strong></Tipped>
            <span className="pb-row-sub">
              <span>{netName(p.network)}</span>
              <span aria-hidden="true">·</span>
              <Tip label={t('publications.list.carries', { version: tag.full })}><span className="pb-row-ver">{tag.short}</span></Tip>
            </span>
          </span>
          <Tipped label={fmtDateTime(at, zone)}><time className="pb-row-when" dateTime={at}>{shortWhen(at, zone)}</time></Tipped>
          <span className="pb-row-state">
            {isPrivate ? <Chip state="on_hold" label={VISIBILITY_LABEL[p.visibility!] ?? p.visibility!} /> : <Chip state={p.status} />}
            <Tip label={p.manual ? t('publications.list.manualHint') : t('publications.list.autoHint')}>
              <span className="pb-row-mode" data-mode={p.manual ? 'manual' : 'auto'} aria-label={p.manual ? t('publications.mode.manual') : t('publications.mode.auto')} role="img" tabIndex={0}>
                <Icon d={p.manual ? ICON.hand : ICON.auto} />
              </span>
            </Tip>
          </span>
          <span className="pb-row-act">
            {primary}
            {items.length > 0 ? (
              <Menu
                align="end"
                trigger={
                  <button type="button" className="btn btn-ghost pb-row-more" aria-label={t('publications.list.menu', { account: p.account_name })}>
                    <UiIcon name="more" />
                  </button>
                }
              >
                {items.map((it, i) =>
                  it.sep ? (
                    <MenuSeparator key={`sep-${i}`} />
                  ) : (
                    <MenuItem key={it.label} icon={it.icon} danger={it.danger} onSelect={it.onSelect}>{it.label}</MenuItem>
                  ),
                )}
              </Menu>
            ) : (
              <span className="pb-row-more-gap" aria-hidden="true" />
            )}
          </span>
        </div>
        {details.length > 0 && <RowDetails details={details} id={`${baseId}-${p.id}`} />}
      </li>
    );
  };

  return (
    <div className="pb-list">
      {groups.map((g) => {
        const list = by(g);
        if (list.length === 0) return null;
        const folded = g === 'cancelled' && !showCancelled;
        return (
          <section key={g} className="pb-group" data-group={g} aria-label={t(`publications.list.group.${g}` as Key)}>
            <h3 className="pb-group-head">
              {g === 'cancelled' ? (
                <button type="button" className="pb-group-toggle" aria-expanded={!folded} onClick={() => setShowCancelled(!showCancelled)}>
                  <Icon d={ICON.chevron} className="pb-icon pb-group-chev" />
                  <span>{t(`publications.list.group.${g}` as Key)}</span>
                  <span className="pb-group-n">{list.length}</span>
                </button>
              ) : (
                <>
                  <span className="pb-group-dot" aria-hidden="true" />
                  <span>{t(`publications.list.group.${g}` as Key)}</span>
                  <span className="pb-group-n">{list.length}</span>
                </>
              )}
            </h3>
            {!folded && <ul className="pb-rows">{list.map((p) => row(p, g))}</ul>}
          </section>
        );
      })}
      {move && <MoveDialog pub={move} brandId={brandId} zone={zone} needsConfirmation={!!brand?.rules?.reapprove_on_move} onClose={() => setMove(null)} />}
      {resched && (
        <RescheduleDialog
          pub={resched}
          zone={zone}
          approvedVersions={(variants.find((v) => v.id === resched.variant_id)?.versions ?? []).filter((v) => v.review_state === 'approved').map((v) => ({ id: v.id, number: v.number }))}
          onClose={() => setResched(null)}
        />
      )}
      {pack && <PackDialog pubId={pack} zone={zone} onClose={() => setPack(null)} onPublished={() => { setMark(pack); setPack(null); }} />}
      {mark && <MarkPublishedDialog pubId={mark} onClose={() => setMark(null)} />}
      {attempts && <AttemptsDialog pubId={attempts} zone={zone} onClose={() => setAttempts(null)} />}
      {retry && <RetryDialog pub={retry} zone={zone} onClose={() => setRetry(null)} />}
      {prize && <PrizeDialog pub={prize} brandId={brandId} zone={zone} onClose={() => setPrize(null)} />}
    </div>
  );
}
