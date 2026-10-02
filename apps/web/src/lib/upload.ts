import { api, ApiError } from '../api';
import { t } from '../i18n';
import { sha256File } from './hash';

export type AssetKind = 'video' | 'image' | 'pdf' | 'subtitles' | 'cover';

export interface PendingFile {
  file: File;
  kind: AssetKind;
}

export function guessKind(file: File): AssetKind {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'application/pdf') return 'pdf';
  if (/\.(vtt|srt)$/i.test(file.name)) return 'subtitles';
  return 'image';
}

export function guessMime(file: File): string {
  if (file.type) return file.type;
  if (/\.vtt$/i.test(file.name)) return 'text/vtt';
  if (/\.srt$/i.test(file.name)) return 'application/x-subrip';
  return 'application/octet-stream';
}

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t('piece.upload.err.storage', { status: xhr.status, detail: xhr.responseText }))));
    xhr.onerror = () => reject(new Error(t('piece.upload.err.network')));
    xhr.send(file);
  });
}

export interface Progress {
  step: 'hashing' | 'uploading' | 'closing';
  file: number;
  fraction: number;
  /** Said beside the progress when the upload is not moving right now. */
  note?: string;
}

// ───────────────────────────── big files, in pieces ─────────────────────────────

/** From this size a file is sent in pieces that can be resumed, instead of in one request to storage. */
export const RESUMABLE_ABOVE = 64 * 1024 ** 2;
/** What a test run sets to make small files take the long way too. Not a setting people are expected to use. */
const OVERRIDE_KEY = 'studio.resumableAbove';

export function resumableAbove(): number {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw !== null && /^\d+$/.test(raw)) return Number(raw);
  } catch {
    // Storage can be blocked; the usual size applies.
  }
  return RESUMABLE_ABOVE;
}

interface PieceProgress {
  offset: number;
  bytes: number;
  complete: boolean;
  chunkSize: number;
}

type Offered = { uploadId: string; url?: string; headers?: Record<string, string>; resumable?: PieceProgress };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for the connection to come back, if the browser knows it is gone. */
function whenOnline(): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('online', () => resolve(), { once: true }));
}

/** A failure that is worth trying again: no answer at all, or a server that is busy or restarting. */
class Transient extends Error {}

function sendPiece(uploadId: string, offset: number, piece: Blob, onSent: (bytes: number) => void): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', `/api/uploads/${uploadId}/resumable`);
    xhr.setRequestHeader('x-requested-by', 'studio');
    xhr.setRequestHeader('upload-offset', String(offset));
    xhr.setRequestHeader('content-type', 'application/offset+octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onSent(e.loaded);
    xhr.onload = () => {
      let body: any = null;
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* a proxy's error page */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Transient('network error'));
    xhr.ontimeout = () => reject(new Transient('timeout'));
    xhr.send(piece);
  });
}

const isTransient = (err: unknown) => err instanceof Transient || (err instanceof ApiError ? err.status >= 500 || err.status === 429 : err instanceof TypeError);

/**
 * Sends a file in pieces, each where the last one ended. When a piece fails for a reason that may pass (no connection, a busy server)
 * it waits and tries again, first asking the server how much has arrived, since a piece can land even when its answer does not. When the
 * server says the file ends somewhere else than the browser thought, the browser goes there. Once everything is there, asks the server
 * to check it and put it in storage; that can be asked again after a timeout.
 */
async function sendInPieces(uploadId: string, file: File, start: PieceProgress, onProgress: (fraction: number, note?: string) => void): Promise<void> {
  let offset = start.offset;
  const size = file.size;
  let failures = 0;
  let moved = 0;
  const wait = async (what: string) => {
    failures++;
    if (failures > 8) throw new Error(t('piece.upload.err.gaveUp', { what }));
    onProgress(offset / size, t('piece.upload.err.retrying'));
    await sleep(Math.min(20_000, 500 * 2 ** (failures - 1)));
    await whenOnline();
    try {
      offset = (await api.get<PieceProgress>(`/api/uploads/${uploadId}/resumable`)).offset;
    } catch (err) {
      if (!isTransient(err)) throw err;
    }
  };

  for (let round = 0; round < 4; round++) {
    while (offset < size) {
      await whenOnline();
      try {
        const sent = await sendPiece(uploadId, offset, file.slice(offset, Math.min(size, offset + start.chunkSize)), (bytes) => onProgress((offset + bytes) / size));
        if (sent.status === 200) {
          offset = sent.body.offset;
          failures = 0;
          onProgress(offset / size);
        } else if (sent.status === 409 && sent.body?.error?.code === 'offset_mismatch') {
          // The server knows where the file ends. Going there is how a piece sent twice, or a restarted server, sorts itself out.
          if (++moved > 25) throw new Error(t('piece.upload.err.offset'));
          offset = sent.body.error.details.offset;
        } else if (sent.status >= 500 || sent.status === 429) {
          throw new Transient(`the server answered ${sent.status}`);
        } else {
          const e = sent.body?.error;
          throw new ApiError(sent.status, e?.code ?? 'error', e?.message ?? t('piece.upload.err.refused', { status: sent.status }), e?.details);
        }
      } catch (err) {
        if (!isTransient(err)) throw err;
        await wait(t('piece.upload.err.keepsFailing'));
      }
    }
    onProgress(1);
    for (let attempt = 1; ; attempt++) {
      try {
        await api.post(`/api/uploads/${uploadId}/resumable/finish`);
        return;
      } catch (err) {
        // Not all there after all (the server lost some): go back to where it says and send the rest.
        if (err instanceof ApiError && err.code === 'upload_incomplete') {
          offset = err.details.offset;
          break;
        }
        if (!isTransient(err)) throw err;
        if (attempt >= 6) throw new Error(t('piece.upload.err.unconfirmed'));
        await sleep(Math.min(20_000, 1000 * 2 ** (attempt - 1)));
        await whenOnline();
      }
    }
  }
  throw new Error(t('piece.upload.err.incomplete'));
}

/**
 * The whole producer flow for one new version: hash each file, ask for signed URLs, upload straight to storage,
 * then close the version with the files and the comments it resolves.
 */
export async function createVersion(
  variantId: string,
  files: PendingFile[],
  notes: string,
  resolves: string[],
  onProgress: (p: Progress) => void,
) {
  const hashes: string[] = [];
  for (const [i, f] of files.entries()) {
    hashes.push(await sha256File(f.file, (fraction) => onProgress({ step: 'hashing', file: i, fraction })));
  }
  const above = resumableAbove();
  const { uploads } = await api.post<{ uploads: Offered[] }>(
    `/api/variants/${variantId}/uploads`,
    { files: files.map((f, i) => ({ name: f.file.name, mime: guessMime(f.file), bytes: f.file.size, sha256: hashes[i], resumable: f.file.size >= above })) },
  );
  for (const [i, f] of files.entries()) {
    const u = uploads[i]!;
    if (u.resumable) {
      // A file that arrived whole before (a closed tab, a lost answer) has nothing left to send.
      if (!u.resumable.complete) await sendInPieces(u.uploadId, f.file, u.resumable, (fraction, note) => onProgress({ step: 'uploading', file: i, fraction, note }));
    } else {
      await putWithProgress(u.url!, u.headers!, f.file, (fraction) => onProgress({ step: 'uploading', file: i, fraction }));
    }
  }
  onProgress({ step: 'closing', file: 0, fraction: 1 });
  let position = 0;
  return api.post<{ id: string }>(`/api/variants/${variantId}/versions`, {
    files: files.map((f, i) => ({
      uploadId: uploads[i]!.uploadId,
      kind: f.kind,
      // Main files take consecutive positions in the order chosen; cover and subtitles sit at 0, 1, 2…
      position: f.kind === 'video' || f.kind === 'image' || f.kind === 'pdf' ? position++ : files.slice(0, i).filter((x) => x.kind === f.kind).length,
    })),
    notes,
    resolves,
  });
}

/** A prize file: hashed, sent straight to storage with the signed address the API gave, and then confirmed so the API checks what arrived. */
export async function uploadPrizeFile(brandId: string, name: string, file: File, onProgress: (p: Progress) => void) {
  const sha256 = await sha256File(file, (fraction) => onProgress({ step: 'hashing', file: 0, fraction }));
  const made = await api.post<{ prize: { id: string }; upload: { url: string; headers: Record<string, string> } }>(
    `/api/brands/${brandId}/prizes`,
    { kind: 'file', name, file: { name: file.name, mime: guessMime(file), bytes: file.size, sha256 } },
  );
  await putWithProgress(made.upload.url, made.upload.headers, file, (fraction) => onProgress({ step: 'uploading', file: 0, fraction }));
  onProgress({ step: 'closing', file: 0, fraction: 1 });
  return api.post(`/api/prizes/${made.prize.id}/complete`);
}
