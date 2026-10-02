import type { OptionField } from '../api';
import { NETWORK_LABEL } from '../lib/format';
import { Field } from './ui';

export type OptionValues = Record<string, string | boolean>;

/**
 * The fields that apply right now: for the kind of post chosen, and (for a dependent field) while the checkbox it hangs from is
 * showing and ticked. A field under a hidden checkbox is hidden too, whatever that checkbox still holds.
 */
export function visibleFields(fields: OptionField[] | undefined, placement: string | null | undefined, values: OptionValues): OptionField[] {
  const all = fields ?? [];
  const byKey = new Map(all.map((f) => [f.key, f]));
  const shows = (f: OptionField, seen = new Set<string>()): boolean => {
    if (f.placements && placement && !f.placements.includes(placement)) return false;
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
    if (f.type === 'checkbox') out[f.key] = f.default === true;
    else out[f.key] = typeof f.default === 'string' ? f.default : '';
  }
  return out;
}

/** What is sent to the API: only the fields that are showing, and no empty text, so a hidden tick can never count. */
export function sendableOptions(fields: OptionField[] | undefined, placement: string | null | undefined, values: OptionValues): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of visibleFields(fields, placement, values)) {
    const v = values[f.key];
    if (f.type === 'checkbox') out[f.key] = v === true;
    else if (typeof v === 'string' && v.trim() !== '') out[f.key] = v.trim();
  }
  return out;
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
  return (
    <fieldset className="options" data-testid={`options-${network}`}>
      <legend className="field-label">Settings for {NETWORK_LABEL[network] ?? network}</legend>
      <div className="stack">
        {shown.map((f) => {
          const id = `opt-${f.key}`;
          if (f.type === 'checkbox') {
            return (
              <label key={f.key} className="check" style={f.showWhen ? { marginLeft: '1.4rem' } : undefined}>
                <input id={id} type="checkbox" checked={values[f.key] === true} onChange={(e) => onChange(f.key, e.target.checked)} />
                <span>
                  {f.notice ? <strong>{f.notice}</strong> : f.label}
                  {f.notice && <span className="muted small" style={{ display: 'block' }}>{f.label}{f.required ? ' (required)' : ''}</span>}
                  {f.help && <span className="muted small" style={{ display: 'block' }}>{f.help}</span>}
                </span>
              </label>
            );
          }
          return (
            <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.help}>
              {f.type === 'select' ? (
                <select id={id} required={f.required} value={String(values[f.key] ?? '')} onChange={(e) => onChange(f.key, e.target.value)}>
                  {/* A required choice starts empty on purpose: the network asks that nobody picks it for the person. */}
                  <option value="">{f.required ? 'Choose…' : 'Not set'}</option>
                  {f.choices?.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              ) : (
                <input id={id} type={f.type === 'url' ? 'url' : 'text'} maxLength={f.maxLength} required={f.required} value={String(values[f.key] ?? '')} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.type === 'url' ? 'https://' : ''} />
              )}
            </Field>
          );
        })}
      </div>
    </fieldset>
  );
}
