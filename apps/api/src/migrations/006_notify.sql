-- Phase 5: where notifications go besides the bell and email: Slack, and push to people's browsers.

-- Each channel keeps its own bookkeeping on the notification: when it was done (or skipped, because the person or brand does not use that
-- channel), how many times it has been tried and when to try next. What happened before this migration is history and is not sent.
alter table notification
  add column slack_at timestamptz, add column slack_tries int not null default 0, add column slack_next_at timestamptz,
  add column pushed_at timestamptz, add column push_tries int not null default 0, add column push_next_at timestamptz;
update notification set slack_at = created_at, pushed_at = created_at;
create index notification_slack_idx on notification (created_at) where slack_at is null;
create index notification_push_idx on notification (created_at) where pushed_at is null;

-- Which kinds a person does not want by email, and which they want pushed (null: the usual ones). See services/push.ts.
alter table app_user add column notify_prefs jsonb not null default '{}';

-- One Slack incoming webhook per brand. The address is a secret (anyone who has it can post), so it is sealed; only its end is kept in the clear.
create table slack_hook (
  brand_id        uuid primary key references brand(id),
  url_sealed      bytea not null,
  hint            text not null,
  kinds           text[] not null,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  last_ok_at      timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  -- Set when Slack says the address is gone for good: nothing more is posted until a new one is given.
  disabled_reason text
);

-- A browser that agreed to receive push messages. The endpoint is the push service's address for that browser and is unique.
create table push_subscription (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text
);
create index push_subscription_user_idx on push_subscription (user_id);

-- Secrets the deployment makes for itself (the key that signs push messages), sealed.
create table app_secret (
  name         text primary key,
  value_sealed bytea not null,
  created_at   timestamptz not null default now()
);
