import { english, msg, tr } from '../../i18n/index.js';
import { ConnectorError, type EventSubscription } from '../types.js';
import type { MetaClient } from './client.js';

/**
 * Meta pushes an account's comments to the app's webhook only with two subscriptions:
 *
 * - the app's own, made in its dashboard: the Page object's "feed" for a Facebook Page, the Instagram object's "comments" for an
 *   Instagram account;
 * - the app's to the Page (for Instagram, the Page the account is linked to): POST /{page-id}/subscribed_apps, with the Page's token,
 *   which needs pages_manage_metadata. It takes Page fields only: Meta refuses "comments" there ("You cannot use the subscribed_fields
 *   parameter to configure or subscribe to Webhooks for Instagram"), and an Instagram account's events need the Page subscribed to any
 *   Page field. Both accounts ask for "feed".
 *
 * The fields already on the Page are read first and kept: a subscription is never narrowed by connecting the other account.
 */

/** The Page field an account's comments need the app to be subscribed to on the Page, for Facebook and Instagram alike. */
export const PAGE_FIELD = 'feed';

/** Where the app's own subscription for an account's comments lives: an object of the app's webhooks and one of its fields. */
export interface AppSubscription {
  object: 'page' | 'instagram';
  field: string;
}

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

/** Whether the app itself is subscribed to that field of that object (its dashboard's Webhooks), read with the app's token. */
export async function appSubscribed(client: MetaClient, want: AppSubscription): Promise<boolean> {
  const r = await client.get<{ data?: { object?: string; active?: boolean; fields?: { name?: string }[] }[] }>(
    `${client.cfg.appId}/subscriptions`, `${client.cfg.appId}|${client.cfg.appSecret}`);
  const obj = (r.data ?? []).find((s) => s.object === want.object && s.active !== false);
  return !!obj?.fields?.some((f) => f.name === want.field);
}

export async function subscribe(client: MetaClient, page: string, token: string, wanted: string[], granted?: string[]): Promise<EventSubscription> {
  // Without pages_manage_metadata Meta refuses; it is asked for only when prizes are on, which is when the webhook matters.
  if (granted?.length && !granted.includes('pages_manage_metadata')) {
    const noteText = msg('connect.events.noPermission');
    return { subscribed: false, fields: [], note: english(noteText), noteText };
  }
  try {
    const existing = (await subscribedFields(client, page, token)) ?? [];
    const fields = [...new Set([...existing, ...wanted])];
    if (wanted.every((f) => existing.includes(f))) return { subscribed: true, fields };
    const r = await client.post<{ success?: boolean }>(`${page}/subscribed_apps`, token, { subscribed_fields: fields.join(',') });
    if (r.success === false) throw new ConnectorError('unknown', 'Meta did not confirm the subscription to the Page', { text: msg('connect.events.unconfirmed') });
    return { subscribed: true, fields };
  } catch (err) {
    // A permission refusal is about this subscription, not about the connection, which still publishes.
    if (err instanceof ConnectorError && err.errorClass === 'auth') {
      const noteText = msg('connect.events.refusedByMeta', { error: err.message.replace(/ \(Meta no longer accepts this connection\)$/, '') });
      return { subscribed: false, fields: [], note: english(noteText), noteText };
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

/**
 * What the account check says about the subscriptions (the Page's and the app's own): a line a person can act on, in the request's
 * language. Never fails the check.
 */
export async function describeSubscription(client: MetaClient, page: string, token: string, app: AppSubscription): Promise<string> {
  try {
    const fields = await subscribedFields(client, page, token);
    if (!fields?.includes(PAGE_FIELD)) return tr('connect.events.notSubscribed', { field: PAGE_FIELD });
  } catch (err) {
    return tr('connect.events.unreadable', { error: (err as Error).message });
  }
  try {
    if (!(await appSubscribed(client, app))) return tr('connect.events.appNotSubscribed', { object: app.object, field: app.field });
  } catch (err) {
    return tr('connect.events.appUnreadable', { error: (err as Error).message });
  }
  return tr(app.object === 'instagram' ? 'connect.events.subscribedInstagram' : 'connect.events.subscribed', { field: PAGE_FIELD });
}
