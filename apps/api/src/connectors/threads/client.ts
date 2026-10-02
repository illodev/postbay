import { call, type Reply } from '../http.js';
import { classifyMeta } from '../meta/client.js';

export interface ThreadsConfig {
  appId: string;
  appSecret: string;
  oauthUrl: string;
  graphUrl: string;
}

/** The Threads API. It words its failures like the Graph API does, so the same classifier reads them. */
export class ThreadsClient {
  constructor(readonly cfg: ThreadsConfig) {}

  /** Calls on a user or a post live under a version; the sign-in endpoints do not. */
  api(path: string): string {
    return `${this.cfg.graphUrl}/v1.0/${path.replace(/^\//, '')}`;
  }

  private check(r: Reply): any {
    const err = classifyMeta(r);
    if (err) throw err;
    return r.body;
  }

  async get<T = any>(path: string, token: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.check(await call(this.api(path), { query: { ...query, access_token: token } }));
  }

  async post<T = any>(path: string, token: string, form: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.check(await call(this.api(path), { method: 'POST', form: { ...form, access_token: token } }));
  }

  /** The sign-in endpoints, which are not versioned. */
  async oauth<T = any>(path: string, o: { method?: string; query?: Record<string, string>; form?: Record<string, string> }): Promise<T> {
    return this.check(await call(`${this.cfg.graphUrl}/${path}`, o));
  }
}
