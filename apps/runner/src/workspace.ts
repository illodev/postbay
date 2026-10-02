import { chmod, chown, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Comment, Requirements, Shape, Studio, VersionDetail } from './api.js';
import type { Logger } from './log.js';

export interface Dirs {
  /** Everything of one brand: nobody else's agent may look in here. */
  brand: string;
  /** Everything about this piece (or slot). `sources` lives here and is kept between rounds. */
  piece: string;
  sources: string;
  run: string;
  input: string;
  output: string;
  frames: string;
  previous: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

export function dirsFor(root: string, brandKey: string, scope: string, runId: string): Dirs {
  const brand = path.join(root, safe(brandKey));
  const piece = path.join(brand, safe(scope));
  const run = path.join(piece, 'runs', safe(runId));
  return { brand, piece, sources: path.join(piece, 'sources'), run, input: path.join(run, 'input'), output: path.join(run, 'output'), frames: path.join(run, 'input', 'frames'), previous: path.join(run, 'input', 'previous') };
}

/** Whom the agent runs as, when not as the runner (agent.runAs). */
export interface Access {
  runAs?: { uid: number; gid: number };
}

/**
 * Lays the directories out with permissions that keep brands apart. Without runAs everything is the runner's, readable by the
 * runner's user only (0700). With runAs, what the runner writes (the run directory, its input, the logs) stays the runner's and
 * is readable by the agent's group only (0750), so the agent can read its instructions but cannot plant anything there; only
 * `output/` and `sources/` are the agent's own. Directories made by an older runner are brought into line on the way.
 */
export async function ensureDirs(d: Dirs, access: Access = {}) {
  const ours = access.runAs ? 0o750 : 0o700;
  for (const dir of [d.brand, d.piece, path.join(d.piece, 'runs'), d.run, d.input, d.frames, d.previous]) {
    await mkdir(dir, { recursive: true, mode: ours });
    await chmod(dir, ours);
    if (access.runAs) await chown(dir, process.getuid!(), access.runAs.gid);
  }
  for (const dir of [d.sources, d.output]) await agentDir(dir, access);
}

/** A directory the agent writes in: its own when it runs as another user. */
export async function agentDir(dir: string, access: Access = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (access.runAs) await chown(dir, access.runAs.uid, access.runAs.gid);
  await chmod(dir, 0o700);
}

const MAX_RESULT = 1024 * 1024;

/**
 * Reads result.json, if the agent left one: only a file inside the output directory (not a link to somewhere else, which the
 * runner would otherwise read for it and quote in an error), and not an absurd size.
 */
export async function readResult(outDir: string): Promise<{ text: string } | { missing: true } | { problem: string }> {
  const file = path.join(outDir, 'result.json');
  try {
    await stat(file);
  } catch {
    return { missing: true };
  }
  const real = await inside(outDir, 'result.json');
  if (!real) return { problem: 'result.json leads somewhere outside the output directory' };
  const st = await stat(real);
  if (!st.isFile()) return { problem: 'result.json is not a file' };
  if (st.size > MAX_RESULT) return { problem: `result.json is ${st.size} bytes, more than the ${MAX_RESULT} allowed` };
  return { text: await readFile(real, 'utf8') };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const span = (lo: number, hi: number) => (Math.round(lo * 100) === Math.round(hi * 100) ? pct(lo) : `${Math.round(lo * 100)}–${pct(hi)}`);

/** One shape in words: what it is, where on the picture, and its colour. */
function describeShape(s: Shape): string {
  const colour = s.color ?? 'yellow';
  if (s.type === 'rect') return `a ${colour} rectangle ${span(s.x, s.x + s.w)} from the left and ${span(s.y, s.y + s.h)} from the top`;
  if (s.type === 'arrow') return `a ${colour} arrow pointing at ${pct(s.x2)} from the left and ${pct(s.y2)} from the top (from ${pct(s.x1)}, ${pct(s.y1)})`;
  const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
  return `a ${colour} freehand line over ${span(Math.min(...xs), Math.max(...xs))} from the left and ${span(Math.min(...ys), Math.max(...ys))} from the top`;
}

/** What the reviewer drew while writing the comment, in a sentence; empty when nothing was drawn. */
export function describeDrawing(shapes: Shape[] | undefined, on: 'frame' | 'page' = 'frame'): string {
  if (!shapes?.length) return '';
  const shown = shapes.slice(0, 6).map(describeShape);
  const more = shapes.length > shown.length ? `, and ${shapes.length - shown.length} more` : '';
  return `, with a drawing on the ${on}: ${shown.join('; ')}${more}`;
}

export function describeAnchor(a: Comment['anchor']): string {
  if (!a) return 'General: about the piece as a whole';
  return describePlace(a) + describeDrawing(a.drawing, a.type === 'time' ? 'frame' : 'page');
}

function describePlace(a: NonNullable<Comment['anchor']>): string {
  // A comment on one line of the subtitles carries the line's own words: the agent edits that line, not "the video around 3 seconds".
  if (a.type === 'time' && a.cue !== undefined) {
    const when = a.t_end !== undefined ? `from ${clock(a.t)} to ${clock(a.t_end)}` : `at ${clock(a.t)}`;
    return `Subtitle line ${a.cue + 1} of subtitle file ${(a.track ?? 0) + 1}, ${when} (${a.t}–${a.t_end ?? a.t} seconds)${a.cue_text ? `, which says: "${a.cue_text.replace(/\n/g, ' / ')}"` : ''}`;
  }
  if (a.type === 'time') return a.t_end !== undefined ? `Video, from ${clock(a.t)} to ${clock(a.t_end)} (${a.t}–${a.t_end} seconds)` : `Video, at ${clock(a.t)} (${a.t} seconds)`;
  return a.w === 0 && a.h === 0
    ? `Page ${a.page}, a point ${pct(a.x)} from the left and ${pct(a.y)} from the top`
    : `Page ${a.page}, an area ${pct(a.w)} wide and ${pct(a.h)} tall, ${pct(a.x)} from the left and ${pct(a.y)} from the top`;
}

/** The comments as text an agent can read next to the frames: where, who, what, and what was said since. */
export function describeComments(comments: Comment[], frameFile: (c: Comment) => string | null): string {
  if (comments.length === 0) return '_None._';
  return comments
    .map((c) => {
      const frame = frameFile(c);
      const lines = [
        `### Comment ${c.id}`,
        `- Where: ${describeAnchor(c.anchor)}`,
        `- From: ${c.author}, on version ${c.version_number}${c.carried ? ' (still open from that earlier version)' : ''}`,
        frame ? `- Frame: ${frame} (what the reviewer was looking at when they wrote it)` : null,
        '',
        ...c.body.split('\n').map((l) => `> ${l}`),
      ];
      if (c.replies.length) {
        lines.push('', 'Earlier replies:');
        for (const r of c.replies) lines.push(`- ${r.author}${r.by_agent ? ' (agent)' : ''}${r.reply_kind ? ` [${r.reply_kind}]` : ''}: ${r.body}`);
      }
      return lines.filter((l) => l !== null).join('\n');
    })
    .join('\n\n');
}

export function describeRequirements(req: Requirements): string {
  if (req.networks.length === 0) return '_The brand has no connected networks._';
  return req.networks
    .map((n) => {
      const rows = n.placements.map((p) => {
        const bits = [
          `accepts ${p.accepts.join(' or ')}`,
          p.durationSec ? `${p.durationSec.min}–${p.durationSec.max} seconds` : null,
          p.aspect ? `aspect ratio ${p.aspect.min}–${p.aspect.max} (width/height)` : null,
          p.recommendedAspect ? `looks right at ${p.recommendedAspect.min}–${p.recommendedAspect.max}` : null,
          p.safeZones ? `the network covers the top ${Math.round(p.safeZones.top * 100)}%, bottom ${Math.round(p.safeZones.bottom * 100)}%, left ${Math.round(p.safeZones.left * 100)}%, right ${Math.round(p.safeZones.right * 100)}% of the frame` : null,
        ].filter(Boolean);
        return `  - ${p.label}: ${bits.join('; ')}`;
      });
      return `- ${n.network} (captions up to ${n.text.maxChars} characters)\n${rows.join('\n')}`;
    })
    .join('\n');
}

export interface Prepared {
  dirs: Dirs;
  /** What the agent is to act on. */
  eligible: Comment[];
  /** What it must leave alone. */
  peopleOnly: Comment[];
  version: VersionDetail;
  requirements: Requirements;
  previousFiles: string[];
  /** Frame image of each comment that has one, relative to the run directory. */
  frames: Map<string, string>;
}

/** Lays out the input directory for a request for changes: the comments, their frames, the last version, what the networks accept. */
export async function prepareChanges(
  studio: Studio, log: Logger, dirs: Dirs, brandId: string, versionId: string, event: unknown, access: Access = {},
): Promise<Prepared> {
  await ensureDirs(dirs, access);
  const [version, comments, requirements] = await Promise.all([studio.version(versionId), studio.comments(versionId), studio.requirements(brandId)]);
  const eligible = comments.filter((c) => !c.people_only);
  const peopleOnly = comments.filter((c) => c.people_only);

  const frameOf = new Map<string, string>();
  for (const c of comments) {
    if (!c.frame_url) continue;
    const rel = path.join('input', 'frames', `${c.id}.jpg`);
    try {
      await studio.download(c.frame_url, path.join(dirs.run, rel));
      frameOf.set(c.id, rel);
    } catch (err) {
      log.warn({ comment: c.id, err: String(err) }, 'could not download a frame');
    }
  }

  const previousFiles: string[] = [];
  for (const a of version.assets) {
    const rel = path.join('input', 'previous', `${a.position}-${a.kind}-${safe(a.name)}`);
    await studio.download(a.url, path.join(dirs.run, rel));
    previousFiles.push(rel);
  }

  await writeFile(path.join(dirs.input, 'event.json'), JSON.stringify(event, null, 2));
  await writeFile(path.join(dirs.input, 'comments.json'), JSON.stringify(eligible.map((c) => ({ ...c, frame: frameOf.get(c.id) ?? null, frame_url: undefined })), null, 2));
  await writeFile(path.join(dirs.input, 'people-only.json'), JSON.stringify(peopleOnly.map((c) => ({ ...c, frame_url: undefined })), null, 2));
  await writeFile(path.join(dirs.input, 'requirements.json'), JSON.stringify(requirements, null, 2));
  await writeFile(
    path.join(dirs.input, 'brief.md'),
    `# ${version.piece.title}\n\n${version.piece.brief || '_No brief._'}\n\nFormat: ${version.variant.format}${version.variant.style ? `, style: ${version.variant.style}` : ''}\n`,
  );
  return { dirs, eligible, peopleOnly, version, requirements, previousFiles, frames: frameOf };
}

// ───────────────────────────── what the agent leaves behind ─────────────────────────────

export interface OutputFile {
  path: string;
  kind: 'video' | 'image' | 'pdf' | 'subtitles' | 'cover';
  position: number;
}

const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** A path from the agent's manifest must stay inside the output directory, symbolic links included. */
async function inside(outDir: string, rel: string): Promise<string | null> {
  const abs = path.resolve(outDir, rel);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return null;
  }
  const root = await realpath(outDir);
  return real === root || !real.startsWith(root + path.sep) ? null : real;
}

/**
 * The files to upload: those the manifest lists, or, when it lists none, what is in the output directory, told apart by
 * name and type. Either way each must be a real file inside the output directory.
 */
export async function collectFiles(outDir: string, declared?: { path: string; kind: OutputFile['kind']; position?: number }[]): Promise<{ files: OutputFile[]; problem?: string }> {
  const files: OutputFile[] = [];
  if (declared && declared.length) {
    for (const d of declared) {
      const real = await inside(outDir, d.path);
      if (!real || !(await stat(real)).isFile()) return { files: [], problem: `result.json lists ${d.path}, which is not a file in the output directory` };
      files.push({ path: real, kind: d.kind, position: d.position ?? 0 });
    }
  } else {
    const names = (await readdir(outDir)).filter((n) => !n.startsWith('.') && n !== 'result.json').sort();
    let primary = 0;
    for (const n of names) {
      // A link that leads out of the output directory is not the agent's file, however it is named.
      const real = await inside(outDir, n);
      if (!real) return { files: [], problem: `${n} in the output directory leads somewhere outside it` };
      const abs = real;
      if (!(await stat(abs)).isFile()) continue;
      const ext = path.extname(n).toLowerCase();
      if (VIDEO.has(ext)) files.push({ path: abs, kind: 'video', position: primary++ });
      else if (IMAGE.has(ext)) {
        if (/^cover\./i.test(n)) files.push({ path: abs, kind: 'cover', position: 0 });
        else files.push({ path: abs, kind: 'image', position: primary++ });
      } else if (ext === '.pdf') files.push({ path: abs, kind: 'pdf', position: 0 });
      else if (ext === '.vtt' || ext === '.srt') files.push({ path: abs, kind: 'subtitles', position: files.filter((f) => f.kind === 'subtitles').length });
    }
  }
  if (!files.some((f) => f.kind === 'video' || f.kind === 'image' || f.kind === 'pdf')) return { files: [], problem: 'The agent left no video, image or PDF in the output directory' };
  return { files };
}
