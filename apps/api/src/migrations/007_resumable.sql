-- Phase 5: uploads that can be resumed. A large file is sent in pieces through the app and kept on disk (a staging file) until all of it
-- has arrived and its hash has been checked; only then is it put in storage. The row says how much has arrived, so a browser that lost its
-- connection (or was closed) asks and carries on from there.
alter table upload
  add column resumable      boolean not null default false,
  add column received_bytes bigint not null default 0,
  add column completed_at   timestamptz;

-- Finding the unfinished upload of the same file when it is chosen again.
create index upload_resume_idx on upload (variant_id, sha256) where resumable and consumed_at is null;
