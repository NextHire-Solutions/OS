-- ===========================================================================
-- 0007_os_client_contacts_2_3 — a second and third person to introduce to
--
-- WHAT THIS IS FOR
--
-- 0005 gave every client ONE contact, and the introduction macro names one
-- person: "I'd like to introduce you to Nicole Collins, Team Leader at Oz
-- Group". Clients asked to introduce an agent to two or three people at once
-- — a team leader, a managing broker and an owner, say — with every one of
-- them copied in on the same email.
--
-- So each client gets up to three contacts, each with the same three fields
-- the first one already has. The macro names whoever is filled in, on one
-- line, and the Introduce button copies all of their addresses into Cc.
--
-- WHY COLUMNS AND NOT A CHILD TABLE
--
-- Three is the number the client asked for and the number the sentence reads
-- well at. A child table would buy unlimited contacts at the cost of a join
-- on a path that is already one indexed lookup per composer open, plus
-- ordering rules and an editing UI for rows that do not exist yet. Six
-- nullable columns keep the read a single row and the edit screen a form.
--
-- WHAT IT DOES NOT DO
--
-- It does not touch Master Inbox's own `clients` table, which the live app
-- shares, and it does not change what an existing client's macro says. A
-- client with only the first contact filled in renders exactly the sentence
-- it renders today, byte for byte.
--
-- SAFETY
--
--   · purely additive — six nullable columns, no defaults, no backfill
--   · `os_clients` is RLS deny-all and reachable only by the OS service role
--     through the allow-list in src/lib/clients/os-tables.ts
--   · no live tool reads this table
--
-- ROLLBACK
--   alter table public.os_clients
--     drop column if exists contact2_name,  drop column if exists contact2_role,
--     drop column if exists contact2_email, drop column if exists contact3_name,
--     drop column if exists contact3_role,  drop column if exists contact3_email;
--   -- every macro reverts to naming the single first contact.
-- ===========================================================================

create extension if not exists citext;

alter table public.os_clients
  add column if not exists contact2_name  text,
  add column if not exists contact2_role  text,
  -- citext for the same reason as contact_email: an address is the same
  -- address whatever its case, and these are compared against Cc strings
  -- that come back from mail providers.
  add column if not exists contact2_email citext,
  add column if not exists contact3_name  text,
  add column if not exists contact3_role  text,
  add column if not exists contact3_email citext;

comment on column public.os_clients.contact2_name  is 'Introduction macro: the second person an agent is introduced to.';
comment on column public.os_clients.contact2_role  is 'Introduction macro: that person''s role, e.g. "Managing Broker".';
comment on column public.os_clients.contact2_email is 'Introduction macro: Cc''d by the Introduce button alongside the first contact.';
comment on column public.os_clients.contact3_name  is 'Introduction macro: the third person an agent is introduced to.';
comment on column public.os_clients.contact3_role  is 'Introduction macro: that person''s role, e.g. "Broker and Owner".';
comment on column public.os_clients.contact3_email is 'Introduction macro: Cc''d by the Introduce button alongside the other contacts.';
