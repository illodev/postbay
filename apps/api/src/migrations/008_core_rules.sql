-- Fixes from a review of the core rules: what a paused brand, a cancelled post, a crashed worker or a producer token can and
-- cannot do. Each column says which rule it serves.

-- ───────────────────────── append-only, also against TRUNCATE ─────────────────────────

-- 001 guarded only the audit log against TRUNCATE; the rest of what the README calls append-only is guarded here too.
create trigger version_no_truncate before truncate on version
  for each statement execute function append_only();
create trigger asset_no_truncate before truncate on asset
  for each statement execute function append_only();
create trigger approval_no_truncate before truncate on approval
  for each statement execute function append_only();
create trigger publication_attempt_no_truncate before truncate on publication_attempt
  for each statement execute function append_only();

-- ───────────────────────── publications ─────────────────────────

alter table publication
  -- The network holds something for this publication that has not gone out yet (a held Facebook post, an uploaded YouTube video, a
  -- Facebook video still processing). Whatever stops the publication (cancel, hold, failure, pause) has it taken down. Wider than
  -- native_scheduled, which only becomes true once preparation has finished.
  add column held_on_network     boolean not null default false,
  -- Fencing for the worker's lease: every write a worker makes names the lease it took, so a worker that lost its lease writes nothing.
  add column lease_token         uuid,
  -- The connector recorded progress while publishing (an id, or that a call was about to be made): from then on the network may have
  -- the post, so the publication is finished through the connector's own recovery, never started again from nothing.
  add column publish_progress_at timestamptz,
  -- Set while the publisher holds it back because the brand is paused or its date is blocked.
  add column frozen_at           timestamptz,
  -- What goes to the network besides the files: the title and the AI label as they were when the version was approved, not as they
  -- are now. The AI label can still be added later (it goes out if either says so), never taken away.
  add column title               text,
  add column ai_generated        boolean;

update publication set held_on_network = native_scheduled or (status in ('preparing', 'ready') and handle <> '{}'::jsonb);
update publication pub set title = p.title, ai_generated = p.ai_generated
  from variant v join piece p on p.id = v.piece_id where v.id = pub.variant_id;

create index publication_depends_on_idx on publication (depends_on) where depends_on is not null;

-- ───────────────────────── approvals ─────────────────────────

-- The title and the AI label the approver saw. Older approvals have none, and the piece's own values stand in for them.
alter table approval
  add column piece_title  text,
  add column ai_generated boolean;

-- ───────────────────────── agent runs ─────────────────────────

alter table agent_run
  -- What the run was allowed to spend when it started. Counted against the budgets while it runs, so runs at the same time share
  -- what is left instead of each being told all of it.
  add column reserved    numeric(12,4) not null default 0,
  -- The longest the run may last (its start plus the brand's longest run, plus a few minutes to upload and reply). Heartbeats do not
  -- move the lease past it.
  add column deadline_at timestamptz,
  -- When the row was written, by the database's clock: what a piece's creation time is compared with.
  add column opened_at   timestamptz not null default now();

create index agent_run_token_running_idx on agent_run (token_id) where status = 'running';
create index agent_run_running_idx on agent_run (lease_until) where status = 'running';
