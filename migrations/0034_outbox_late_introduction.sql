-- 0034 — let the outbox carry the notices for a late introduction (15 Oct 2026)
--
-- Master Inbox migration 0078 creates a client's portal entry when a
-- conversation labelled Introduction gets its client after the label. The
-- three introduction notices (team text + Bison, Slack, Follow Up Boss) need
-- that entry and so were never sent for those. The OS now sends them once
-- (src/lib/tools/master-inbox/late-introductions.ts), recording each in
-- side_effect_outbox under the new kind 'late_introduction' — whose unique
-- (workspace_id, kind, subject_id) is what makes it ONCE per conversation.
--
-- Safe to run more than once. Changes no row. One transaction, so the table is
-- never without its check on `kind`. Keeps every kind allowed today.

begin;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.side_effect_outbox'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.side_effect_outbox drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.side_effect_outbox
  add constraint side_effect_outbox_kind_check
  check (kind in ('n8n_introduction', 'slack_introduction', 'fub_push', 'slack_interested', 'late_introduction'));

commit;
