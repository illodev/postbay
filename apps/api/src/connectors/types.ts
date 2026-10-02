import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import type { Localized, Params } from '../i18n/index.js';

export type Network = 'instagram' | 'facebook' | 'youtube' | 'tiktok' | 'linkedin' | 'x' | 'threads' | 'pinterest' | 'bluesky';
export type ProviderId = 'meta' | 'google' | 'threads' | 'tiktok' | 'linkedin' | 'x' | 'pinterest' | 'bluesky';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token stops working; absent for tokens that do not expire (a Facebook Page token). */
  expiresAt?: string;
  scopes?: string[];
  /** Whatever else a provider needs to keep with the credentials (Bluesky: the server and the app password, to start a new session). */
  extra?: Record<string, string>;
}

// ───────────────────────────── errors ─────────────────────────────

/**
 * What kind of failure it was decides what the app does next:
 *  - auth: the token is no good. Mark the account for reconnection and tell its admin.
 *  - rate_limit: wait for the next free window and try again.
 *  - file_rejected: the network refused this content. Do not retry; say which rule it broke.
 *  - transient: a hiccup on their side or ours. Retry with growing waits.
 *  - unsupported: the API cannot do this. Hand it to a person.
 */
export type ErrorClass = 'auth' | 'rate_limit' | 'file_rejected' | 'transient' | 'unsupported' | 'unknown';

export class ConnectorError extends Error {
  readonly httpStatus?: number;
  readonly retryAfterSec?: number;
  readonly detail?: unknown;
  /**
   * The message kept as a code (see src/i18n), when it is the studio's own words and not the network's: it is what people read, in
   * their language. `message` stays the English text, for logs and webhooks.
   */
  readonly text?: Localized | Localized[];
  constructor(
    public readonly errorClass: ErrorClass,
    message: string,
    opts: { httpStatus?: number; retryAfterSec?: number; detail?: unknown; text?: Localized | Localized[] } = {},
  ) {
    super(message);
    this.httpStatus = opts.httpStatus;
    this.retryAfterSec = opts.retryAfterSec;
    this.detail = opts.detail;
    this.text = opts.text;
  }
}

// ───────────────────────────── what a network declares ─────────────────────────────

export interface Issue {
  severity: 'error' | 'warning';
  /** Stable, for programs. The dictionary has its words as `issue.<code>` (src/i18n/messages/issues.ts). */
  code: string;
  /** In the language of the request that asked (Spanish outside one). */
  message: string;
  /** The values that fill the message, so it can be kept and said again in another language (a post that fails on it). */
  params?: Params;
  field?: 'text' | 'firstComment' | 'media' | 'schedule' | 'placement';
}

/**
 * A setting a network asks for that is its own (TikTok's privacy, a Pinterest board's link). The schedule dialog is drawn from
 * these, so a network can ask for what it needs without the screens knowing about it.
 */
export interface OptionField {
  key: string;
  label: string;
  /** 'info' is a line to read (who the post goes out as, how long processing takes), with nothing to fill in. */
  type: 'text' | 'url' | 'select' | 'checkbox' | 'info';
  /** A required field with no default has to be chosen by a person: nothing is filled in for them. */
  required?: boolean;
  help?: string;
  maxLength?: number;
  /** `disabledWhen`: this choice cannot be picked while that checkbox is ticked (TikTok: branded content cannot be "Only me"). */
  choices?: { value: string; label: string; disabledWhen?: string }[];
  default?: string | boolean;
  /** Only for these placements; absent means all. */
  placements?: string[];
  /** Only shown while this other checkbox is ticked. */
  showWhen?: string;
  /** Hidden while this other checkbox is ticked (a notice that another one replaces). */
  hideWhen?: string;
  /** Shown but cannot be changed: the network has switched it off for this account (TikTok's comments, duets, stitches). Its value is false. */
  disabled?: boolean;
  /** Text the network obliges the app to show next to the field, word for word. */
  notice?: string;
}

/** The settings to ask for when a post for this account is being written, as the network says right now (TikTok's creator info). */
export interface AccountOptions {
  fields: OptionField[];
  /** What the network said that the account should remember, so scheduling can be checked against it later without asking again. */
  remember?: Record<string, unknown>;
}

/** One way of posting on a network: a Reel, a feed photo, a Short… */
export interface PlacementSpec {
  id: string;
  label: string;
  accepts: ('video' | 'image')[];
  /** How many main files (images or videos) it takes. */
  items: { min: number; max: number };
  /** Width divided by height, as the network allows it. Outside this the content is refused. */
  aspect?: { min: number; max: number };
  /** Width divided by height where it looks right. Outside this it is allowed but warned about. */
  recommendedAspect?: { min: number; max: number };
  durationSec?: { min: number; max: number };
  /** Fractions of the frame the network's own interface covers: top, bottom, left, right. */
  safeZones?: { top: number; bottom: number; left: number; right: number };
  /** Ids of the file profiles its media is checked and, if needed, transcoded to (see profiles.ts), by kind of file. */
  profiles: Partial<Record<'video' | 'image', string>>;
  /** The network can hold the post and publish it by itself at the chosen time. */
  nativeScheduling: boolean;
}

export interface Capabilities {
  network: Network;
  placements: PlacementSpec[];
  text: {
    maxChars: number;
    /** What maxChars counts. Most networks count characters; Bluesky counts graphemes (what a person sees as one character). */
    unit?: 'chars' | 'graphemes';
    maxHashtags?: number;
    maxMentions?: number;
    /** Where the feed cuts the text off behind a "more" link, for the preview. */
    previewCutoff?: number;
    firstComment: boolean;
    firstCommentMaxChars?: number;
  };
  /** The network has a way to flag AI-generated content. */
  aiLabel: boolean;
  /** Settings of its own the person is asked for when scheduling. */
  options?: OptionField[];
  /** Earliest and latest the network itself will schedule ahead, if it can. */
  nativeScheduling: { minLeadMinutes: number; maxLeadDays: number } | null;
}

// ───────────────────────────── what a connector works with ─────────────────────────────

export interface Account {
  id: string;
  network: Network;
  externalId: string;
  displayName: string;
  providerData: Record<string, any>;
}

export interface MediaItem {
  kind: 'video' | 'image' | 'cover' | 'subtitles' | 'pdf';
  position: number;
  name: string;
  mime: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /** Storage key of the file that will be sent (the original, or the rendition made for the network's profile). */
  key: string;
  /** Address the network can download it from. */
  url: string;
}

export interface PublishInput {
  publicationId: string;
  placement: string;
  title: string;
  text: string;
  firstComment: string;
  options: Record<string, unknown>;
  scheduledAt: Date;
  aiGenerated: boolean;
  media: MediaItem[];
}

/** Whatever a connector needs to remember between steps, kept as JSON on the publication so a step can resume. */
export type Handle = Record<string, any>;

export interface PrepareResult {
  /** False means "not ready yet, ask me again in retryAfterSec" (a container still processing, say). */
  done: boolean;
  handle: Handle;
  retryAfterSec?: number;
  /** The network will publish by itself at the scheduled time. */
  nativeScheduled?: boolean;
}

export interface Published {
  externalId: string;
  url?: string;
}

export type Visibility = 'public' | 'private' | 'processing' | 'scheduled' | 'unknown';

export interface VerifyResult {
  visibility: Visibility;
  url?: string;
  note?: string;
  /** The note kept as a code, when the connector words it itself (see ConnectorError.text). */
  noteText?: Localized;
  /** Changes to remember (a first comment that has now been posted); merged into the handle. */
  handle?: Handle;
  /**
   * When to look again, for a post that is not settled yet (processing, scheduled): what the network's own pace calls for. Without it
   * the publisher looks again in a minute.
   */
  retryAfterSec?: number;
}

export interface HealthResult {
  valid: boolean;
  /** When the credentials stop working, if known. */
  expiresAt?: string;
  /** Why it is not valid; or, when it is, something worth knowing about the account (whether the network pushes its comments). */
  note?: string;
}

/** Whether the network pushes this account's events (comments) to the app: Meta only does once the app is subscribed to the Page. */
export interface EventSubscription {
  subscribed: boolean;
  /** The fields the app is subscribed to on the Page now. */
  fields: string[];
  note?: string;
  /** The note kept as a code (see ConnectorError.text): stored beside it as `note_i18n`, so each person reads it in their language. */
  noteText?: Localized;
}

// ───────────────────────────── what came of a post ─────────────────────────────

/**
 * The numbers every network can be asked for, under one name each. Networks count a "view" their own way, so these are only
 * compared within the same network. Whatever a network does not give is left out, never written as zero.
 */
export interface CommonMetrics {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  /** Average time watched, in seconds. */
  avgWatchSeconds?: number;
  /** All the time spent watching, in minutes. */
  watchMinutes?: number;
}

export interface MetricsResult {
  common: CommonMetrics;
  /** The network's whole answer, with anything secret removed. */
  raw: unknown;
  /** Why something is missing or late, for the person reading the numbers. */
  note?: string;
}

export interface NetworkComment {
  id: string;
  /** The network's id for the person, and a name to show. Personal data: kept only as long as the brand allows. */
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface ConnectorEnv {
  /** Credentials, refreshed first if they are about to expire. */
  token(): Promise<TokenSet>;
  now(): Date;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  /** A stored file as a stream from a byte offset: what resumable uploads need. */
  open(key: string, start?: number): Promise<{ stream: Readable; size: number }>;
  /** Saves progress right away (an upload session address, a container id) so a crash does not lose it. */
  persist(handle: Handle): Promise<void>;
}

export interface Connector {
  network: Network;
  provider: ProviderId;
  capabilities(account?: Account): Capabilities;
  /** The placement a publication gets when nobody picked one, or null if this network cannot do it. */
  defaultPlacement(input: { pieceKind: string; format: string; media: Pick<MediaItem, 'kind'>[] }): string | null;
  /** Checks a publication against what the network allows, before anything is sent. */
  validate(input: PublishInput, account: Account): Issue[];
  /**
   * The settings for a post on this account, asked of the network while the post is being written. Only where the network obliges an
   * app to (TikTok's creator info: the privacy choices it offers this account, what it has switched off). Without it, the
   * account's capabilities(account).options are the settings.
   */
  accountOptions?(account: Account, env: ConnectorEnv): Promise<AccountOptions>;
  prepare(input: PublishInput, account: Account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult>;
  publish(input: PublishInput, account: Account, handle: Handle, env: ConnectorEnv): Promise<Published>;
  /**
   * Looks, without sending anything, for the post an earlier try may already have made, from what that try saved in the handle (a
   * container that Instagram says is published, the time a post was attempted…). Returns the handle with the post's id filled in when
   * the post exists, so that `publish` finishes the steps after it (the link, the first comment) and never posts again; null when the
   * network shows no such post, so it is safe to send one. Throws when it cannot tell.
   *
   * The publisher calls it before any repeated send (after a crash, a lost answer or a failed step): within the tolerance a post that is
   * not there is sent; past it, it is not sent late.
   */
  find?(input: PublishInput, account: Account, handle: Handle, env: ConnectorEnv): Promise<Handle | null>;
  verify(account: Account, externalId: string, handle: Handle, env: ConnectorEnv): Promise<VerifyResult>;
  health?(account: Account, env: ConnectorEnv): Promise<HealthResult>;
  /**
   * Takes down whatever was prepared on the network (a held post, an uploaded video) when the publication is cancelled,
   * replaced or failed. Only needed where the network itself would otherwise still publish it at the scheduled time.
   */
  discard?(account: Account, handle: Handle, env: ConnectorEnv): Promise<void>;
  /**
   * Asks the network to push this account's events to the app's webhook, where it has to be asked (Meta: POST
   * /{page-id}/subscribed_apps). Done on connecting and when a prize starts relying on it.
   */
  subscribeEvents?(account: Account, env: ConnectorEnv): Promise<EventSubscription>;
  /** The opposite, when the account is disconnected. `keep`: fields that another connected account on the same Page still needs. */
  unsubscribeEvents?(account: Account, env: ConnectorEnv, keep: string[]): Promise<void>;
  /** The webhook fields this account's events need (Meta: a Page's `feed`, an Instagram account's `comments`). */
  eventFields?: string[];
  /** The numbers for a published post. Not every network gives every number (see CommonMetrics). */
  fetchMetrics?(account: Account, externalId: string, handle: Handle, env: ConnectorEnv, post: { publishedAt: Date; placement: string }): Promise<MetricsResult>;
  /** The comments on a post since a moment, oldest first. Only where the network lets the app read them. */
  listComments?(account: Account, externalId: string, handle: Handle, env: ConnectorEnv, since: Date): Promise<NetworkComment[]>;
  /** One private message to the author of a comment, in reply to it. Only where the network has an official way to. */
  privateReply?(account: Account, commentId: string, text: string, env: ConnectorEnv): Promise<{ messageId?: string }>;
}

// ───────────────────────────── signing in with a network ─────────────────────────────

/** An account a sign-in found, and the credentials that belong to it. */
export interface Candidate {
  key: string;
  network: Network;
  externalId: string;
  displayName: string;
  token: TokenSet;
  providerData: Record<string, any>;
}

/**
 * One sign-in with a provider can yield several accounts: a Facebook login finds Pages and the Instagram accounts linked
 * to them. So OAuth lives here, one level above the per-network connectors.
 */
/** What the brand uses, so a sign-in asks for only the permissions that need: messages are asked for only if prizes are on. */
export interface SignInFeatures {
  prizes?: boolean;
}

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  help?: string;
  required?: boolean;
}

export interface OAuthProvider {
  id: ProviderId;
  label: string;
  networks: Network[];
  /** Sign-in by a page on the network (most of them). */
  authorizeUrl?(state: string, redirectUri: string, features?: SignInFeatures): string;
  /** `state` is passed back so a provider that needs a per-attempt secret (PKCE) can derive it from it instead of storing it. */
  exchange?(code: string, redirectUri: string, state?: string): Promise<Candidate[]>;
  /** Sign-in by credentials the person types (Bluesky's app password): no page to be sent to. */
  credentials?: { fields: CredentialField[]; connect(values: Record<string, string>): Promise<Candidate[]> };
  /** New credentials for an account whose access token is expiring. Providers whose tokens do not expire leave it out. */
  refresh?(token: TokenSet): Promise<TokenSet>;
  /** How long before an access token runs out it is renewed (default two minutes): a token that lasts months is renewed days ahead. */
  refreshWindowSec?: number;
}

export interface ConnectorSet {
  connector(network: Network): Connector | null;
  provider(id: ProviderId): OAuthProvider | null;
  providerOf(network: Network): OAuthProvider | null;
  networks(): Network[];
}

export type ConnectorFactory = (config: Config) => ConnectorSet;
