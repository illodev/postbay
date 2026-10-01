import type { Queryable, Row } from '../db.js';
import { notFound } from '../errors.js';

export interface PieceRow extends Row {
  id: string;
  brand_id: string;
  title: string;
  kind: string;
  review_state: string;
  discarded_at: string | null;
}
export interface VariantRow extends Row {
  id: string;
  piece_id: string;
  brand_id: string;
  format: string;
  style: string;
  piece_kind: string;
  piece_discarded: boolean;
}
export interface VersionRow extends Row {
  id: string;
  variant_id: string;
  piece_id: string;
  brand_id: string;
  number: number;
  author_user_id: string | null;
  author_token_id: string | null;
  fingerprint: string;
  review_state: string;
}

export async function loadPiece(db: Queryable, id: string, lock = false): Promise<PieceRow> {
  const row = await db.one<PieceRow>(`select * from piece where id = $1 ${lock ? 'for update' : ''}`, [id]);
  if (!row) throw notFound('Piece');
  return row;
}

export async function loadVariant(db: Queryable, id: string): Promise<VariantRow> {
  const row = await db.one<VariantRow>(
    `select v.*, p.brand_id, p.kind as piece_kind, (p.discarded_at is not null) as piece_discarded
     from variant v join piece p on p.id = v.piece_id where v.id = $1`,
    [id],
  );
  if (!row) throw notFound('Variant');
  return row;
}

export async function loadVersion(db: Queryable, id: string): Promise<VersionRow> {
  const row = await db.one<VersionRow>(
    `select ver.*, v.piece_id, p.brand_id
     from version ver join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
     where ver.id = $1`,
    [id],
  );
  if (!row) throw notFound('Version');
  return row;
}

export async function loadBrand(db: Queryable, id: string): Promise<Row> {
  const row = await db.one('select * from brand where id = $1', [id]);
  if (!row) throw notFound('Brand');
  return row;
}

export interface ApprovalRules {
  required_approvals: number;
  reapprove_on_move: boolean;
  checklist: string[];
}

export const rulesOf = (brand: Row): ApprovalRules => ({
  required_approvals: 1,
  reapprove_on_move: false,
  checklist: [],
  ...(brand.approval_rules as Partial<ApprovalRules>),
});
