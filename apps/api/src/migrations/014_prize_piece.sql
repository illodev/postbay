-- Prizes made from a piece of the studio, and the record of when a version was approved that they read.

-- ───────────────────────── when a version reached its approval ─────────────────────────

-- A version that got the approvals it needs, and when. A version's state says only where it is now: once a newer one is uploaded it is
-- "superseded", whether it had been approved or not. This says it was, and stays: a prize made from a piece hands out the latest
-- version of it that was approved, also while a newer one is still in review (services/prizes.ts). Written with the approval that
-- completes it (services/approvals.ts). Only ever added to.
create table version_approved (
  version_id  uuid primary key references version(id),
  piece_id    uuid not null references piece(id),
  approved_at timestamptz not null default now()
);
create index version_approved_piece_idx on version_approved (piece_id, approved_at desc);
create trigger version_approved_append_only before update or delete on version_approved
  for each row execute function append_only();
create trigger version_approved_no_truncate before truncate on version_approved
  for each statement execute function append_only();

-- The versions approved before this table: those approved now, and those the audit log says reached their approval before a newer
-- version replaced them.
insert into version_approved (version_id, piece_id, approved_at)
select ver.id, v.piece_id,
       coalesce((select max(a.at) from audit_event a where a.entity = 'version' and a.entity_id = ver.id and a.action = 'version.approved'
                   and a.after->>'review_state' = 'approved'), ver.created_at)
from version ver join variant v on v.id = ver.variant_id
where ver.review_state = 'approved'
   or exists (select 1 from audit_event a where a.entity = 'version' and a.entity_id = ver.id and a.action = 'version.approved'
                and a.after->>'review_state' = 'approved');

-- ───────────────────────── a prize made from a piece ─────────────────────────

-- A third kind of prize besides a file kept for it and a link: a piece of the studio. What is handed out is the main file of the
-- latest approved version of the piece at the moment it is downloaded, so approving a new version changes the prize for whoever
-- comments afterwards; with no approved version (the piece was discarded) it hands out nothing.
alter table prize drop constraint prize_kind_check;
alter table prize add constraint prize_kind_check check (kind in ('file','link','piece'));
alter table prize add column piece_id uuid references piece(id);
alter table prize drop constraint prize_check;
alter table prize add constraint prize_source_check check (
  (kind = 'file' and file_key is not null) or (kind = 'link' and url is not null) or (kind = 'piece' and piece_id is not null)
);
create index prize_piece_idx on prize (piece_id) where piece_id is not null;
