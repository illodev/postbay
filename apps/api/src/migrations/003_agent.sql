-- The loop with whoever produces. Domain events, signed webhooks with retried deliveries, the ledger of agent
-- runs (rounds, budgets, the per-piece lock) and the things a person can mark so the agent leaves them alone.

-- ───────────────────────── events (the outbox) ─────────────────────────

-- Written in the same transaction as the change they describe, so an event exists exactly when its change does. What
-- needs a fresh value at delivery time (a signed URL for a frame) is not stored here, only the key to make it from.
create table event (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid not null references brand(id),
  type       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create index event_brand_idx on event (brand_id, created_at desc);
create trigger event_immutable before update on event
  for each row execute function append_only();

-- ───────────────────────── webhooks ─────────────────────────

create table webhook (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references brand(id),
  url              text not null,
  description      text not null default '',
  events           text[] not null check (cardinality(events) > 0),
  secret_encrypted bytea not null,                  -- sealed with TOKEN_KEY; the secret itself is shown once
  secret_hint      text not null,                   -- its last characters, to tell secrets apart
  active           boolean not null default true,
  disabled_reason  text,
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  failing_notified_at timestamptz
);
create index webhook_brand_idx on webhook (brand_id);

-- One delivery of one event to one webhook. Retried with growing waits until it succeeds or 24 hours have passed.
create table webhook_delivery (
  id              uuid primary key default gen_random_uuid(),
  webhook_id      uuid not null references webhook(id) on delete cascade,
  event_id        uuid not null references event(id),
  status          text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz,
  lease_until     timestamptz,
  expires_at      timestamptz not null,
  last_status     int,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (webhook_id, event_id)
);
create index webhook_delivery_due_idx on webhook_delivery (next_attempt_at) where status = 'pending';
create index webhook_delivery_webhook_idx on webhook_delivery (webhook_id, created_at desc);

-- Every try, with what the receiver answered.
create table webhook_attempt (
  id          bigserial primary key,
  delivery_id uuid not null references webhook_delivery(id) on delete cascade,
  at          timestamptz not null default now(),
  http_status int,
  error       text,
  duration_ms int
);
create index webhook_attempt_delivery_idx on webhook_attempt (delivery_id, id);

-- ───────────────────────── the agent ─────────────────────────

-- Limits for the agent, per brand. Rounds are counted per piece; the budgets are in whatever unit the runner reports its
-- cost in (the currency is only a label). A budget left empty means the agent is not allowed to start: spending is a
-- decision someone makes, not a default.
alter table brand add column agent jsonb not null default
  '{"max_rounds":3,"max_cost_per_piece":null,"max_cost_per_month":null,"max_run_minutes":30,"slot_alert_days":3,"currency":"USD"}';

-- A reviewer can mark a comment as for people only: something the agent must leave alone.
alter table comment add column people_only boolean not null default false;

-- Rounds counted since here: a person who takes a piece over and then wants the agent back resets it.
alter table piece add column agent_reset_at timestamptz;

-- Every run an agent starts, and every start that was refused. This is the ledger the safeguards read.
create table agent_run (
  id               uuid primary key default gen_random_uuid(),
  seq              bigserial not null,                  -- order of arrival, for runs that start in the same instant
  brand_id         uuid not null references brand(id),
  piece_id         uuid references piece(id),         -- empty for a run that creates a new piece
  token_id         uuid not null references api_token(id),
  trigger          text not null,                       -- the event type that started it
  trigger_event_id uuid,                                -- the event it handled, as the runner names it (events are purged after a while, so no foreign key)
  status           text not null default 'running' check (status in ('running','finished')),
  outcome          text check (outcome in ('uploaded','needs_people','failed','checks_failed','timeout','aborted','blocked')),
  blocked_reason   text,
  started_at       timestamptz not null default now(),
  lease_until      timestamptz,                         -- the runner keeps this ahead while it works; if it stops, the run is closed
  finished_at      timestamptz,
  cost             numeric(12,4) not null default 0,
  notes            text not null default '',
  version_id       uuid references version(id),
  detail           jsonb not null default '{}'
);
create index agent_run_piece_idx on agent_run (piece_id, started_at desc);
create index agent_run_brand_idx on agent_run (brand_id, started_at desc);
-- The lock: one agent per piece at a time, enforced by the database.
create unique index agent_run_one_running on agent_run (piece_id) where status = 'running' and piece_id is not null;
-- A refused start is recorded once per event, however many times the runner asks.
create unique index agent_run_one_block on agent_run (piece_id, trigger_event_id) where outcome = 'blocked' and trigger_event_id is not null;

-- ───────────────────────── slots that asked for content ─────────────────────────

-- One alert per empty slot occurrence, however often the scan runs.
create table slot_alert (
  slot_id    uuid not null references slot(id) on delete cascade,
  at         timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (slot_id, at)
);
