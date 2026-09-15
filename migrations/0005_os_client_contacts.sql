-- ===========================================================================
-- 0005_os_client_contacts — the person an introduction is addressed to
--
-- WHAT THIS IS FOR
--
-- The introduction macro names the client's contact: "I'd like to introduce
-- you to <full name>, <role> at <brokerage>". Those three values were only
-- ever captured in the Onboard dialog, passed straight to Master Inbox, and
-- baked into that client's reply template as literal text. Nothing stored
-- them, so they could not be corrected afterwards, and a client onboarded
-- without the macro ticked had none at all.
--
-- The fourth column is new work rather than a repair: the contact's email,
-- so the Introduce button in the composer can put them in Cc.
--
-- WHAT IT DOES NOT DO
--
-- It does not touch Master Inbox's own `clients` table, which the live app
-- shares. These four columns live on `os_clients`, which only the OS reads.
--
-- SAFETY
--
--   · purely additive — four nullable columns, no defaults, no backfill
--   · `os_clients` is already RLS deny-all and reachable only by the OS
--     service role through the allow-list in src/lib/clients/os-tables.ts
--   · no live tool reads this table
--
-- ROLLBACK
--   alter table public.os_clients
--     drop column if exists contact_name,
--     drop column if exists contact_role,
--     drop column if exists contact_email,
--     drop column if exists brokerage;
--   -- the Introduce button then reports "no introduction details", and
--   -- onboarding behaves exactly as it did before.
-- ===========================================================================

create extension if not exists citext;

alter table public.os_clients
  -- "Nicole Collins" — who the agent is being introduced to.
  add column if not exists contact_name  text,
  -- "Team Leader" — their role, as it reads in the introduction.
  add column if not exists contact_role  text,
  -- citext: an address is the same address whatever its case, and this one is
  -- compared against Cc strings that come back from mail providers.
  add column if not exists contact_email citext,
  -- The brokerage named in the introduction and in the sign-off. Falls back to
  -- the client's own name when it is left empty.
  add column if not exists brokerage     text;

comment on column public.os_clients.contact_name  is 'Introduction macro: the person an agent is introduced to.';
comment on column public.os_clients.contact_role  is 'Introduction macro: that person''s role, e.g. "Team Leader".';
comment on column public.os_clients.contact_email is 'Introduction macro: Cc''d by the Introduce button in the reply composer.';
comment on column public.os_clients.brokerage     is 'Introduction macro: the brokerage named in the body and the sign-off.';
