import type { Role } from '../api';

/** What each role can do. The server is the authority; this only decides what to show. Mirrors apps/api/src/domain/roles.ts. */
export type Permission =
  | 'manage'
  | 'pause'
  | 'createPiece'
  | 'upload'
  | 'comment'
  | 'reply'
  | 'resolve'
  | 'requestChanges'
  | 'approve'
  | 'schedule'
  | 'audit';

const reader: Permission[] = [];
const producer: Permission[] = ['createPiece', 'upload', 'reply', 'resolve'];
const reviewer: Permission[] = ['comment', 'reply', 'resolve', 'requestChanges'];
const approver: Permission[] = [...reviewer, 'createPiece', 'upload', 'approve', 'schedule', 'pause', 'audit'];
const admin: Permission[] = [...approver, 'manage'];

const TABLE: Record<Role, Permission[]> = { reader, producer, reviewer, approver, admin };

export const can = (role: Role | undefined, p: Permission) => !!role && TABLE[role].includes(p);
