-- The other networks, what came of each post (metrics), and prizes for commenting.

-- ───────────────────────── more ways to sign in ─────────────────────────

alter table oauth_pending drop constraint oauth_pending_provider_check;
alter table oauth_pending add constraint oauth_pending_provider_check check (provider in
  ('meta','google','threads','tiktok','linkedin','x','pinterest','bluesky'));

-- ───────────────────────── metrics ─────────────────────────

-- One reading of one post's numbers at a set age. A published post gets its rows at once (see services/metrics.ts); the worker
-- takes each reading when it falls due. Stories get theirs early, because their numbers disappear after a day.
create table metric_snapshot (
  id              bigserial primary key,
  publication_id  uuid not null references publication(id) on delete cascade,
  age             text not null check (age in ('1h','6h','22h','1d','7d','28d')),
  due_at          timestamptz not null,
  -- pending: still to read. ok: read. unavailable: the network has nothing to give for this post. failed: gave up after retries.
  -- expired: the window to read it closed before it could be (a story's day).
  status          text not null default 'pending' check (status in ('pending','ok','unavailable','failed','expired')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null,
  lease_until     timestamptz,
  taken_at        timestamptz,
  metrics         jsonb not null default '{}',     -- the common set (views, reach, likes, comments, shares, saves, avgWatchSeconds)
  raw             jsonb,                           -- the network's whole answer, tokens removed
  note            text,
  unique (publication_id, age)
);
create index metric_snapshot_due_idx on metric_snapshot (next_attempt_at) where status = 'pending';

-- ───────────────────────── prizes for commenting ─────────────────────────

-- Per-brand prize settings. `enabled` decides whether signing in with Meta asks for the permission to send messages; `retention_days`
-- is how long the data prizes collect about people who are not users of the app is kept.
alter table brand
  add column prizes jsonb not null default '{"enabled":false,"retention_days":30}';

-- What is handed out: a file kept here, or a link somewhere else.
create table prize (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references brand(id),
  name         text not null check (length(name) between 1 and 120),
  kind         text not null check (kind in ('file','link')),
  file_key     text,
  file_name    text,
  file_mime    text,
  file_bytes   bigint,
  file_sha256  text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  url          text,
  uploaded_at  timestamptz,                         -- a file prize is usable once its bytes have arrived
  archived_at  timestamptz,
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check ((kind = 'file' and file_key is not null) or (kind = 'link' and url is not null))
);
create index prize_brand_idx on prize (brand_id);

-- The rule a post carries: whoever comments the keyword gets the prize, by private message.
create table prize_rule (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references brand(id),
  publication_id    uuid not null unique references publication(id) on delete cascade,
  prize_id          uuid not null references prize(id),
  keyword           text not null check (length(keyword) between 1 and 60),
  keyword_norm      text not null,                  -- lower case, without accents or marks: what comments are compared with
  message           text not null check (length(message) between 1 and 900),
  link_hours        int  not null default 72 check (link_hours between 1 and 720),
  -- The post's own text tells people the reply is automatic and what is done with their data. A person confirms it is so;
  -- a rule cannot run without it.
  notice_confirmed  boolean not null default false,
  active            boolean not null default false,
  -- A public page for the prize that anyone with the link can open: for the networks where nothing can be sent privately
  -- (a pinned comment on YouTube points at it).
  public_token      text unique,
  public_expires_at timestamptz,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- A person who commented the keyword. These rows hold personal data (the network's id for the person, their name) and are
-- deleted once purge_after passes, which is why a prize is not sent after the same window.
create table prize_delivery (
  id              uuid primary key default gen_random_uuid(),
  rule_id         uuid not null references prize_rule(id) on delete cascade,
  prize_id        uuid not null references prize(id),
  brand_id        uuid not null references brand(id),
  publication_id  uuid not null references publication(id) on delete cascade,
  account_id      uuid not null references social_account(id),
  network         text not null,
  comment_id      text not null,
  person_id       text not null,
  person_name     text not null default '',
  comment_at      timestamptz not null,
  status          text not null default 'pending' check (status in ('pending','sent','skipped','failed')),
  reason          text,                              -- why it was skipped or failed
  attempts        int not null default 0,
  next_attempt_at timestamptz,
  lease_until     timestamptz,
  token_hash      text unique,                       -- the download link sent to the person, hashed
  expires_at      timestamptz,
  downloads       int not null default 0,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  purge_after     timestamptz not null,
  unique (rule_id, comment_id)
);
-- The same prize is never sent twice to the same person, whichever post they commented on.
create unique index prize_delivery_once on prize_delivery (prize_id, person_id) where status in ('pending','sent');
create index prize_delivery_due_idx on prize_delivery (next_attempt_at) where status = 'pending';
create index prize_delivery_purge_idx on prize_delivery (purge_after);
create index prize_delivery_account_idx on prize_delivery (account_id, sent_at) where status = 'sent';

-- Where reading a post's comments got to, for the networks that have to be asked.
create table prize_poll (
  publication_id uuid primary key references publication(id) on delete cascade,
  last_polled_at timestamptz,
  last_comment_at timestamptz,
  lease_until    timestamptz
);

-- A person asking the network to have their data deleted (Meta calls an address of ours when someone removes the app).
create table deletion_request (
  code         text primary key,
  network      text not null,
  person_id    text not null,
  requested_at timestamptz not null default now(),
  rows_deleted int not null default 0
);
