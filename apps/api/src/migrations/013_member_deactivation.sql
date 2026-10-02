-- A member can be deactivated in a brand instead of removed: they keep their place in its history (their comments, approvals and
-- uploads still show their name), but while deactivated they cannot open the brand, are told nothing about it, and the producer tokens
-- they made for it are revoked (and stay revoked when they are reactivated). See services/brand.ts (deactivateMember).
alter table member
  add column deactivated_at timestamptz,
  add column deactivated_by uuid references app_user(id);

-- What the role checks look for on every request: a person's active membership in a brand.
create index member_active_idx on member (brand_id, role) where deactivated_at is null;
