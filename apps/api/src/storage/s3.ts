import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import type { PresignedPut, Storage, StoredStat } from './index.js';

/**
 * S3-compatible storage (self-hosted MinIO, S3 or R2).
 * The upload carries a signed sha256 (x-amz-checksum-sha256): storage rejects a file different from the declared one,
 * and the app reads it back with HeadObject when the version is closed.
 */
export class S3Storage implements Storage {
  private client: S3Client;
  /** Signs the URLs handed to browsers. It differs from `client` only when the public address is not the internal one. */
  private signer: S3Client;
  private bucket: string;
  constructor(config: Config) {
    this.bucket = config.S3_BUCKET!;
    const make = (endpoint: string | undefined) =>
      new S3Client({
        region: config.S3_REGION,
        endpoint,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
      });
    this.client = make(config.S3_ENDPOINT);
    this.signer = config.S3_PUBLIC_ENDPOINT ? make(config.S3_PUBLIC_ENDPOINT) : this.client;
  }

  async presignPut(key: string, o: { mime: string; bytes: number; sha256: string; expiresSec: number }): Promise<PresignedPut> {
    const checksum = Buffer.from(o.sha256, 'hex').toString('base64');
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: o.mime,
      ContentLength: o.bytes,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(this.signer, cmd, {
      expiresIn: o.expiresSec,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    return { method: 'PUT', url, headers: { 'content-type': o.mime, 'x-amz-checksum-sha256': checksum } };
  }

  presignGet(key: string, o: { expiresSec: number; filename?: string }): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: o.filename ? `attachment; filename="${o.filename.replace(/"/g, '')}"` : undefined,
    });
    return getSignedUrl(this.signer, cmd, { expiresIn: o.expiresSec });
  }

  async stat(key: string): Promise<StoredStat | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      if (!head.ChecksumSHA256) return null; // without a verified checksum there is no way to trust the file
      return { bytes: Number(head.ContentLength ?? 0), sha256: Buffer.from(head.ChecksumSHA256, 'base64').toString('hex') };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mime }));
  }

  async putFile(key: string, source: string, mime: string): Promise<void> {
    const { size } = await stat(source);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(source), ContentLength: size, ContentType: mime }));
  }

  async open(key: string, start = 0): Promise<{ stream: Readable; size: number }> {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    const size = Number(head.ContentLength ?? 0);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(start > 0 ? { Range: `bytes=${start}-` } : {}) }));
    return { stream: out.Body as Readable, size };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }
}
