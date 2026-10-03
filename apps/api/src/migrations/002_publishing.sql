-- Connected accounts, the publishing pipeline, an attempt log and transcoded renditions.

-- ───────────────────────── connected accounts ─────────────────────────

alter table social_account
  add column provider_data  jsonb not null default '{}',   -- ids and flags the connector needs (page id, channel id, audit state…)
  add column connected_by   uuid references app_user(id),
  add column connected_at   timestamptz,
  add column last_error     text,
  add column last_health_at timestamptz;

-- A connection in progress. One sign-in with a network can discover several accounts (a Facebook login yields Pages and
-- the Instagram accounts linked to them), so the person picks which ones to connect. Tokens wait here, encrypted,
-- until then; the browser only ever carries the id of this row.
create table oauth_pending (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references brand(id),
  user_id           uuid not null references app_user(id),
  provider          text not null check (provider in ('meta','google')),
  state_hash        text not null unique,                    -- hash of the state parameter that comes back on the callback
  reconnect_of      uuid references social_account(id),      -- set when this connection is meant to replace a broken one
  candidates        jsonb not null default '[]',             -- safe to show: key, network, id, name
  secrets_encrypted bytea,                                   -- tokens per candidate, sealed with the token key
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  completed_at      timestamptz
);

-- ───────────────────────── the publishing pipeline ─────────────────────────

alter table publication drop constraint publication_status_check;
alter table publication add constraint publication_status_check check (status in
  ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing','published','failed','cancelled'));

alter table publication
  add column placement        text,                           -- reel, feed_image, story, video…: what the connector is asked to make
  add column prepare_at       timestamptz,                    -- when preparation starts (the brand's lead before scheduled_at)
  add column next_run_at      timestamptz,                    -- when the worker should look at this publication next
  add column lease_until      timestamptz,                    -- a worker holds this publication until then
  add column handle           jsonb not null default '{}',    -- what the connector has done so far, so a step can resume
  add column native_scheduled boolean not null default false, -- the network itself will publish at the scheduled time
  add column visibility       text check (visibility in ('public','private','processing','scheduled','unknown')),
  add column verify_attempts  int not null default 0,
  add column last_error_class text,
  add column last_error       text,
  add column failed_at        timestamptz;

drop index publication_slot_key;
create unique index publication_slot_key on publication (variant_id, social_account_id, scheduled_at)
  where status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing');

-- What the worker scans: automatic publications that still have something to do.
create index publication_work_idx on publication (next_run_at)
  where manual = false and status in ('scheduled','preparing','ready','publishing','published');

-- Every try of every step, with what the network answered (tokens removed). Only ever added to.
create table publication_attempt (
  id             bigserial primary key,
  publication_id uuid not null references publication(id),
  step           text not null check (step in ('prepare','publish','verify','discard')),
  attempt        int  not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  outcome        text not null check (outcome in ('ok','pending','error')),
  error_class    text check (error_class in ('auth','rate_limit','file_rejected','transient','unsupported','missed_window','unknown')),
  http_status    int,
  detail         jsonb not null default '{}'
);
create index publication_attempt_pub_idx on publication_attempt (publication_id, id);
create trigger publication_attempt_append_only before update or delete on publication_attempt
  for each row execute function append_only();

-- Per-brand publishing settings.
alter table brand
  add column publishing jsonb not null default '{"prepare_lead_minutes":30,"late_tolerance_minutes":15}';

-- ───────────────────────── media ─────────────────────────

-- What ffprobe found out about a file (codecs, container, bitrate), so a network's profile can be checked without reading it again.
alter table asset add column meta jsonb not null default '{}';

-- A copy of an asset made to fit one network's profile. Assets that already fit are published as they are and have no row.
create table rendition (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references asset(id),
  profile     text not null,
  storage_key text not null,
  mime        text not null,
  bytes       bigint not null,
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width       int,
  height      int,
  duration_ms int,
  created_at  timestamptz not null default now(),
  unique (asset_id, profile)
);
