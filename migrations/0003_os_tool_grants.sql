-- ===========================================================================
-- 0003_os_tool_grants — make Team access actually grant access
--
-- WHAT THIS IS FOR
--
-- Tool grants live in the BS_GRANTS environment variable today. That makes the
-- Team access screen a config generator rather than an admin screen: you move
-- the switches, it prints a string, and you paste that into Railway and
-- redeploy. Nobody can grant a colleague a tool without deploy access.
--
-- This table is the "Postgres store" src/lib/identity/store.ts was written
-- against from the start. Once it exists, the switches save directly and the
-- 30-minute session refresh picks the change up on its own.
--
-- WHAT IT DOES NOT DO
--
-- It does not hold users or passwords. Those stay in AUTH_USERS, which is the
-- allow-list of who may sign in at all. This table only answers "which tools
-- does an address that CAN sign in get to see".
--
-- SAFETY
--
--   · purely additive — creates one new table, alters nothing
--   · lives in the Master Inbox project alongside os_clients, and is added to
--     the same table allow-list in src/lib/clients/os-tables.ts, so the service
--     role client cannot be pointed at any of Master Inbox's own tables
--   · RLS on with NO policies: deny-all to anon and authenticated. Only the
--     service role reaches it, which is the workspace server and nothing else
--   · no live tool reads it, so deployed apps are unaffected
--
-- ROLLBACK
--   drop table if exists public.os_tool_grants;
--   -- grants then fall back to BS_GRANTS exactly as before.
-- ===========================================================================

create extension if not exists citext;

create table if not exists public.os_tool_grants (
  -- citext so Admin@x.com and admin@x.com are one person, which is how every
  -- sign-in path already compares addresses.
  email       citext primary key,
  -- 'inbox' | 'clients' | 'analytics' | 'search' | 'onboarding'.
  -- An empty array is meaningful: it means "signed in, no tools" — distinct
  -- from having no row, which means "not governed, fall back to BS_GRANTS".
  tools       text[]      not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.os_tool_grants is
  'Per-user tool access for BrokerStaffer OS. Written by the Team access screen; read when a session token is issued or refreshed. Absence of a row means "not governed here".';

alter table public.os_tool_grants enable row level security;
-- No policies on purpose: deny-all except the service role.
