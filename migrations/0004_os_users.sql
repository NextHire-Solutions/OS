-- ===========================================================================
-- 0004_os_users — let Team access invite people
--
-- WHAT THIS IS FOR
--
-- Who may sign in to the OS comes from the AUTH_USERS environment variable —
-- an allow-list only someone with Railway access can change, and only with a
-- redeploy. The "Invite teammate" button on Team access has been disabled for
-- exactly that reason: there was nowhere to put a new person.
--
-- This table is that place. An admin invites someone by email, the OS mints
-- a temporary password and shows it ONCE to the admin to hand over (nothing
-- is emailed), and the person signs in with it. Their tools come from
-- os_tool_grants (0003), written in the same step.
--
-- AUTH_USERS keeps working unchanged: an address there still signs in with
-- its env hash, and is never shadowed by a row here.
--
-- SAFETY
--
--   · purely additive — one new table, alters nothing
--   · lives in the Master Inbox project beside os_clients and os_tool_grants,
--     and is added to the same allow-list in src/lib/clients/os-tables.ts
--   · RLS on with NO policies: deny-all to anon and authenticated; only the
--     service role (the OS server) reaches it
--   · no live tool reads it
--
-- ROLLBACK
--   drop table if exists public.os_users;
--   -- invited people can no longer sign in; AUTH_USERS people are unaffected.
-- ===========================================================================

create extension if not exists citext;

create table if not exists public.os_users (
  email                 citext      primary key,
  name                  text,
  -- sha256 hex, the same scheme AUTH_USERS uses, so one login path serves both.
  password_hash         text        not null,
  -- true until the person changes the temporary password an admin handed them.
  must_change_password  boolean     not null default true,
  -- false = deactivated: cannot sign in, and their session stops refreshing.
  is_active             boolean     not null default true,
  -- bumped on deactivate / password reset so every live token dies at once.
  token_version         integer     not null default 1,
  created_at            timestamptz not null default now(),
  created_by            text,
  updated_at            timestamptz not null default now()
);

comment on table public.os_users is
  'People invited to BrokerStaffer OS from Team access. Sign-in allow-list alongside AUTH_USERS; tools come from os_tool_grants.';

alter table public.os_users enable row level security;
-- No policies on purpose: deny-all except the service role.
