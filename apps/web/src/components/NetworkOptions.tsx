import type { OptionField } from '../api';
import { t, type Key } from '../i18n';
import { NETWORK_LABEL } from '../lib/format';
import '../styles/publications.css';

export type OptionValues = Record<string, string | boolean>;

/** The network's two-letter mark lives in ui.tsx now; re-exported so the imports from here keep working. */
import { NetMark } from './ui';
export { NetMark };

/**
 * The fields that apply right now: for the kind of post chosen, and (for a dependent field) while the checkbox it hangs from is
 * showing and ticked. A field under a hidden checkbox is hidden too, whatever that checkbox still holds.
 */
export function visibleFields(fields: OptionField[] | undefined, placement: string | null | undefined, values: OptionValues): OptionField[] {
  const all = fields ?? [];
  const byKey = new Map(all.map((f) => [f.key, f]));
  const shows = (f: OptionField, seen = new Set<string>()): boolean => {
    if (f.placements && placement && !f.placements.includes(placement)) return false;
    // Hidden while another checkbox that is showing is ticked (one notice replaced by another).
    if (f.hideWhen) {
      const other = byKey.get(f.hideWhen);
      if (other && !seen.has(f.key) && values[f.hideWhen] === true && shows(other, new Set(seen).add(f.key))) return false;
    }
    if (!f.showWhen) return true;
    const parent = byKey.get(f.showWhen);
    // A dependency on something that does not exist, or a loop, never shows: better hidden than half-working.
    if (!parent || seen.has(f.key)) return false;
    return values[f.showWhen] === true && shows(parent, new Set(seen).add(f.key));
  };
  return all.filter((f) => shows(f));
}

/** What each field holds before anyone touches it. A required field without a default stays empty: nothing is chosen for the person. */
export function defaultValues(fields: OptionField[] | undefined): OptionValues {
  const out: OptionValues = {};
  for (const f of fields ?? []) {
    if (f.type === 'info') continue;
    if (f.type === 'checkbox') out[f.key] = f.default === true && !f.disabled;
    else out[f.key] = typeof f.default === 'string' ? f.default : '';
  }
  return out;
}

/** What is sent to the API: only the fields that are showing, and no empty text, so a hidden tick can never count. */
export function sendableOptions(fields: OptionField[] | undefined, placement: string | null | undefined, values: OptionValues): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of visibleFields(fields, placement, values)) {
    if (f.type === 'info') continue;
    const v = values[f.key];
    // Something the network switched off is never sent as allowed, whatever the box held.
    if (f.type === 'checkbox') out[f.key] = v === true && !f.disabled;
    else if (typeof v === 'string' && v.trim() !== '') out[f.key] = v.trim();
  }
  return out;
}

// ───────────────────────────── grouping ─────────────────────────────

/**
 * The settings are shown in a few groups, so a long list (TikTok's) reads as questions: who sees it, what is allowed, whether it
 * is commercial, the agreement. A field the web does not know lands in "details"; lines to read go last, except the one that says
 * who the post goes out as, which heads the box.
 */
type Group = 'identity' | 'audience' | 'details' | 'interactions' | 'commercial' | 'consent' | 'notes';
const ORDER: Group[] = ['identity', 'audience', 'details', 'interactions', 'commercial', 'consent', 'notes'];
const GROUP_OF: Record<string, Group> = {
  privacy: 'audience', madeForKids: 'audience',
  allowComment: 'interactions', allowDuet: 'interactions', allowStitch: 'interactions',
  commercial: 'commercial', yourBrand: 'commercial', brandedContent: 'commercial',
  consent: 'consent', consentBranded: 'consent',
};

function groupOf(f: OptionField, byKey: Map<string, OptionField>, seen = new Set<string>()): Group {
  if (f.type === 'info') return f.key === 'creator' ? 'identity' : 'notes';
  if (GROUP_OF[f.key]) return GROUP_OF[f.key]!;
  if (f.notice) return 'consent';
  // A field that hangs from another goes where that one is.
  const parent = f.showWhen ? byKey.get(f.showWhen) : undefined;
  if (parent && !seen.has(f.key)) return groupOf(parent, byKey, new Set(seen).add(f.key));
  return 'details';
}

/** A required choice with a handful of answers is shown as buttons: every answer in sight, and none of them picked in advance. */
const asChoices = (f: OptionField) => f.type === 'select' && !!f.required && (f.choices?.length ?? 0) > 0 && (f.choices?.length ?? 0) <= 5;

/** How deep a field hangs from other checkboxes, to indent it under the one that reveals it. */
function depthOf(f: OptionField, byKey: Map<string, OptionField>, seen = new Set<string>()): number {
  if (!f.showWhen || seen.has(f.key)) return 0;
  const parent = byKey.get(f.showWhen);
  return parent ? 1 + depthOf(parent, byKey, new Set(seen).add(f.key)) : 0;
}

/** The settings a network asks for (who can see a TikTok post, a Pinterest board link…), drawn from what its connector declares. */
export function NetworkOptions({ network, fields, placement, values, onChange }: {
  network: string;
  fields: OptionField[] | undefined;
  placement: string | null | undefined;
  values: OptionValues;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const shown = visibleFields(fields, placement, values);
  if (shown.length === 0) return null;
  const byKey = new Map((fields ?? []).map((f) => [f.key, f]));
  const groups = new Map<Group, OptionField[]>();
  for (const f of shown) {
    const g = groupOf(f, byKey);
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const titled = ORDER.filter((g) => g !== 'identity' && g !== 'notes' && groups.has(g));
  const name = NETWORK_LABEL[network] ?? network;

  const field = (f: OptionField) => {
    const id = `opt-${f.key}`;
    // Indented under the checkbox that reveals it, when both sit in the same group (an agreement that replaces another does not).
    const parent = f.showWhen ? byKey.get(f.showWhen) : undefined;
    const depth = parent && groupOf(parent, byKey) === groupOf(f, byKey) ? depthOf(f, byKey) : 0;
    const indent = depth > 0 ? { marginLeft: `${depth * 1.6}rem` } : undefined;
    if (f.type === 'checkbox' && f.notice) {
      // The network's own words, as they are: nothing here is rephrased or translated by the web.
      return (
        <div key={f.key} className="pb-consent" style={indent}>
          <p className="pb-consent-text">{f.notice}</p>
          <label className="check">
            <input id={id} type="checkbox" required={f.required} disabled={f.disabled} checked={values[f.key] === true && !f.disabled} onChange={(e) => onChange(f.key, e.target.checked)} />
            <span>
              {f.label}
              {f.required && <span className="pb-req"> · {t('publications.opt.required')}</span>}
            </span>
          </label>
        </div>
      );
    }
    if (f.type === 'checkbox') {
      return (
        <label key={f.key} className="check pb-check" data-off={f.disabled || undefined} data-nested={depth > 0 || undefined} style={indent}>
          <input id={id} type="checkbox" disabled={f.disabled} checked={values[f.key] === true && !f.disabled} onChange={(e) => onChange(f.key, e.target.checked)} />
          <span>
            <span className="pb-check-label">{f.label}</span>
            {f.disabled && <span className="pb-off">{t('publications.opt.off')}</span>}
            {f.help && <span className="muted small pb-help">{f.help}</span>}
          </span>
        </label>
      );
    }
    if (asChoices(f)) {
      const value = String(values[f.key] ?? '');
      return (
        <fieldset key={f.key} className="pb-choice-set" style={indent}>
          <legend className="field-label">
            {f.label}
            <span className="pb-req"> · {t('publications.opt.required')}</span>
          </legend>
          <div className="pb-choices">
            {f.choices!.map((c) => {
              const off = !!c.disabledWhen && values[c.disabledWhen] === true;
              return (
                <label key={c.value} className="pb-choice" data-on={value === c.value || undefined} data-off={off || undefined}>
                  <input type="radio" className="sr-only" name={id} value={c.value} required disabled={off} checked={value === c.value} onChange={() => onChange(f.key, c.value)} />
                  <span>{c.label}</span>
                </label>
              );
            })}
          </div>
          {!value && <span className="pb-pick">{t('publications.opt.pick')}</span>}
          {f.help && <span className="muted small">{f.help}</span>}
        </fieldset>
      );
    }
    return (
      <label key={f.key} className="field" style={indent}>
        <span className="field-label">
          {f.label}
          {f.required ? <span className="pb-req"> · {t('publications.opt.required')}</span> : <span className="pb-opt"> {t('publications.optional')}</span>}
        </span>
        {f.type === 'select' ? (
          <select id={id} required={f.required} value={String(values[f.key] ?? '')} onChange={(e) => onChange(f.key, e.target.value)}>
            {/* A required choice starts empty on purpose: the network asks that nobody picks it for the person. */}
            <option value="">{f.required ? t('publications.opt.choose') : t('publications.opt.notSet')}</option>
            {f.choices?.map((c) => <option key={c.value} value={c.value} disabled={!!c.disabledWhen && values[c.disabledWhen] === true}>{c.label}</option>)}
          </select>
        ) : (
          <input
            id={id}
            type={f.type === 'url' ? 'url' : 'text'}
            maxLength={f.maxLength}
            required={f.required}
            value={String(values[f.key] ?? '')}
            onChange={(e) => onChange(f.key, e.target.value)}
            placeholder={f.type === 'url' ? t('publications.mark.placeholder') : ''}
          />
        )}
        {f.help && <span className="muted small">{f.help}</span>}
      </label>
    );
  };

  return (
    <fieldset className="pb-opts" data-testid={`options-${network}`}>
      <legend className="pb-opts-legend">
        <NetMark network={network} />
        {t('publications.opt.title', { network: name })}
      </legend>
      {groups.get('identity')?.map((f) => <p key={f.key} className="pb-identity" data-testid={`opt-${f.key}`}>{f.label}</p>)}
      {titled.map((g) => (
        <div key={g} className="pb-opt-group" data-group={g}>
          {titled.length > 1 && <h4 className="pb-opt-title">{t(`publications.opt.group.${g}` as Key)}</h4>}
          <div className="pb-opt-fields">{groups.get(g)!.map(field)}</div>
        </div>
      ))}
      {groups.has('notes') && (
        <ul className="pb-notes">
          {groups.get('notes')!.map((f) => <li key={f.key} data-testid={`opt-${f.key}`}>{f.label}</li>)}
        </ul>
      )}
    </fieldset>
  );
}
