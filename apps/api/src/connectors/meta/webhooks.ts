import { ConnectorError, type EventSubscription } from '../types.js';
import type { MetaClient } from './client.js';

/**
 * Meta pushes a Page's events (its feed, the comments on its Instagram account) to the app's webhook only once the app is
 * subscribed to that Page: POST /{page-id}/subscribed_apps with the fields, using the Page's token, which needs
 * pages_manage_metadata. Registering the webhook address in the app's dashboard is not enough by itself.
 *
 * A Facebook account and an Instagram account can share one Page, and each asks for its own field, so the fields already there
 * are read first and kept: a subscription is never narrowed by connecting the other account.
 */
interface SubscribedApp {
  id?: string;
  name?: string;
  subscribed_fields?: string[];
}

/** The fields this app is subscribed to on the Page, or null if it is not subscribed at all. */
export async function subscribedFields(client: MetaClient, page: string, token: string): Promise<string[] | null> {
  const r = await client.get<{ data?: SubscribedApp[] }>(`${page}/subscribed_apps`, token);
  const ours = (r.data ?? []).find((a) => a.id === client.cfg.appId);
  return ours ? (ours.subscribed_fields ?? []) : null;
}

export async function subscribe(client: MetaClient, page: string, token: string, wanted: string[], granted?: string[]): Promise<EventSubscription> {
  // Without pages_manage_metadata Meta refuses; it is asked for only when prizes are on, which is when the webhook matters.
  if (granted?.length && !granted.includes('pages_manage_metadata')) {
    return { subscribed: false, fields: [], note: 'Not subscribed to the Page\'s events: that needs pages_manage_metadata, which is asked for only when prizes are on. Comments are read every few minutes instead.' };
  }
  try {
    const existing = (await subscribedFields(client, page, token)) ?? [];
    const fields = [...new Set([...existing, ...wanted])];
    if (wanted.every((f) => existing.includes(f))) return { subscribed: true, fields };
    const r = await client.post<{ success?: boolean }>(`${page}/subscribed_apps`, token, { subscribed_fields: fields.join(',') });
    if (r.success === false) throw new ConnectorError('unknown', 'Meta did not confirm the subscription to the Page');
    return { subscribed: true, fields };
  } catch (err) {
    // A permission refusal is about this subscription, not about the connection, which still publishes.
    if (err instanceof ConnectorError && err.errorClass === 'auth') {
      return { subscribed: false, fields: [], note: `Meta refused to subscribe the app to the Page's events (${err.message.replace(/ \(Meta no longer accepts this connection\)$/, '')}). It needs pages_manage_metadata, asked for only when prizes are on; comments are read every few minutes instead.` };
    }
    throw err;
  }
}

/** Takes away what only the disconnected account needed: everything, if nothing else on the Page needs it. */
export async function unsubscribe(client: MetaClient, page: string, token: string, keep: string[]): Promise<void> {
  if (keep.length === 0) {
    await client.delete(`${page}/subscribed_apps`, token);
    return;
  }
  await client.post(`${page}/subscribed_apps`, token, { subscribed_fields: [...new Set(keep)].join(',') });
}

/** What the account check says about the subscription: a line a person can act on. Never fails the check. */
export async function describeSubscription(client: MetaClient, page: string, token: string, field: string): Promise<string> {
  try {
    const fields = await subscribedFields(client, page, token);
    if (fields?.includes(field)) return `Meta sends this account's comments to the app as they happen (the app is subscribed to the Page's "${field}" events).`;
    return `The app is not subscribed to this Page's "${field}" events, so Meta does not push its comments: they are found by reading them every few minutes. Prizes subscribe it; connect the account again with prizes on if this stays.`;
  } catch (err) {
    return `Could not read whether the app is subscribed to the Page's events (${(err as Error).message}); that needs pages_manage_metadata, which is asked for only with prizes on.`;
  }
}
