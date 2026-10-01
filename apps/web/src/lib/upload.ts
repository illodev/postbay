import { api } from '../api';
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
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`)));
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(file);
  });
}

export interface Progress {
  step: 'hashing' | 'uploading' | 'closing';
  file: number;
  fraction: number;
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
  const { uploads } = await api.post<{ uploads: { uploadId: string; url: string; headers: Record<string, string> }[] }>(
    `/api/variants/${variantId}/uploads`,
    { files: files.map((f, i) => ({ name: f.file.name, mime: guessMime(f.file), bytes: f.file.size, sha256: hashes[i] })) },
  );
  for (const [i, f] of files.entries()) {
    const u = uploads[i]!;
    await putWithProgress(u.url, u.headers, f.file, (fraction) => onProgress({ step: 'uploading', file: i, fraction }));
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
