import { createReadStream } from 'node:fs';

/**
 * The values this runner must never post to the studio: every brand's producer token and webhook secret, and what the agents'
 * environments get from files or from the runner's own environment (an API key, say). They are known by a label ("lumen: studio
 * token") so a log can say which one turned up without saying it.
 *
 * An agent that can read one of them (a prompt injection in a comment telling it to) could write it into result.json, a reply, a
 * subtitle file or its error output, and the runner would hand it to the studio, where every member of the brand can read it. The
 * runner looks for each value, as written, in everything it is about to post. This catches the plain value, not one encoded on
 * purpose: what keeps an agent from reading the secrets at all is running it as another user or in a sandbox (see the README).
 */
export class Secrets {
  private readonly items: { label: string; value: string; bytes: Buffer }[];

  /** Values shorter than this are not looked for: too likely to turn up by chance, and too short to be a secret worth the name. */
  static readonly MIN_LENGTH = 8;

  constructor(entries: Iterable<{ label: string; value: string }>) {
    const seen = new Set<string>();
    this.items = [];
    for (const { label, value } of entries) {
      if (value.length < Secrets.MIN_LENGTH || seen.has(value)) continue;
      seen.add(value);
      this.items.push({ label, value, bytes: Buffer.from(value, 'utf8') });
    }
    // The longest first, so redacting one that contains another leaves nothing of either.
    this.items.sort((a, b) => b.value.length - a.value.length);
  }

  get size(): number {
    return this.items.length;
  }

  /** The labels of the secrets that appear in this text. */
  foundIn(text: string): string[] {
    return this.items.filter((s) => text.includes(s.value)).map((s) => s.label);
  }

  /** The text with every secret replaced. */
  redact(text: string): string {
    let out = text;
    for (const s of this.items) out = out.split(s.value).join('[secret removed]');
    return out;
  }

  /** The labels of the secrets that appear in a file, read a piece at a time (a video can be gigabytes). */
  async foundInFile(file: string): Promise<string[]> {
    if (!this.items.length) return [];
    const longest = this.items[0]!.bytes.length;
    const found = new Set<string>();
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      // What straddles two pieces is still found: each piece is searched with the end of the one before.
      const window = Buffer.concat([tail, chunk as Buffer]);
      for (const s of this.items) if (!found.has(s.label) && window.includes(s.bytes)) found.add(s.label);
      if (found.size === this.items.length) break;
      tail = window.subarray(Math.max(0, window.length - (longest - 1)));
    }
    return [...found];
  }
}

/**
 * The labels of the secrets present in a process's initial environment (on Linux, /proc/<pid>/environ: NUL-separated NAME=value).
 * Anything running as the same user can read that file for as long as the process lives, whatever the process later deletes from
 * its environment: so a secret found there can be read by an agent that is not kept apart from the runner.
 */
export function secretsInEnvironment(secrets: Secrets, environ: Buffer | string): string[] {
  const text = typeof environ === 'string' ? environ : environ.toString('utf8');
  return secrets.foundIn(text.split('\0').map((kv) => kv.slice(kv.indexOf('=') + 1)).join('\0'));
}
