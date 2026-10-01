export const ROLES = ['admin', 'approver', 'reviewer', 'producer', 'reader'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'brand.view'
  | 'brand.manage' // rules, members, social accounts, API tokens
  | 'brand.pause'
  | 'piece.create'
  | 'piece.discard'
  | 'version.upload'
  | 'comment.create'
  | 'comment.reply'
  | 'comment.resolve'
  | 'version.request_changes'
  | 'version.approve'
  | 'publication.schedule' // schedule, move, cancel, mark as published
  | 'audit.view';

const reader: Permission[] = ['brand.view'];
const producer: Permission[] = [
  ...reader,
  'piece.create',
  'piece.discard',
  'version.upload',
  'comment.reply',
  'comment.resolve',
];
const reviewer: Permission[] = [...reader, 'comment.create', 'comment.reply', 'comment.resolve', 'version.request_changes'];
const approver: Permission[] = [
  ...reviewer,
  'piece.create',
  'piece.discard',
  'version.upload',
  'version.approve',
  'publication.schedule',
  'brand.pause',
  'audit.view',
];
const admin: Permission[] = [...approver, 'brand.manage'];

/**
 * What each role can do. A producer uploads and replies but cannot approve; a reviewer comments and requests
 * changes but cannot approve or schedule; an approver does everything a reviewer does plus upload, approve, schedule
 * and pause; the admin also manages the brand. Nobody can approve their own uploads, whatever the role
 * (that rule lives in the approval itself: separating whoever produces from whoever approves is fixed).
 */
export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(admin),
  approver: new Set(approver),
  reviewer: new Set(reviewer),
  producer: new Set(producer),
  reader: new Set(reader),
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].has(permission);
}
