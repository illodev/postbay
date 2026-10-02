-- Using the studio from an AI assistant (Claude Desktop, claude.ai connectors, Claude Code) through a remote MCP server. People never
-- handle keys: an assistant registers itself (OAuth dynamic client registration), the person signs in with their own account and
-- consents, and the assistant gets short-lived tokens that act as that person, with their role in each brand they chose. See
-- services in src/mcp/ and the README ("Using Postbay from Claude").

-- Per brand: whether an assistant may approve or request changes (off unless an admin turns it on). { "allow_approval": bool }
alter table brand add column mcp jsonb not null default '{}';

-- An audited change made through an assistant says so, and which one: { "channel": "mcp", "client_id": …, "client_name": … }.
-- Nullable and without a default, so adding it rewrites no row of the append-only log.
alter table audit_event add column via jsonb;

-- An assistant that registered itself. Public clients (PKCE only) have no secret; a confidential one has its secret stored hashed.
create table mcp_client (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null unique,
  secret_hash      text,
  auth_method      text not null check (auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
  name             text not null,
  client_uri       text,
  redirect_uris    text[] not null check (cardinality(redirect_uris) between 1 and 10),
  software_id      text,
  software_version text,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz
);

-- An authorization request between /authorize and the person's answer on the consent page. Single use, and short-lived.
create table mcp_authorization (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references mcp_client(id) on delete cascade,
  redirect_uri   text not null,
  state          text,
  code_challenge text not null,
  scope          text,
  resource       text not null,
  -- The person who opened the consent page first: nobody else can answer it. The page sends back a nonce made for that person and this
  -- request (an HMAC with the server's secret, so nothing about it is stored).
  user_id        uuid references app_user(id),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  answered_at    timestamptz
);

-- What a person allowed: this assistant, acting as them, in these brands. Revoking it (from the person's page, or by an admin for their
-- brand) ends every token issued under it at once.
create table mcp_grant (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references app_user(id),
  client_id      uuid not null references mcp_client(id),
  brand_ids      uuid[] not null,
  scope          text,
  resource       text not null,
  created_at     timestamptz not null default now(),
  -- When its first tokens were issued: until then it is only a consent, not a connection.
  connected_at   timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid references app_user(id),
  revoked_reason text
);
create index mcp_grant_user_idx on mcp_grant (user_id) where revoked_at is null;
create index mcp_grant_brands_idx on mcp_grant using gin (brand_ids) where revoked_at is null;

-- Authorization codes: hashed, single use, a couple of minutes, bound to the redirect URI and the PKCE challenge.
create table mcp_code (
  code_hash      text primary key,
  grant_id       uuid not null references mcp_grant(id),
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- Access and refresh tokens, hashed. A refresh token is used once (rotation): presenting one again revokes the whole grant.
create table mcp_token (
  token_hash  text primary key,
  grant_id    uuid not null references mcp_grant(id),
  kind        text not null check (kind in ('access', 'refresh')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index mcp_token_grant_idx on mcp_token (grant_id);
