-- Approving an already approved version for more accounts: a network connected after the version was approved, say. The files are the
-- same ones, so nothing about the approval is voided; the accounts are added. Each row is one approver adding accounts, for the
-- fingerprint they saw, with the checklist they ticked. An added account counts once as many approvers as the brand needs have approved
-- it, a first approval of the version counting for the accounts it named (services/approvals.ts). Only ever added to, like the approvals.
create table approval_extension (
  id                   uuid primary key default gen_random_uuid(),
  version_id           uuid not null references version(id),
  approver_user_id     uuid not null references app_user(id),
  account_ids          uuid[] not null check (cardinality(account_ids) between 1 and 50),
  approved_fingerprint text not null,
  checklist            jsonb not null default '{}',
  note                 text not null default '',
  created_at           timestamptz not null default now()
);
create index approval_extension_version_idx on approval_extension (version_id, created_at);

create trigger approval_extension_append_only before update or delete on approval_extension
  for each row execute function append_only();
create trigger approval_extension_no_truncate before truncate on approval_extension
  for each statement execute function append_only();
