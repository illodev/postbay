-- Review, approval, calendar and assisted publishing.
-- Everything hangs off workspace → brand → social account. Nothing crosses from one workspace to another.

create table workspace (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  plan       text not null default 'self_hosted',
  created_at timestamptz not null default now()
);

create table brand (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspace(id),
  name           text not null,
  timezone       text not null,                 -- IANA zone, e.g. Europe/Madrid
  locale         text not null default 'es',
  -- required_approvals: distinct approvals needed (1 by default)
  -- reapprove_on_move: moving an already approved date requires another confirmation (off by default)
  -- checklist: items the approver ticks before approving
  approval_rules jsonb not null default '{"required_approvals":1,"reapprove_on_move":false,"checklist":[]}',
  paused         boolean not null default false,
  paused_at      timestamptz,
  created_at     timestamptz not null default now()
);

create table app_user (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  name       text,
  created_at timestamptz not null default now()
);
create unique index app_user_email_key on app_user (lower(email));

create table member (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id),
  brand_id   uuid not null references brand(id),
  role       text not null check (role in ('admin','approver','reviewer','producer','reader')),
  created_at timestamptz not null default now(),
  unique (user_id, brand_id)
);

create table session (
  token_hash text primary key,
  user_id    uuid not null references app_user(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table login_token (
  token_hash text primary key,
  email      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Producer token: only the hash is stored, it is shown once, it expires and it is valid for one brand.
create table api_token (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brand(id),
  name         text not null,
  token_hash   text not null unique,
  role         text not null default 'producer' check (role = 'producer'),
  created_by   uuid not null references app_user(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz
);

create table social_account (
  id                  uuid primary key default gen_random_uuid(),
  brand_id            uuid not null references brand(id),
  network             text not null check (network in
    ('instagram','facebook','youtube','tiktok','linkedin','x','threads','pinterest','bluesky')),
  external_id         text not null,
  display_name        text not null,
  granted_permissions jsonb not null default '[]',
  -- The account's token, encrypted with AES-256-GCM. A manual account holds no token.
  token_encrypted     bytea,
  token_expires_at    timestamptz,
  status              text not null default 'manual' check (status in ('active','reconnect_required','manual')),
  created_at          timestamptz not null default now(),
  unique (brand_id, network, external_id)
);

create table campaign (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid not null references brand(id),
  name       text not null,
  starts_on  date,
  ends_on    date,
  objective  text,
  created_at timestamptz not null default now()
);

create table piece (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references brand(id),
  campaign_id      uuid references campaign(id),
  title            text not null,
  kind             text not null check (kind in ('video','carousel','post','story','pdf')),
  brief            text not null default '',
  review_state     text not null default 'draft'
                   check (review_state in ('draft','in_review','changes_requested','approved','discarded')),
  target_date      date,
  ai_generated     boolean not null default false,
  created_by_user  uuid references app_user(id),
  created_by_token uuid references api_token(id),
  created_at       timestamptz not null default now(),
  discarded_at     timestamptz,
  check ((created_by_user is null) <> (created_by_token is null))
);
create index piece_brand_idx on piece (brand_id, created_at desc);

create table variant (
  id         uuid primary key default gen_random_uuid(),
  piece_id   uuid not null references piece(id),
  format     text not null check (format in ('9:16','4:5','1:1','16:9','carousel','document')),
  style      text not null default '',
  created_at timestamptz not null default now(),
  unique (piece_id, format, style)
);

create table version (
  id             uuid primary key default gen_random_uuid(),
  variant_id     uuid not null references variant(id),
  number         int  not null,
  author_user_id  uuid references app_user(id),
  author_token_id uuid references api_token(id),
  notes          text not null default '',
  -- sha256 of the set of files (see domain/fingerprint.ts)
  fingerprint    text not null,
  review_state   text not null default 'in_review'
                 check (review_state in ('in_review','changes_requested','approved','superseded','discarded')),
  created_at     timestamptz not null default now(),
  unique (variant_id, number),
  check ((author_user_id is null) <> (author_token_id is null))
);

create table asset (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references version(id),
  kind        text not null check (kind in ('video','image','pdf','subtitles','cover')),
  position    int  not null default 0,
  storage_key text not null,
  name        text not null,
  mime        text not null,
  width       int,
  height      int,
  duration_ms int,
  fps         numeric(7,3),
  bytes       bigint not null,
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  unique (version_id, kind, position)
);

-- Pending upload: the producer declares the file and its hash, the app signs a URL,
-- and when the version is closed it checks that what was uploaded matches what was declared.
create table upload (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references brand(id),
  variant_id       uuid not null references variant(id),
  created_by_user  uuid references app_user(id),
  created_by_token uuid references api_token(id),
  storage_key      text not null unique,
  name             text not null,
  mime             text not null,
  bytes            bigint not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz
);

create table comment (
  id                     uuid primary key default gen_random_uuid(),
  version_id             uuid not null references version(id),
  parent_id              uuid references comment(id),
  author_user_id         uuid references app_user(id),
  author_token_id        uuid references api_token(id),
  body                   text not null,
  -- {"type":"time","t":12.4,"t_end":15} | {"type":"region","page":1,"x":.1,"y":.2,"w":.3,"h":.1} | null
  anchor                 jsonb,
  frame_key              text,
  reply_kind             text check (reply_kind in ('fixed','cannot_do','needs_human')),
  status                 text not null default 'open' check (status in ('open','resolved')),
  resolved_in_version_id uuid references version(id),
  resolved_by_user_id    uuid references app_user(id),
  resolved_at            timestamptz,
  created_at             timestamptz not null default now(),
  check ((author_user_id is null) <> (author_token_id is null)),
  check (parent_id is null or anchor is null)
);
create index comment_version_idx on comment (version_id, created_at);

create table approval (
  id                   uuid primary key default gen_random_uuid(),
  version_id           uuid not null references version(id),
  approver_user_id     uuid not null references app_user(id),
  decision             text not null check (decision in ('approve','reject')),
  account_ids          uuid[] not null default '{}',
  -- Approved fingerprint: if the version's fingerprint changes, the approval stops counting.
  approved_fingerprint text not null,
  checklist            jsonb not null default '{}',
  note                 text not null default '',
  created_at           timestamptz not null default now(),
  unique (version_id, approver_user_id)
);

create table publication (
  id                 uuid primary key default gen_random_uuid(),
  variant_id         uuid not null references variant(id),
  social_account_id  uuid not null references social_account(id),
  version_id         uuid not null references version(id),
  text               text not null default '',
  first_comment      text not null default '',
  options            jsonb not null default '{}',
  scheduled_at       timestamptz not null,
  status             text not null default 'scheduled'
                     check (status in ('scheduled','awaiting_reapproval','on_hold','published','cancelled','failed')),
  manual             boolean not null default true,   -- published by hand by a person
  external_id        text,
  url                text,
  error              text,
  attempts           int not null default 0,
  depends_on         uuid references publication(id),
  hold_reason        text,
  due_notified_at    timestamptz,
  published_at       timestamptz,
  published_by       uuid references app_user(id),
  created_by         uuid not null references app_user(id),
  moved_by           uuid references app_user(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- One publication per account and date.
create unique index publication_slot_key on publication (variant_id, social_account_id, scheduled_at)
  where status in ('scheduled','awaiting_reapproval','on_hold');
create index publication_due_idx on publication (scheduled_at) where status = 'scheduled';

-- Fixed slots per account: "Reels, Tuesday and Thursday at 19:00" (brand local time).
create table slot (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references brand(id),
  social_account_id uuid not null references social_account(id),
  weekday           smallint not null check (weekday between 1 and 7),   -- ISO: 1 = Monday
  local_time        time not null,
  label             text not null default '',
  active            boolean not null default true
);

create table blocked_date (
  brand_id uuid not null references brand(id),
  day      date not null,
  reason   text not null default '',
  primary key (brand_id, day)
);

create table audit_event (
  id              bigserial primary key,
  brand_id        uuid references brand(id),
  actor_user_id   uuid references app_user(id),
  actor_token_id  uuid references api_token(id),
  action          text not null,
  entity          text not null,
  entity_id       uuid,
  before          jsonb,
  after           jsonb,
  at              timestamptz not null default now()
);
create index audit_brand_idx on audit_event (brand_id, id desc);
create index audit_entity_idx on audit_event (entity, entity_id);

create table notification (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id),
  brand_id   uuid not null references brand(id),
  kind       text not null,
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index notification_user_idx on notification (user_id, created_at desc);
create index notification_unsent_idx on notification (created_at) where emailed_at is null;

-- ───────────────────────── Guarantees enforced in the database ─────────────────────────
-- These rules hold even if someone bypasses the API.

-- A version is immutable: only its review state may change.
create function version_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a version cannot be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.variant_id, new.number, new.author_user_id, new.author_token_id, new.notes, new.fingerprint, new.created_at)
     is distinct from
     (old.id, old.variant_id, old.number, old.author_user_id, old.author_token_id, old.notes, old.fingerprint, old.created_at) then
    raise exception 'a version is immutable: only its review state may change' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger version_immutable before update or delete on version
  for each row execute function version_immutable();

-- A version's files, approvals and the audit log are append-only.
create function append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end $$;
create trigger asset_append_only before update or delete on asset
  for each row execute function append_only();
create trigger approval_append_only before update or delete on approval
  for each row execute function append_only();
create trigger audit_append_only before update or delete on audit_event
  for each row execute function append_only();
create trigger audit_no_truncate before truncate on audit_event
  for each statement execute function append_only();
