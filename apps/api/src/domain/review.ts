export type VersionState = 'in_review' | 'changes_requested' | 'approved' | 'superseded' | 'discarded';
export type PieceState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'discarded';

const TRANSITIONS: Record<VersionState, readonly VersionState[]> = {
  in_review: ['changes_requested', 'approved', 'superseded', 'discarded'],
  changes_requested: ['superseded', 'discarded'],
  approved: ['superseded', 'discarded'],
  superseded: [],
  discarded: [],
};

export function canTransition(from: VersionState, to: VersionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Review state of a piece, derived from the latest live version of each variant.
 * A version awaiting a decision outweighs an approved one: the piece is not ready until all of them are.
 */
export function derivePieceState(discarded: boolean, latestVersionStates: VersionState[]): PieceState {
  if (discarded) return 'discarded';
  const live = latestVersionStates.filter((s) => s !== 'superseded' && s !== 'discarded');
  if (live.length === 0) return 'draft';
  if (live.includes('changes_requested')) return 'changes_requested';
  if (live.includes('in_review')) return 'in_review';
  return 'approved';
}
