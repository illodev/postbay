import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Comment, Requirements, Studio, VersionDetail } from './api.js';
import type { Logger } from './log.js';

export interface Dirs {
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
  const piece = path.join(root, safe(brandKey), safe(scope));
  const run = path.join(piece, 'runs', safe(runId));
  return { piece, sources: path.join(piece, 'sources'), run, input: path.join(run, 'input'), output: path.join(run, 'output'), frames: path.join(run, 'input', 'frames'), previous: path.join(run, 'input', 'previous') };
}

export async function ensureDirs(d: Dirs) {
  for (const dir of [d.sources, d.input, d.output, d.frames, d.previous]) await mkdir(dir, { recursive: true });
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export function describeAnchor(a: Comment['anchor']): string {
  if (!a) return 'General: about the piece as a whole';
  if (a.type === 'time') return a.t_end !== undefined ? `Video, from ${clock(a.t)} to ${clock(a.t_end)} (${a.t}–${a.t_end} seconds)` : `Video, at ${clock(a.t)} (${a.t} seconds)`;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
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
  studio: Studio, log: Logger, dirs: Dirs, brandId: string, versionId: string, event: unknown,
): Promise<Prepared> {
  await ensureDirs(dirs);
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
