import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

export type Network = 'instagram' | 'facebook' | 'youtube' | 'tiktok' | 'linkedin' | 'x' | 'threads' | 'pinterest' | 'bluesky';
export type ProviderId = 'meta' | 'google';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token stops working; absent for tokens that do not expire (a Facebook Page token). */
  expiresAt?: string;
  scopes?: string[];
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
  constructor(
    public readonly errorClass: ErrorClass,
    message: string,
    opts: { httpStatus?: number; retryAfterSec?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.httpStatus = opts.httpStatus;
    this.retryAfterSec = opts.retryAfterSec;
    this.detail = opts.detail;
  }
}

// ───────────────────────────── what a network declares ─────────────────────────────

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  field?: 'text' | 'firstComment' | 'media' | 'schedule' | 'placement';
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
    maxHashtags?: number;
    maxMentions?: number;
    /** Where the feed cuts the text off behind a "more" link, for the preview. */
    previewCutoff?: number;
    firstComment: boolean;
    firstCommentMaxChars?: number;
  };
  /** The network has a way to flag AI-generated content. */
  aiLabel: boolean;
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
  /** Changes to remember (a first comment that has now been posted); merged into the handle. */
  handle?: Handle;
}

export interface HealthResult {
  valid: boolean;
  /** When the credentials stop working, if known. */
  expiresAt?: string;
  note?: string;
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
  prepare(input: PublishInput, account: Account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult>;
  publish(input: PublishInput, account: Account, handle: Handle, env: ConnectorEnv): Promise<Published>;
  verify(account: Account, externalId: string, handle: Handle, env: ConnectorEnv): Promise<VerifyResult>;
  health?(account: Account, env: ConnectorEnv): Promise<HealthResult>;
  /**
   * Takes down whatever was prepared on the network (a held post, an uploaded video) when the publication is cancelled,
   * replaced or failed. Only needed where the network itself would otherwise still publish it at the scheduled time.
   */
  discard?(account: Account, handle: Handle, env: ConnectorEnv): Promise<void>;
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
export interface OAuthProvider {
  id: ProviderId;
  label: string;
  networks: Network[];
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<Candidate[]>;
  /** New credentials for an account whose access token is expiring. Providers whose tokens do not expire leave it out. */
  refresh?(token: TokenSet): Promise<TokenSet>;
}

export interface ConnectorSet {
  connector(network: Network): Connector | null;
  provider(id: ProviderId): OAuthProvider | null;
  providerOf(network: Network): OAuthProvider | null;
  networks(): Network[];
}

export type ConnectorFactory = (config: Config) => ConnectorSet;
