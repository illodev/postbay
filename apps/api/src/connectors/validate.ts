import type { Capabilities, Issue, PlacementSpec, PublishInput } from './types.js';

const HASHTAG = /(^|[\s(])#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|[\s(])@[\p{L}\p{N}_.]+/gu;

export const countHashtags = (text: string) => (text.match(HASHTAG) ?? []).length;
export const countMentions = (text: string) => (text.match(MENTION) ?? []).length;

const error = (code: string, message: string, field?: Issue['field']): Issue => ({ severity: 'error', code, message, field });
const warning = (code: string, message: string, field?: Issue['field']): Issue => ({ severity: 'warning', code, message, field });

/**
 * The checks every network shares, driven by what it declares: that the placement exists, the files fit it (how many,
 * what kind, which shape and length) and the text fits the limits. Connectors add their own rules on top.
 */
export function validateAgainst(caps: Capabilities, input: PublishInput): Issue[] {
  const issues: Issue[] = [];
  const spec: PlacementSpec | undefined = caps.placements.find((p) => p.id === input.placement);
  if (!spec) {
    issues.push(error('placement.unknown', `${caps.network} cannot publish as "${input.placement}"`, 'placement'));
    return issues;
  }

  const main = input.media.filter((m) => m.kind === 'video' || m.kind === 'image');
  if (main.length < spec.items.min || main.length > spec.items.max) {
    const range = spec.items.min === spec.items.max ? `exactly ${spec.items.min}` : `${spec.items.min} to ${spec.items.max}`;
    issues.push(error('media.count', `${spec.label} takes ${range} file${spec.items.max === 1 ? '' : 's'}; this version has ${main.length}`, 'media'));
  }
  for (const m of main) {
    const kind = m.kind as 'video' | 'image';
    if (!spec.accepts.includes(kind)) {
      issues.push(error('media.kind', `${spec.label} does not take ${kind === 'video' ? 'videos' : 'images'} (${m.name})`, 'media'));
      continue;
    }
    if (m.width && m.height) {
      const ratio = m.width / m.height;
      if (spec.aspect && (ratio < spec.aspect.min - 0.005 || ratio > spec.aspect.max + 0.005)) {
        issues.push(error('media.aspect', `${m.name} is ${m.width}×${m.height}; ${spec.label} needs a width-to-height ratio between ${spec.aspect.min.toFixed(2)} and ${spec.aspect.max.toFixed(2)}`, 'media'));
      } else if (spec.recommendedAspect && (ratio < spec.recommendedAspect.min - 0.005 || ratio > spec.recommendedAspect.max + 0.005)) {
        issues.push(warning('media.aspect.recommended', `${m.name} is ${m.width}×${m.height}; ${spec.label} looks best between ${spec.recommendedAspect.min.toFixed(2)} and ${spec.recommendedAspect.max.toFixed(2)}`, 'media'));
      }
    }
    if (kind === 'video' && spec.durationSec && m.durationMs) {
      const sec = m.durationMs / 1000;
      if (sec < spec.durationSec.min || sec > spec.durationSec.max) {
        issues.push(error('media.duration', `${m.name} runs ${sec.toFixed(1)} s; ${spec.label} takes ${spec.durationSec.min} to ${spec.durationSec.max} s`, 'media'));
      }
    }
  }

  const t = caps.text;
  if (input.text.length > t.maxChars) {
    issues.push(error('text.length', `The text has ${input.text.length} characters; ${caps.network} allows ${t.maxChars}`, 'text'));
  }
  if (t.maxHashtags !== undefined) {
    const n = countHashtags(input.text);
    if (n > t.maxHashtags) issues.push(error('text.hashtags', `The text has ${n} hashtags; ${caps.network} allows ${t.maxHashtags}`, 'text'));
  }
  if (t.maxMentions !== undefined) {
    const n = countMentions(input.text);
    if (n > t.maxMentions) issues.push(error('text.mentions', `The text mentions ${n} accounts; ${caps.network} allows ${t.maxMentions}`, 'text'));
  }
  if (input.firstComment) {
    if (!t.firstComment) {
      issues.push(warning('firstComment.unsupported', `${caps.network} cannot post a first comment; it will be left out`, 'firstComment'));
    } else if (t.firstCommentMaxChars && input.firstComment.length > t.firstCommentMaxChars) {
      issues.push(error('firstComment.length', `The first comment has ${input.firstComment.length} characters; ${caps.network} allows ${t.firstCommentMaxChars}`, 'firstComment'));
    }
  }
  return issues;
}
