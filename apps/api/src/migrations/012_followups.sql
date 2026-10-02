-- Follow-ups to the fix branches: texts kept as codes so each person reads them in their own language, and two notification kinds of
-- their own.

-- Why a publication is on hold or failed, and a note the studio wrote on an agent run, kept also as a code and its values
-- ({ "code": "...", "params": { ... } }, or a list of them) next to the English text, which webhooks and older readers keep using.
-- The API puts the code into words in the reader's language (src/i18n). Rows from before have no code and show their English text.
alter table publication add column hold_reason_i18n jsonb, add column last_error_i18n jsonb;
alter table agent_run add column notes_i18n jsonb;

-- A writer that changes the English text without giving its code (a code path that predates this, or a hand-written update) must not
-- leave the old translation behind: it is dropped, and the English text is what everyone reads.
create function drop_stale_i18n() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'publication' then
    if new.hold_reason is distinct from old.hold_reason and new.hold_reason_i18n is not distinct from old.hold_reason_i18n then
      new.hold_reason_i18n := null;
    end if;
    if new.last_error is distinct from old.last_error and new.last_error_i18n is not distinct from old.last_error_i18n then
      new.last_error_i18n := null;
    end if;
  elsif tg_table_name = 'agent_run' then
    if new.notes is distinct from old.notes and new.notes_i18n is not distinct from old.notes_i18n then
      new.notes_i18n := null;
    end if;
  end if;
  return new;
end $$;
create trigger publication_drop_stale_i18n before update on publication for each row execute function drop_stale_i18n();
create trigger agent_run_drop_stale_i18n before update on agent_run for each row execute function drop_stale_i18n();

-- Two kinds that used to travel as others: a post handed to a person (was publication.failed with handedOver) and an agent run the
-- studio closed for running out of time (was agent.failed). Whoever chose the old kind for Slack, push or email keeps getting these.
update slack_hook set kinds = array_append(kinds, 'publication.handed_over')
  where 'publication.failed' = any(kinds) and not 'publication.handed_over' = any(kinds);
update slack_hook set kinds = array_append(kinds, 'agent.timed_out')
  where 'agent.failed' = any(kinds) and not 'agent.timed_out' = any(kinds);
-- pushOn lists the kinds a person wants pushed (absent: the usual ones); emailOff lists the ones they do not want by email.
update app_user set notify_prefs = jsonb_set(notify_prefs, '{pushOn}', (notify_prefs->'pushOn') || '["publication.handed_over"]'::jsonb)
  where notify_prefs->'pushOn' @> '["publication.failed"]'::jsonb and not notify_prefs->'pushOn' @> '["publication.handed_over"]'::jsonb;
update app_user set notify_prefs = jsonb_set(notify_prefs, '{pushOn}', (notify_prefs->'pushOn') || '["agent.timed_out"]'::jsonb)
  where notify_prefs->'pushOn' @> '["agent.failed"]'::jsonb and not notify_prefs->'pushOn' @> '["agent.timed_out"]'::jsonb;
update app_user set notify_prefs = jsonb_set(notify_prefs, '{emailOff}', (notify_prefs->'emailOff') || '["publication.handed_over"]'::jsonb)
  where notify_prefs->'emailOff' @> '["publication.failed"]'::jsonb and not notify_prefs->'emailOff' @> '["publication.handed_over"]'::jsonb;
update app_user set notify_prefs = jsonb_set(notify_prefs, '{emailOff}', (notify_prefs->'emailOff') || '["agent.timed_out"]'::jsonb)
  where notify_prefs->'emailOff' @> '["agent.failed"]'::jsonb and not notify_prefs->'emailOff' @> '["agent.timed_out"]'::jsonb;

-- Why a prize could not be sent to someone, kept also as a code next to the English reason (prize_delivery.reason), so the list of
-- deliveries says it in the reader's language. Rows from before, and the short reasons that are codes themselves, have none.
alter table prize_delivery add column reason_i18n jsonb;
