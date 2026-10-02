import { getLocale } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // The API writes what a person reads (reasons, checks, errors) in the language the interface is in.
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-requested-by': 'studio', 'accept-language': getLocale() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

// ───────────────────────────── types ─────────────────────────────

export type Role = 'admin' | 'approver' | 'reviewer' | 'producer' | 'reader';
export type PieceState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'discarded';
export type VersionState = 'in_review' | 'changes_requested' | 'approved' | 'superseded' | 'discarded';
export type PublicationStatus = 'scheduled' | 'awaiting_reapproval' | 'on_hold' | 'preparing' | 'ready' | 'publishing' | 'published' | 'cancelled' | 'failed';
export type Visibility = 'public' | 'private' | 'processing' | 'scheduled' | 'unknown';

export interface Me {
  user: { id: string; email: string; name: string | null };
  brands: { id: string; name: string; timezone: string; paused: boolean; role: Role; workspace: string }[];
}

export interface BrandSettings {
  id: string;
  name: string;
  timezone: string;
  locale: string;
  paused: boolean;
  role: Role;
  rules: { required_approvals: number; reapprove_on_move: boolean; checklist: string[] };
  publishing: { prepare_lead_minutes: number; late_tolerance_minutes: number };
  agent: AgentSettings;
  prizes: PrizeSettings;
}

export interface PrizeSettings {
  enabled: boolean;
  retention_days: number;
  auto_notice: string;
}

export interface AgentSettings {
  max_rounds: number;
  max_cost_per_piece: number | null;
  max_cost_per_month: number | null;
  max_run_minutes: number;
  slot_alert_days: number;
  currency: string;
}

export interface PieceSummary {
  id: string;
  title: string;
  kind: string;
  review_state: PieceState;
  target_date: string | null;
  ai_generated: boolean;
  created_at: string;
  variant_count: number;
  open_comments: number;
  campaign_id: string | null;
  source?: string | null;
  /** Filled by the richer list (latest version, its format, who made it, what is scheduled). */
  latest_by_agent?: boolean;
}

export interface VersionSummary {
  id: string;
  number: number;
  review_state: VersionState;
  created_at: string;
  notes: string;
  fingerprint: string;
  author: string | null;
  by_agent?: boolean;
  open_comments: number;
}

export interface Variant {
  id: string;
  format: string;
  style: string;
  versions: VersionSummary[];
}

export interface PublicationRow {
  id: string;
  status: PublicationStatus;
  scheduled_at: string;
  text: string;
  hold_reason: string | null;
  url: string | null;
  network: string;
  account_name: string;
  version_id: string;
  version_number: number;
  variant_id: string;
  social_account_id: string;
  manual: boolean;
  visibility: Visibility | null;
  placement: string | null;
  native_scheduled: boolean;
  last_error: string | null;
  last_error_class: string | null;
}

export interface PieceDetail {
  id: string;
  brand_id: string;
  title: string;
  kind: string;
  brief: string;
  review_state: PieceState;
  target_date: string | null;
  ai_generated: boolean;
  discarded_at: string | null;
  variants: Variant[];
  publications: PublicationRow[];
}

export interface Asset {
  id: string;
  kind: 'video' | 'image' | 'pdf' | 'subtitles' | 'cover';
  position: number;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  fps: number | null;
  bytes: number;
  sha256: string;
  url: string;
}

export interface Approval {
  id: string;
  decision: 'approve' | 'reject';
  account_ids: string[];
  note: string;
  created_at: string;
  approver: string;
  matches_fingerprint: boolean;
  checklist: Record<string, boolean>;
}

export interface VersionDetail {
  id: string;
  number: number;
  notes: string;
  fingerprint: string;
  review_state: VersionState;
  created_at: string;
  author: string | null;
  author_user_id: string | null;
  by_agent: boolean;
  /** A person, or a producer token and the person who made it (who is not, for approval, its author). */
  uploaded_by?: { kind: 'user'; id: string; name: string | null } | { kind: 'token'; id: string; name: string; created_by: { id: string; name: string | null } } | null;
  variant: { id: string; format: string; style: string; piece_id: string };
  piece: { id: string; title: string; kind: string; brief: string; ai_generated: boolean; review_state: PieceState };
  brand: { name: string; timezone: string; approval_rules: BrandSettings['rules']; paused: boolean };
  assets: Asset[];
  approvals: Approval[];
  versions: { id: string; number: number }[];
}

export type Anchor =
  | { type: 'time'; t: number; t_end?: number; position?: number; track?: number; cue?: number; cue_text?: string }
  | { type: 'region'; page: number; x: number; y: number; w: number; h: number };

export interface Reply {
  id: string;
  body: string;
  reply_kind: 'fixed' | 'cannot_do' | 'needs_human' | null;
  created_at: string;
  author: string;
  by_agent: boolean;
}

export interface CommentThread {
  id: string;
  version_id: string;
  version_number: number;
  body: string;
  anchor: Anchor | null;
  status: 'open' | 'resolved';
  author: string;
  created_at: string;
  carried: boolean;
  resolved_in_number: number | null;
  resolved_by: string | null;
  frame_url: string | null;
  /** Something the agent must leave alone. */
  people_only: boolean;
  replies: Reply[];
}

export interface Account {
  id: string;
  network: string;
  external_id: string;
  display_name: string;
  status: 'active' | 'reconnect_required' | 'manual';
  connected: boolean;
  /** The app publishes to it by itself. */
  automated: boolean;
  last_error: string | null;
  last_health_at: string | null;
  details: { audited?: boolean; username?: string; missingScopes?: string[]; dataAccessExpiresAt?: string };
}

export interface PlacementSpec {
  id: string;
  label: string;
  accepts: ('video' | 'image')[];
  items: { min: number; max: number };
  aspect?: { min: number; max: number };
  recommendedAspect?: { min: number; max: number };
  durationSec?: { min: number; max: number };
  safeZones?: { top: number; bottom: number; left: number; right: number };
  nativeScheduling: boolean;
}

export interface Capabilities {
  network: string;
  placements: PlacementSpec[];
  text: { maxChars: number; unit?: 'chars' | 'graphemes'; maxHashtags?: number; maxMentions?: number; previewCutoff?: number; firstComment: boolean; firstCommentMaxChars?: number };
  aiLabel: boolean;
  /** Settings of its own that the network asks for when scheduling. */
  options?: OptionField[];
  nativeScheduling: { minLeadMinutes: number; maxLeadDays: number } | null;
}

export interface OptionField {
  key: string;
  label: string;
  /** 'info' is a line to read (who the post goes out as, how long processing takes), with nothing to fill in. */
  type: 'text' | 'url' | 'select' | 'checkbox' | 'info';
  required?: boolean;
  help?: string;
  maxLength?: number;
  /** `disabledWhen`: the choice cannot be picked while that checkbox is ticked. */
  choices?: { value: string; label: string; disabledWhen?: string }[];
  default?: string | boolean;
  placements?: string[];
  showWhen?: string;
  /** Hidden while this other checkbox is ticked. */
  hideWhen?: string;
  /** Shown, but the network has switched it off for this account: it cannot be changed. */
  disabled?: boolean;
  /** Text the network obliges the app to show next to the field, word for word. */
  notice?: string;
}

/** The settings to ask for when writing a post for one account (TikTok's are asked of TikTok at that moment). */
export interface AccountOptionsReply {
  fields: OptionField[];
  /** True when the network was asked just now. */
  live: boolean;
}

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  help?: string;
  required?: boolean;
}

export interface Provider {
  id: string;
  label: string;
  networks: string[];
  configured: boolean;
  /** A sign-in page, or a form for credentials the person types (Bluesky's app password). */
  signIn: 'redirect' | 'credentials';
  fields: CredentialField[];
}

export interface Integrations {
  providers: Provider[];
  capabilities: Record<string, Capabilities>;
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  field?: string;
}

export interface Plan {
  automated: boolean;
  placement: string | null;
  placements: { id: string; label: string }[];
  issues: Issue[];
  manualReason?: string;
}

export interface Attempt {
  id: number;
  step: 'prepare' | 'publish' | 'verify' | 'discard';
  attempt: number;
  started_at: string;
  outcome: 'ok' | 'pending' | 'error';
  error_class: string | null;
  http_status: number | null;
  detail: { message?: string; visibility?: string; note?: string; retryAfterSec?: number };
}

export interface Candidate {
  key: string;
  network: string;
  externalId: string;
  displayName: string;
  providerData: { missingScopes?: string[]; username?: string; boardId?: string; organizationId?: string };
  existing: { id: string; status: string } | null;
}

export interface PendingConnection {
  id: string;
  provider: string;
  candidates: Candidate[];
  reconnect: { id: string; network: string; display_name: string; status: string } | null;
}

export interface CalendarData {
  timezone: string;
  paused: boolean;
  publications: (PublicationRow & { piece_id: string; piece_title: string; account_id: string })[];
  blocked: { day: string; reason: string }[];
  slots: {
    id: string;
    account_id: string;
    network: string;
    account_name: string;
    label: string;
    day: string;
    at: string;
    filled: boolean;
    past: boolean;
    blocked: boolean;
  }[];
}

export interface NotificationItem {
  id: string;
  kind: string;
  payload: { pieceId?: string; versionId?: string };
  read_at: string | null;
  created_at: string;
  brand: string;
  brand_id: string;
  piece_title: string | null;
}


// ───────────────────────────── webhooks and the agent ─────────────────────────────

export interface WebhookEventType {
  type: string;
  description: string;
}

export interface Webhook {
  id: string;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  disabled_reason: string | null;
  secret_hint: string;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  pending: number;
  failed_24h: number;
}

export interface WebhookDelivery {
  id: string;
  status: 'pending' | 'delivered' | 'failed';
  type: string;
  attempts: number;
  next_attempt_at: string | null;
  expires_at: string;
  last_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface WebhookDeliveryDetail {
  id: string;
  status: WebhookDelivery['status'];
  type: string;
  attempts: { at: string; http_status: number | null; error: string | null; duration_ms: number | null }[];
}

export type AgentOutcome = 'uploaded' | 'needs_people' | 'failed' | 'checks_failed' | 'timeout' | 'aborted' | 'blocked';

export interface AgentRun {
  id: string;
  piece_id: string | null;
  trigger: string;
  status: 'running' | 'finished';
  outcome: AgentOutcome | null;
  blocked_reason: string | null;
  started_at: string;
  finished_at: string | null;
  cost: number;
  notes: string;
  version_id: string | null;
  version_number: number | null;
  counted?: boolean;
  piece_title?: string | null;
  token_name?: string | null;
  detail: { checks?: { errors?: number; warnings?: number; summary?: string[] } } & Record<string, unknown>;
}

export interface PieceAgent {
  settings: AgentSettings;
  rounds: number;
  max_rounds: number;
  spent_piece: number;
  spent_month: number;
  status: 'idle' | 'running' | 'needs_person';
  blocked_reason: string | null;
  blocked_message: string | null;
  runs: AgentRun[];
}

export interface BrandAgent {
  settings: AgentSettings;
  month_start: string;
  spent_month: number;
  runs: AgentRun[];
}


// ───────────────────────────── results ─────────────────────────────

export interface CommonMetrics {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  avgWatchSeconds?: number;
  /** All the time spent watching, in minutes. */
  watchMinutes?: number;
}

export type MetricAge = '1h' | '6h' | '22h' | '1d' | '7d' | '28d';

export interface MetricSnapshot {
  age: MetricAge;
  status: 'pending' | 'ok' | 'unavailable' | 'failed' | 'expired';
  due_at: string;
  taken_at: string | null;
  metrics: CommonMetrics;
  note: string | null;
}

export interface MetricsRow {
  publication: { id: string; network: string; account: string; piece_id: string; piece: string; placement: string | null; published_at: string; url: string | null; visibility: string | null };
  snapshots: MetricSnapshot[];
  latest: { age: MetricAge; taken_at: string; metrics: CommonMetrics } | null;
}

export interface BrandMetrics {
  from: string;
  to: string;
  rows: MetricsRow[];
  networks: { network: string; posts: number; read: number; totals: CommonMetrics }[];
}

// ───────────────────────────── prizes ─────────────────────────────

export interface Prize {
  id: string;
  name: string;
  kind: 'file' | 'link';
  file_name: string | null;
  file_bytes: number | null;
  url: string | null;
  /** A file prize is usable once its bytes have arrived. */
  usable: boolean;
  archived: boolean;
  created_at: string;
  active_rules?: number;
}

export interface PrizeRule {
  id: string;
  publication_id: string;
  mode: 'private_reply' | 'public_link';
  active: boolean;
  keyword: string;
  message: string;
  link_hours: number;
  notice_confirmed: boolean;
  prize: Prize | null;
  public_url: string | null;
  public_expires_at: string | null;
  deliveries: { pending: number; sent: number; skipped: number; failed: number };
}

export interface PublicationPrize {
  rule: PrizeRule | null;
  mode: 'private_reply' | 'public_link';
  prizes_enabled: boolean;
  auto_notice: string;
  /** Null where nothing is sent privately; false where the account was connected without the permission. */
  can_message: boolean | null;
}

export interface PrizeDelivery {
  id: string;
  person: string;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  reason: string | null;
  comment_at: string;
  sent_at: string | null;
  downloads: number;
  expires_at: string | null;
  purge_after: string;
}

// ───────────────────────────── readiness checks ─────────────────────────────

export interface CheckResult {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  title: string;
  detail: string;
  /** What to do about it, when it is not a pass. */
  hint?: string;
}

export interface AccountReport {
  account: { id: string; network: string; display_name: string };
  results: CheckResult[];
  ok: boolean;
}


// ───────────────────────────── signing in ─────────────────────────────

export interface PublicConfig {
  devLogin: boolean;
  /** Single sign-on, when the server has it: what the button says. */
  sso: { label: string } | null;
  emailLinkLogin: boolean;
}

/** Where a sign-in stands: none, or still owing the second step (verify: has an authenticator; enroll: has to set one up). */
export interface AuthState {
  signedIn: boolean;
  secondFactor: 'none' | 'verify' | 'enroll';
}

export interface SecondFactorStatus {
  enrolled: boolean;
  required: boolean;
  requiredByRole: boolean;
  recoveryCodesLeft: number;
}

export interface Enrollment {
  secret: string;
  otpauthUrl: string;
}

// ───────────────────────────── notifications ─────────────────────────────

export interface NotificationPreferences {
  kinds: { kind: string; label: string }[];
  emailKinds: string[];
  pushKinds: string[];
  /** How many browsers have push set up for this person. */
  pushDevices: number;
}

export interface SlackSettings {
  /** False when the server has no TOKEN_KEY to seal the address with. */
  available: boolean;
  allKinds: { kind: string; label: string; default: boolean }[];
  configured: boolean;
  /** The end of the address, enough to recognise it. The address itself is never sent back. */
  hint: string | null;
  kinds: string[];
  lastOkAt: string | null;
  lastError: string | null;
  disabledReason: string | null;
}


// ───────────────────────────── subtitles ─────────────────────────────

export interface SubtitleCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface SubtitleTrack {
  assetId: string;
  /** Which subtitle file of the version. */
  position: number;
  name: string;
  cues: SubtitleCue[];
  skipped: number;
  truncated: boolean;
  problem?: string;
}


// ───────────────────────────── "for you" ─────────────────────────────

/** Approve: the versions waiting for this person's decision. Comment: they cannot approve, so the ones in review to comment on. View: to look at. */
export type AwaitingMode = 'approve' | 'comment' | 'view';

export interface AwaitingItem {
  version_id: string;
  version_number: number;
  variant_id: string;
  variant_format: string;
  piece_id: string;
  piece_title: string;
  piece_kind: string;
  created_at: string;
  by_agent: boolean;
  author: string | null;
  /** Open threads across the variant: what has to be settled before approving. */
  open_comments: number;
  /** Earlier threads this version resolves, out of `earlier_comments`. */
  resolves: number;
  earlier_comments: number;
  thumb: string;
}

export interface TodayItem {
  id: string;
  scheduled_at: string;
  /** HH:mm in the brand's zone. */
  time: string;
  status: PublicationStatus;
  manual: boolean;
  /** By hand, and its hour has come. */
  due: boolean;
  placement: string | null;
  url: string | null;
  network: string;
  account_name: string;
  piece_id: string;
  piece_title: string;
  piece_kind: string;
  version_id: string;
  version_number: number;
  thumb: string;
}

export type AttentionKind =
  | 'publication_failed'
  | 'publication_on_hold'
  | 'publication_awaiting_confirmation'
  | 'account_reconnect'
  | 'webhook_failing'
  | 'agent_needs_person';

export type AttentionAction =
  | { type: 'retry'; publication_id: string }
  | { type: 'confirm'; publication_id: string }
  | { type: 'review'; to: string }
  | { type: 'open'; to: string }
  | { type: 'reconnect'; to: string }
  | { type: 'webhooks'; to: string };

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  at: string;
  /** A code to word: an error class, a block reason, why a publication is held. */
  reason: string | null;
  /** What the server or the network said, as it said it. */
  detail: string | null;
  piece_id: string | null;
  /** The piece, or the address of a webhook. */
  piece_title: string | null;
  version_id: string | null;
  network: string | null;
  account_name: string | null;
  scheduled_at: string | null;
  thumb: string | null;
  /** Null when this person cannot do anything about it here. */
  action: AttentionAction | null;
}

export type ActivityKind = 'comment' | 'version' | 'approved' | 'rejected' | 'changes_requested' | 'published' | 'agent_handed';

export interface ActivityItem {
  kind: ActivityKind;
  id: string;
  at: string;
  /** A person, the agent's token name, or null for the studio itself. */
  actor: string | null;
  by_agent: boolean;
  piece_id: string | null;
  piece_title: string | null;
  version_id: string | null;
  version_number: number | null;
  text: string | null;
  t: number | null;
  t_end: number | null;
  page: number | null;
  networks: string[];
  account_name: string | null;
  resolves: number | null;
}

export interface Overview {
  role: Role;
  timezone: string;
  now: string;
  awaiting_mode: AwaitingMode;
  awaiting: AwaitingItem[];
  today: TodayItem[];
  attention: AttentionItem[];
  activity: ActivityItem[];
}
