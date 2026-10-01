import { createSHA256 } from 'hash-wasm';

/** sha256 of a file, read in chunks so large videos never sit in memory whole. */
export async function sha256File(file: File, onProgress?: (fraction: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const CHUNK = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + CHUNK) / file.size));
  }
  return hasher.digest('hex');
}
