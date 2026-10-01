import { createHash } from 'node:crypto';

export interface FingerprintAsset {
  kind: string;
  position: number;
  sha256: string;
}

/**
 * Fingerprint of the set of files in a version.
 *
 * It is the sha256 of one line per file, "position<TAB>kind<TAB>sha256", sorted by position and kind.
 * If a single byte of a file, its order or its role (e.g. a different cover) changes, the fingerprint changes
 * and the approval tied to the previous one stops counting.
 */
export function fingerprintOf(assets: FingerprintAsset[]): string {
  const lines = [...assets]
    .sort((a, b) => a.position - b.position || a.kind.localeCompare(b.kind))
    .map((a) => `${a.position}\t${a.kind}\t${a.sha256.toLowerCase()}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}
