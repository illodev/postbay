-- Scheduling that follows a person's approval: a piece made for a slot is scheduled at that slot when it is approved, a brand can have
-- approved versions put into its free weekly slots, and the agent can schedule what is approved. Nothing goes out without a person's
-- approval of that very version: each of these only ever schedules a version that is approved, for an account it was approved for
-- (services/scheduling.ts, services/publications.ts).

-- ───────────────────────── a piece made for a slot ─────────────────────────

-- The slot a piece was made for, and which of its weekly occurrences (the instant, in UTC). An agent run started by
-- `slot.needs_content` links the piece it makes; a person can link one too. A slot that is removed leaves `slot_at` behind, and the
-- piece is then made for nothing in particular.
alter table piece
  add column slot_id uuid references slot(id) on delete set null,
  add column slot_at timestamptz;

-- ───────────────────────── what the approver chose ─────────────────────────

-- Whether the approver let the studio schedule this version by itself (at its slot, or in a free slot when the brand fills them), and
-- the text and first comment it goes out with then. Null on approvals older than this: they did not say no.
alter table approval
  add column auto_schedule        boolean,
  add column schedule_text        text,
  add column schedule_first_comment text;

-- ───────────────────────── who scheduled a publication ─────────────────────────

-- A person (`created_by`), the studio filling a free slot ('auto', nobody), or the agent (`created_by_token`), always after a person's
-- approval of the version. `slot_id`: the slot occurrence it fills, so a slot is never filled twice.
alter table publication alter column created_by drop not null;
alter table publication
  add column created_by_token uuid references api_token(id),
  add column scheduled_by text not null default 'person' check (scheduled_by in ('person','auto','agent')),
  add column slot_id uuid references slot(id) on delete set null;
alter table publication add constraint publication_scheduled_by_who check (
  (scheduled_by = 'person' and created_by is not null)
  or (scheduled_by = 'agent' and created_by_token is not null)
  or (scheduled_by = 'auto' and created_by is null and created_by_token is null)
);
create unique index publication_slot_occurrence on publication (slot_id, scheduled_at)
  where slot_id is not null and status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing','published');

-- ───────────────────────── a run that only schedules ─────────────────────────

-- An agent run started by `version.approved` schedules what was approved and ends as 'scheduled'. It is not a round of changes.
alter table agent_run drop constraint agent_run_outcome_check;
alter table agent_run add constraint agent_run_outcome_check check (outcome in
  ('uploaded','needs_people','failed','checks_failed','timeout','aborted','blocked','scheduled'));
