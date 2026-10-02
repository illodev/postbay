import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for an S3-compatible bucket (path style: /bucket/key): keeps what was put with its content type and the sha256 checksum
 * it was sent with, refuses a body that does not match that checksum the way S3 does (BadDigest), and answers HEAD with the checksum
 * only when the object was stored with one. Written from the S3 documentation; it proves what OUR requests carry, not that a real
 * bucket (or MinIO) behaves the same.
 */
export class FakeS3 extends FakeServer {
  objects = new Map<string, { body: Buffer; type: string; sha256: string | null; headers: Record<string, any> }>();

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const key = decodeURIComponent(c.path.replace(/^\/[^/]+\//, ''));
    if (c.method === 'PUT') {
      let body = await readAll(req);
      // Streams the SDK sends with trailing checksums come in S3's own chunked framing.
      if (String(c.headers['content-encoding'] ?? '').includes('aws-chunked') || String(c.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING')) body = unchunk(body);
      const sent = c.headers['x-amz-checksum-sha256'] as string | undefined;
      const actual = createHash('sha256').update(body).digest();
      if (sent && Buffer.from(sent, 'base64').compare(actual) !== 0) return reply.code(400).type('application/xml').send('<Error><Code>BadDigest</Code></Error>');
      this.objects.set(key, { body, type: String(c.headers['content-type'] ?? ''), sha256: sent ? Buffer.from(sent, 'base64').toString('hex') : null, headers: c.headers });
      return reply.code(200).header('etag', '"x"').send();
    }
    const o = this.objects.get(key);
    if (!o) return reply.code(404).type('application/xml').send('<Error><Code>NoSuchKey</Code></Error>');
    if (c.method === 'HEAD') {
      reply.header('content-length', o.body.length).header('content-type', o.type);
      if (o.sha256) reply.header('x-amz-checksum-sha256', Buffer.from(o.sha256, 'hex').toString('base64'));
      return reply.code(200).send();
    }
    return reply.code(200).header('content-type', o.type).send(o.body);
  }
}

/** Decodes S3's aws-chunked framing: `<hex size>[;extensions]\r\n<data>\r\n` repeated, ending with a zero-size chunk and optional trailers. */
function unchunk(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf('\r\n', at);
    if (eol === -1) break;
    const size = parseInt(raw.subarray(at, eol).toString('latin1').split(';')[0]!, 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(parts);
}
