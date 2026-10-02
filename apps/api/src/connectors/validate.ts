import { isKnown, msg, tr, type Key, type Localized, type Params } from '../i18n/index.js';
import type { Capabilities, Issue, Network, PlacementSpec, PublishInput } from './types.js';

/**
 * The dictionary entry of an issue's words: `issue.<code>`, or `issue.<code>.<variant>` when a network words the same problem its own
 * way (X counts a text differently, a LinkedIn document is one PDF), so the code stays the same for programs.
 */
export const issueKey = (code: string, params?: Params): string =>
  typeof params?.variant === 'string' ? `issue.${code}.${params.variant}` : `issue.${code}`;

/**
 * An issue, in the language of the request that asked (Spanish outside one). Its code and values are kept with it, so a post that fails
 * on it can say it again later in someone else's language (see issueText).
 */
export function issue(severity: Issue['severity'], code: string, params: Params = {}, field?: Issue['field']): Issue {
  const key = issueKey(code, params);
  return { severity, code, message: isKnown(key) ? tr(key as Key, params) : code, params, field };
}

/**
 * An issue kept as a code, to be said again later in someone's language (a post that fails on it): its dictionary entry when there is
 * one, otherwise its message as it was worded.
 */
export function issueText(i: Issue): Localized {
  const key = issueKey(i.code, i.params);
  return isKnown(key) ? msg(key as Key, i.params) : msg('pub.said', { text: i.message });
}

/** A network's name, said as itself in every language. */
export const networkName = (network: Network): Localized => msg(`network.${network}` as Key);

/** A placement's name ("Reel", "Feed photo"…), in the reader's language when the dictionary has it, otherwise as the connector calls it. */
export function placementName(network: Network, spec: Pick<PlacementSpec, 'id' | 'label'>): Localized | string {
  const key = `placement.${network}.${spec.id}`;
  return isKnown(key) ? msg(key as Key) : spec.label;
}

const HASHTAG = /(^|[\s(])#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|[\s(])@[\p{L}\p{N}_.]+/gu;

export const countHashtags = (text: string) => (text.match(HASHTAG) ?? []).length;
export const countMentions = (text: string) => (text.match(MENTION) ?? []).length;

// Numbers go into the words as text, written the way the English always wrote them (1080, not 1,080; 0.80, not 0.8).
const error = (code: string, params: Params, field?: Issue['field']) => issue('error', code, params, field);
const warning = (code: string, params: Params, field?: Issue['field']) => issue('warning', code, params, field);

/**
 * The checks every network shares, driven by what it declares: that the placement exists, the files fit it (how many,
 * what kind, which shape and length) and the text fits the limits. Connectors add their own rules on top.
 */
export function validateAgainst(caps: Capabilities, input: PublishInput): Issue[] {
  const issues: Issue[] = [];
  const network = networkName(caps.network);
  const spec: PlacementSpec | undefined = caps.placements.find((p) => p.id === input.placement);
  if (!spec) {
    issues.push(error('placement.unknown', { network, placement: input.placement }, 'placement'));
    return issues;
  }
  const placement = placementName(caps.network, spec);

  const main = input.media.filter((m) => m.kind === 'video' || m.kind === 'image');
  if (main.length < spec.items.min || main.length > spec.items.max) {
    issues.push(error('media.count', {
      variant: spec.items.min === spec.items.max ? 'exact' : 'range', placement, min: String(spec.items.min), max: String(spec.items.max),
      files: msg(spec.items.max === 1 ? 'issue.word.file' : 'issue.word.files'), count: String(main.length),
    }, 'media'));
  }
  for (const m of main) {
    const kind = m.kind as 'video' | 'image';
    if (!spec.accepts.includes(kind)) {
      issues.push(error('media.kind', { placement, kind: msg(kind === 'video' ? 'issue.word.videos' : 'issue.word.images'), name: m.name }, 'media'));
      continue;
    }
    if (m.width && m.height) {
      const ratio = m.width / m.height;
      const size = { name: m.name, width: String(m.width), height: String(m.height), placement };
      if (spec.aspect && (ratio < spec.aspect.min - 0.005 || ratio > spec.aspect.max + 0.005)) {
        issues.push(error('media.aspect', { ...size, min: spec.aspect.min.toFixed(2), max: spec.aspect.max.toFixed(2) }, 'media'));
      } else if (spec.recommendedAspect && (ratio < spec.recommendedAspect.min - 0.005 || ratio > spec.recommendedAspect.max + 0.005)) {
        issues.push(warning('media.aspect.recommended', { ...size, min: spec.recommendedAspect.min.toFixed(2), max: spec.recommendedAspect.max.toFixed(2) }, 'media'));
      }
    }
    if (kind === 'video' && spec.durationSec && m.durationMs) {
      const sec = m.durationMs / 1000;
      if (sec < spec.durationSec.min || sec > spec.durationSec.max) {
        issues.push(error('media.duration', {
          name: m.name, seconds: sec.toFixed(1), placement, min: String(spec.durationSec.min), max: String(spec.durationSec.max),
        }, 'media'));
      }
    }
  }

  const t = caps.text;
  if (input.text.length > t.maxChars) {
    issues.push(error('text.length', { count: String(input.text.length), network, max: String(t.maxChars) }, 'text'));
  }
  if (t.maxHashtags !== undefined) {
    const n = countHashtags(input.text);
    if (n > t.maxHashtags) issues.push(error('text.hashtags', { count: String(n), network, max: String(t.maxHashtags) }, 'text'));
  }
  if (t.maxMentions !== undefined) {
    const n = countMentions(input.text);
    if (n > t.maxMentions) issues.push(error('text.mentions', { count: String(n), network, max: String(t.maxMentions) }, 'text'));
  }
  if (input.firstComment) {
    if (!t.firstComment) {
      issues.push(warning('firstComment.unsupported', { network }, 'firstComment'));
    } else if (t.firstCommentMaxChars && input.firstComment.length > t.firstCommentMaxChars) {
      issues.push(error('firstComment.length', { count: String(input.firstComment.length), network, max: String(t.firstCommentMaxChars) }, 'firstComment'));
    }
  }
  return issues;
}
