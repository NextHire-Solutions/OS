-- 0033 — let the outbox carry "a lead became Interested" Slack alerts (14 Oct 2026)
--
-- Asked by Amy / Eddy: a Slack channel (#client-interested-updates) that is
-- told whenever a lead is labelled Interested in Master Inbox. The OS posts it
-- (src/lib/tools/master-inbox/interested-alerts.ts) and records each one in
-- side_effect_outbox under the new kind 'slack_interested'.
--
-- That table's UNIQUE (workspace_id, kind, subject_id) is what makes the alert
-- go out ONCE per conversation, whichever app labelled it and however many
-- times. The only change needed is to let the kind exist.
--
-- Safe to run more than once. Changes no row. One transaction, so the table
-- is never without its check on `kind`.

begin;

-- 0001 declared the check inline, so Postgres named it; drop it by what it
-- checks rather than trusting the name.
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
  check (kind in ('n8n_introduction', 'slack_introduction', 'fub_push', 'slack_interested'));

commit;
