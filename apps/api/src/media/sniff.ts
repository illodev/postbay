import { open } from 'node:fs/promises';

/**
 * What a file really is, read from its first bytes rather than from the name or the type it was declared with. Two things depend
 * on it: ffprobe and ffmpeg are told which reader to use (so a playlist declared as video/mp4 is never opened as a playlist, and
 * never makes them fetch anything), and the file profiles are checked against the real container (an H.264 MOV is not an MP4, and
 * an MPO is not the JPEG it claims to be).
 */
export type Container = 'mp4' | 'mov' | 'matroska' | 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown';

export interface Sniffed {
  container: Container;
  /** For MP4 and MOV: whether the index (moov) comes before the media (mdat), which networks that stream a file need. */
  faststart?: boolean;
  /** For JPEG: a Multi-Picture Object (two pictures, as some phones and 3D cameras save), which Instagram refuses. */
  mpo?: boolean;
}

/** The ffmpeg reader (demuxer) for each container this app accepts. Nothing else is opened. */
export const DEMUXER: Record<Exclude<Container, 'unknown'>, string> = {
  mp4: 'mov', mov: 'mov', matroska: 'matroska', jpeg: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe', gif: 'gif',
};

interface Reader {
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

const isUrl = (src: string) => /^https?:\/\//i.test(src);

async function openReader(src: string): Promise<Reader> {
  if (!isUrl(src)) {
    const fh = await open(src, 'r');
    return {
      async read(offset, length) {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      },
      close: () => fh.close(),
    };
  }
  // A signed address of this app's own storage: read in ranges, never the whole file.
  return {
    async read(offset, length) {
      const res = await fetch(src, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (res.status === 416) return Buffer.alloc(0);
      if (res.status !== 206 && res.status !== 200) throw new Error(`storage answered ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      let got = 0;
      // A server that ignores the range (200) sends the file from its start: skip to the offset, and stop once there is enough.
      let skip = res.status === 200 ? offset : 0;
      while (got < length) {
        const { done, value } = await reader.read();
        if (done) break;
        let b = Buffer.from(value);
        if (skip > 0) {
          const cut = Math.min(skip, b.length);
          b = b.subarray(cut);
          skip -= cut;
        }
        chunks.push(b);
        got += b.length;
      }
      await reader.cancel().catch(() => {});
      return Buffer.concat(chunks).subarray(0, length);
    },
    close: async () => {},
  };
}

/** Walks the top-level boxes of an MP4 or MOV until it meets the index or the media, whichever comes first. */
async function moovFirst(r: Reader): Promise<boolean | undefined> {
  let offset = 0;
  for (let i = 0; i < 64; i++) {
    const head = await r.read(offset, 16);
    if (head.length < 8) return undefined;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (size === 1) {
      if (head.length < 16) return undefined;
      size = Number(head.readBigUInt64BE(8));
    } else if (size === 0) {
      return undefined; // runs to the end of the file without having met either
    }
    if (size < 8) return undefined;
    offset += size;
  }
  return undefined;
}

/** Looks through a JPEG's header segments for the APP2 "MPF" segment that marks a Multi-Picture Object. */
async function isMpo(r: Reader): Promise<boolean> {
  let offset = 2;
  for (let i = 0; i < 64; i++) {
    const head = await r.read(offset, 8);
    if (head.length < 4 || head[0] !== 0xff) return false;
    const marker = head[1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return false; // the picture itself starts: no more header segments
    const length = head.readUInt16BE(2);
    if (marker === 0xe2 && head.length >= 8 && head.toString('latin1', 4, 8) === 'MPF\0') return true;
    if (length < 2) return false;
    offset += 2 + length;
  }
  return false;
}

export async function sniff(src: string): Promise<Sniffed> {
  const r = await openReader(src);
  try {
    const b = await r.read(0, 64);
    if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
      const brand = b.toString('latin1', 8, 12);
      return { container: brand === 'qt  ' ? 'mov' : 'mp4', faststart: await moovFirst(r) };
    }
    // QuickTime files from before the "ftyp" box start straight with one of these.
    if (b.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(b.toString('latin1', 4, 8))) {
      return { container: 'mov', faststart: await moovFirst(r) };
    }
    if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return { container: 'matroska' };
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { container: 'jpeg', mpo: await isMpo(r) };
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { container: 'png' };
    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { container: 'webp' };
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { container: 'gif' };
    return { container: 'unknown' };
  } finally {
    await r.close();
  }
}

/**
 * The arguments that go before `-i` for a file of this kind: the reader to use, only that reader, and only the protocols needed to
 * read it (a local file, or this app's own storage over https), so nothing inside the file can make ffmpeg open anything else.
 */
export function inputArgs(src: string, s: Sniffed): string[] {
  if (s.container === 'unknown') throw new Error('the file is not a picture or video format this app reads (MP4, MOV, Matroska/WebM, JPEG, PNG, WebP, GIF)');
  const demuxer = DEMUXER[s.container];
  const protocols = !isUrl(src) ? 'file' : /^https:/i.test(src) ? 'https,tls,tcp' : 'http,tcp';
  return ['-protocol_whitelist', protocols, '-format_whitelist', demuxer, '-f', demuxer];
}
