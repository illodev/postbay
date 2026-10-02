import { t } from '../i18n';
import { Icon } from './icons';

// Saturated enough to read on the dark surfaces, never one of the state colours' exact hues.
const COLOURS = ['#e0559b', '#5b7cfa', '#2fb67a', '#e8913a', '#9b6cff', '#d9534f', '#2aa3c9', '#b58a2a'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** "Lucía Martín" → LM, "ana@x.es" → AN. */
export function initials(name: string): string {
  // Each word without its punctuation: "Lucía (Marketing)" → LM, never "L(".
  const words = name.split(/[\s@._-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (words.length >= 2 && !name.includes('@')) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
}

/** A person's round mark (initials on a colour of their own), or the agent's. */
export function Avatar({ name, agent, size = 26, title }: { name?: string | null; agent?: boolean; size?: number; title?: string }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (agent) {
    return (
      <span className="avatar avatar-agent" style={style} title={title ?? t('common.agent')} role="img" aria-label={title ?? t('common.agent')}>
        <Icon name="bot" />
      </span>
    );
  }
  const label = name?.trim() || '?';
  return (
    <span className="avatar" style={{ ...style, background: COLOURS[hash(label.toLowerCase()) % COLOURS.length] }} title={title ?? label} role="img" aria-label={title ?? label}>
      {initials(label)}
    </span>
  );
}

/** A short display name: the person's name, or the part of the email before the @. */
export function displayName(name?: string | null, email?: string | null): string {
  if (name?.trim()) return name.trim();
  if (email) return email.split('@')[0]!;
  return '?';
}
