import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** An answer from the studio that was not a success, with the code the studio gave it. */
export class StudioError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export interface Comment {
  id: string;
  version_id: string;
  version_number: number;
  body: string;
  anchor: { type: 'time'; t: number; t_end?: number; position?: number; track?: number; cue?: number; cue_text?: string } | { type: 'region'; page: number; x: number; y: number; w: number; h: number } | null;
  status: 'open' | 'resolved';
  author: string;
  carried: boolean;
  people_only: boolean;
  frame_url: string | null;
  replies: { body: string; reply_kind: string | null; by_agent: boolean; author: string }[];
}

export interface VersionAsset {
  id: string;
  kind: 'video' | 'image' | 'pdf' | 'subtitles' | 'cover';
  position: number;
  name: string;
  mime: string;
  bytes: number;
  url: string;
}

export interface VersionDetail {
  id: string;
  number: number;
  review_state: string;
  variant: { id: string; format: string; style: string; piece_id: string };
  piece: { id: string; title: string; kind: string; brief: string; ai_generated: boolean };
  assets: VersionAsset[];
}

export interface Requirements {
  networks: {
    network: string;
    text: { maxChars: number };
    placements: {
      id: string;
      label: string;
      accepts: ('video' | 'image')[];
      aspect?: { min: number; max: number };
      recommendedAspect?: { min: number; max: number };
      durationSec?: { min: number; max: number };
      safeZones?: { top: number; bottom: number; left: number; right: number };
      fileProfiles: { video?: { maxWidth: number; maxHeight: number; maxFps: number; maxBytes: number } | null; image?: { maxWidth: number; maxBytes: number } | null };
    }[];
  }[];
  approval_checklist: string[];
}

export interface RunStart {
  id: string;
  round: number;
  maxRounds: number;
  leaseUntil: string;
  limits: { maxMinutes: number; maxCost: number | null; currency: string };
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', vtt: 'text/vtt', srt: 'application/x-subrip', txt: 'text/plain',
};
export const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** The studio's producer API, as the runner uses it. */
export class Studio {
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(url, this.base), {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new StudioError(0, 'unreachable', `Could not reach the studio: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new StudioError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `The studio answered ${res.status}`, data?.error?.details);
    return data as T;
  }

  tokenInfo() { return this.call<{ token: { id: string; name: string }; brand: { id: string; name: string; timezone: string } }>('GET', '/api/token'); }
  version(id: string) { return this.call<VersionDetail>('GET', `/api/versions/${id}`); }
  comments(versionId: string) { return this.call<Comment[]>('GET', `/api/versions/${versionId}/comments?status=open&carried=true`); }
  requirements(brandId: string) { return this.call<Requirements>('GET', `/api/brands/${brandId}/requirements`); }
  brandSettings(brandId: string) { return this.call<{ name: string; timezone: string; agent: { currency: string } }>('GET', `/api/brands/${brandId}`); }

  startRun(scope: { pieceId: string } | { brandId: string }, body: { trigger: string; eventId?: string }) {
    const url = 'pieceId' in scope ? `/api/pieces/${scope.pieceId}/agent-runs` : `/api/brands/${scope.brandId}/agent-runs`;
    return this.call<RunStart>('POST', url, body);
  }
  heartbeat(runId: string) { return this.call<{ leaseUntil: string }>('POST', `/api/agent-runs/${runId}/heartbeat`, {}); }
  finishRun(runId: string, body: { outcome: string; cost?: number; notes?: string; versionId?: string; detail?: Record<string, unknown> }) {
    return this.call('POST', `/api/agent-runs/${runId}/finish`, body);
  }

  reply(commentId: string, body: { body: string; kind: 'fixed' | 'cannot_do' | 'needs_human' }) { return this.call('POST', `/api/comments/${commentId}/replies`, body); }
  createPiece(brandId: string, body: Record<string, unknown>) { return this.call<{ id: string }>('POST', `/api/brands/${brandId}/pieces`, body); }
  addVariant(pieceId: string, body: { format: string; style?: string }) { return this.call<{ id: string }>('POST', `/api/pieces/${pieceId}/variants`, body); }

  /** Uploads files straight to storage with the signed URLs the studio gives, then closes the version with their hashes. */
  async uploadVersion(
    variantId: string,
    files: { path: string; kind: string; position: number }[],
    meta: { notes: string; resolves: string[] },
  ): Promise<{ id: string; number: number }> {
    const described: { path: string; kind: string; position: number; name: string; mime: string; bytes: number; sha256: string }[] = [];
    for (const f of files) {
      const st = await stat(f.path);
      described.push({ ...f, name: path.basename(f.path), mime: mimeOf(f.path), bytes: st.size, sha256: await sha256File(f.path) });
    }
    const { uploads } = await this.call<{ uploads: { uploadId: string; url: string; headers: Record<string, string> }[] }>(
      'POST', `/api/variants/${variantId}/uploads`,
      { files: described.map((d) => ({ name: d.name, mime: d.mime, bytes: d.bytes, sha256: d.sha256 })) },
    );
    for (const [i, u] of uploads.entries()) {
      const d = described[i]!;
      let res: Response;
      try {
        res = await this.fetchImpl(u.url, {
          method: 'PUT',
          headers: { ...u.headers, 'content-length': String(d.bytes) },
          body: Readable.toWeb(createReadStream(d.path)) as unknown as BodyInit,
          // Node's fetch needs to be told a streamed body is sent in one go.
          duplex: 'half',
        } as RequestInit);
      } catch (err) {
        throw new StudioError(0, 'upload_failed', `Could not upload ${d.name}: ${(err as Error).message}`);
      }
      if (!res.ok) throw new StudioError(res.status, 'upload_failed', `Uploading ${d.name} was refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return this.call('POST', `/api/variants/${variantId}/versions`, {
      files: uploads.map((u, i) => ({ uploadId: u.uploadId, kind: described[i]!.kind, position: described[i]!.position })),
      notes: meta.notes,
      resolves: meta.resolves,
    });
  }

  /** Downloads a signed URL to a file. */
  async download(url: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new StudioError(res.status, 'download_failed', `Could not download ${path.basename(dest)} (${res.status})`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
