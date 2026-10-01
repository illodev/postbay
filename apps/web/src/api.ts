export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-requested-by': 'studio' },
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
  del: <T>(url: string) => request<T>('DELETE', url),
};

// ───────────────────────────── types ─────────────────────────────

export type Role = 'admin' | 'approver' | 'reviewer' | 'producer' | 'reader';
export type PieceState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'discarded';
export type VersionState = 'in_review' | 'changes_requested' | 'approved' | 'superseded' | 'discarded';
export type PublicationStatus = 'scheduled' | 'awaiting_reapproval' | 'on_hold' | 'published' | 'cancelled' | 'failed';

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
}

export interface VersionSummary {
  id: string;
  number: number;
  review_state: VersionState;
  created_at: string;
  notes: string;
  fingerprint: string;
  author: string | null;
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
  variant: { id: string; format: string; style: string; piece_id: string };
  piece: { id: string; title: string; kind: string; brief: string; ai_generated: boolean; review_state: PieceState };
  brand: { name: string; timezone: string; approval_rules: BrandSettings['rules']; paused: boolean };
  assets: Asset[];
  approvals: Approval[];
  versions: { id: string; number: number }[];
}

export type Anchor =
  | { type: 'time'; t: number; t_end?: number; position?: number }
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
  replies: Reply[];
}

export interface Account {
  id: string;
  network: string;
  external_id: string;
  display_name: string;
  status: string;
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
