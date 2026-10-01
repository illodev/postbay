import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface PresignedPut {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface StoredStat {
  bytes: number;
  sha256: string;
}

export interface Storage {
  /** Signed direct-upload URL. Storage rejects anything that does not match the declared hash and size. */
  presignPut(key: string, opts: { mime: string; bytes: number; sha256: string; expiresSec: number }): Promise<PresignedPut>;
  presignGet(key: string, opts: { expiresSec: number; filename?: string }): Promise<string>;
  /** Size and sha256 of the stored object, or null if it does not exist. */
  stat(key: string): Promise<StoredStat | null>;
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export function createStorage(config: Config): Storage {
  return config.STORAGE_DRIVER === 's3' ? new S3Storage(config) : new LocalStorage(config);
}

export { LocalStorage };
