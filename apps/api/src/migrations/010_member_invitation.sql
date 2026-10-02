-- Adding someone who already belongs to another workspace asks them first. An admin of one workspace must not be able to make a
-- stranger (an admin somewhere else, say) a member of their brand without the stranger's consent: membership is what lets a brand's
-- admins act on a person's account (resetting their authenticator, see services/secondfactor.ts). Until they accept, the brand's
-- admins have no say over them. See services/brand.ts (addMember) for who is asked and who is added straight away.
create table member_invitation (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references brand(id),
  user_id     uuid not null references app_user(id) on delete cascade,
  role        text not null check (role in ('admin','approver','reviewer','producer','reader')),
  invited_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  answered_at timestamptz,
  answer      text check (answer in ('accepted','declined','cancelled','expired')),
  check ((answered_at is null) = (answer is null))
);
-- One open invitation per person and brand.
create unique index member_invitation_open on member_invitation (brand_id, user_id) where answered_at is null;
create index member_invitation_user_idx on member_invitation (user_id) where answered_at is null;
