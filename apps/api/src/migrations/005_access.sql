-- A second factor for people, single sign-on, and who is told about what.

-- ───────────────────────── second factor ─────────────────────────

-- When the second step of signing in was done in this session. Whether it is needed is decided per request (see services/auth.ts), so a
-- person made an admin an hour ago is asked at once, and a session started before is not trusted for it.
alter table session add column second_factor_at timestamptz;
alter table session add column via text not null default 'link' check (via in ('link','sso','dev'));

-- One authenticator per person. The secret is sealed (see services/secondfactor.ts); until `confirmed_at` is set it is only being enrolled
-- and does not count as a second factor.
create table user_totp (
  user_id       uuid primary key references app_user(id) on delete cascade,
  secret_sealed bytea not null,
  confirmed_at  timestamptz,
  -- The last 30-second step a code was accepted for: a code works once.
  last_step     bigint not null default 0,
  failures      int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now()
);

-- Ten one-time codes for a lost phone. Only their hashes are kept.
create table recovery_code (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id) on delete cascade,
  code_hash  text not null unique,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index recovery_code_user_idx on recovery_code (user_id) where used_at is null;

-- ───────────────────────── single sign-on ─────────────────────────

-- Who an identity provider's account is, once it has signed in: matched by its own stable id from then on, not by an email that may change.
create table user_identity (
  user_id   uuid not null references app_user(id) on delete cascade,
  issuer    text not null,
  subject   text not null,
  email     text not null,
  linked_at timestamptz not null default now(),
  primary key (issuer, subject)
);
create index user_identity_user_idx on user_identity (user_id);

-- A sign-in that was started and has not come back yet. A state works once.
create table sso_attempt (
  state_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
