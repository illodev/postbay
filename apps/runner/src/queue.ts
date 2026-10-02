import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Stage = 'queued' | 'started' | 'agent_done' | 'uploaded';

/** One event being handled, with enough written down to carry on after a restart. */
export interface Item {
  /** The event id, which is also what makes a repeat delivery a no-op. */
  id: string;
  brand: string;
  type: string;
  receivedAt: string;
  payload: any;
  stage: Stage;
  /** Not before this time (ms since the epoch): used to wait for a busy piece. */
  notBefore: number;
  tries: number;
  runId?: string;
  runDir?: string;
  round?: number;
  maxRounds?: number;
  maxCost?: number | null;
  maxMinutes?: number;
  /** Everything the later stages need from the agent's work. */
  work?: Record<string, any>;
  versionId?: string;
  versionNumber?: number;
  repliedIds?: string[];
}

const SEEN_DAYS = 7;

/**
 * A queue made of files, so an event the runner has accepted survives a crash or a restart: the studio considers it
 * delivered the moment the runner answers, and will not send it again. Writes go to a temporary file first and are
 * renamed, so a half-written item never exists.
 */
export class Queue {
  private dir: string;
  private seenDir: string;
  private inFlight = new Set<string>();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'queue');
    this.seenDir = path.join(stateDir, 'seen');
    // The runner's own: no agent has any business reading the events or what the runner made of them.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.seenDir, { recursive: true, mode: 0o700 });
  }

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private write(item: Item) {
    const tmp = `${this.file(item.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(item));
    renameSync(tmp, this.file(item.id));
  }

  /** False when this event was already accepted (waiting, or finished within the last week). */
  add(item: Omit<Item, 'stage' | 'notBefore' | 'tries'> & Partial<Pick<Item, 'stage' | 'notBefore' | 'tries'>>): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(item.id)) throw new Error('Event ids are UUIDs');
    if (this.has(item.id)) return false;
    this.write({ stage: 'queued', notBefore: 0, tries: 0, ...item });
    return true;
  }

  has(id: string): boolean {
    try {
      statSync(this.file(id));
      return true;
    } catch {
      /* not waiting */
    }
    try {
      statSync(path.join(this.seenDir, id));
      return true;
    } catch {
      return false;
    }
  }

  list(): Item[] {
    const out: Item[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(path.join(this.dir, f), 'utf8')) as Item);
      } catch {
        /* a file being replaced: it will be there next time */
      }
    }
    return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** The oldest item that is due and that nobody is working on. It is marked as taken until released. */
  take(nowMs: number): Item | null {
    for (const item of this.list()) {
      if (this.inFlight.has(item.id) || item.notBefore > nowMs) continue;
      this.inFlight.add(item.id);
      return item;
    }
    return null;
  }

  release(id: string) {
    this.inFlight.delete(id);
  }

  save(item: Item) {
    this.write(item);
  }

  /** Finished: the item leaves the queue and its id is remembered, so a late repeat is ignored. */
  done(item: Item) {
    writeFileSync(path.join(this.seenDir, item.id), String(Date.now()));
    rmSync(this.file(item.id), { force: true });
    this.inFlight.delete(item.id);
  }

  /** Forgets finished events older than a week. */
  tidy(nowMs = Date.now()) {
    for (const f of readdirSync(this.seenDir)) {
      try {
        if (nowMs - statSync(path.join(this.seenDir, f)).mtimeMs > SEEN_DAYS * 86_400_000) rmSync(path.join(this.seenDir, f), { force: true });
      } catch {
        /* gone already */
      }
    }
  }
}
