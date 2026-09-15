-- ===========================================================================
-- The one client list, and the record of onboarding a client into each tool.
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (dukbececdyowowwyktys)
-- SQL editor → paste → run. It is safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- WHY HERE, AND NOT IN A NEW PROJECT
--
-- Four tools keep four client lists in four separate Supabase projects and no
-- two agree: Master Inbox 58 rows, Analytics 50, Client Health 48, Onboarding
-- 39, against a business roster of 36. Nothing reconciles them except a
-- hand-maintained list in code, which means adding a client needs a deploy.
--
-- Identity lands in the Master Inbox project because that project holds
-- `clients.portal_token` — the address of a live client portal, 47 of which
-- are in customers' hands. Anything else would mean mapping identity back onto
-- that table to serve a portal, and a mapping that can be wrong is a portal
-- that can 404.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE TO ADD TO A LIVE DATABASE
--
-- Purely additive: two new tables, their own indexes, their own RLS. Nothing
-- existing is altered — no column changes type, no trigger is touched, no
-- policy on any existing table is modified. In particular `public.clients` is
-- NOT changed, so every portal token, portal URL and feature flag stays byte
-- for byte what it is today.
--
-- The running Master Inbox app does not know these tables exist and cannot be
-- affected by them. If the workspace stopped using them tomorrow the only
-- consequence would be rows nobody reads.
--
-- ---------------------------------------------------------------------------
-- NOTHING IS EVER DELETED
--
-- There is no delete path for a client anywhere in this design. A client that
-- stops trading is marked `churned` and can be marked `active` again later —
-- `status` is a mutable field, not a tombstone. That is a deliberate business
-- rule: history and portal tokens have to survive, and "we removed the row" is
-- not a recoverable state.
-- ===========================================================================

create table if not exists public.os_clients (
  id uuid primary key default gen_random_uuid(),

  -- The name the business uses. `slug` is derived with Master Inbox's own
  -- rule so a client minted here and a client minted there agree.
  name text not null,
  slug text not null,
  -- Spellings a TOOL uses, so its rows can be matched back to this one.
  -- Not trading names: a guessed alias silently merges two clients.
  aliases text[] not null default '{}'::text[],

  -- active | paused | churned | prospect. Changeable at any time, in both
  -- directions. See the note above: this is the ONLY way a client leaves the
  -- working list.
  status text not null default 'active'
    check (status in ('active', 'paused', 'churned', 'prospect')),

  -- Where this client's row lives in each tool. Null means "not created
  -- there yet", which is exactly the gap the Clients page is meant to show.
  -- Deliberately untyped beyond text for the three foreign systems: their ids
  -- are uuids today but they are another project's keys, not ours to constrain.
  mi_client_id   uuid,   -- Master Inbox  public.clients.id  (this project)
  ch_client_id   text,   -- Client Health clients.id
  an_client_id   text,   -- Analytics     clients.id
  orch_client_id text,   -- Onboarding    orch_clients.id

  -- How this client got here: seeded from the code roster, onboarded in the
  -- OS, or adopted from a client the Onboarding tool created.
  source text not null default 'roster'
    check (source in ('roster', 'os', 'onboarding')),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per client, whichever way you spell it. `lower(name)` rather than a
-- plain unique so "BHGRE Base Camp" and "BHGRE base camp" cannot both exist —
-- case-different duplicates are how the other four lists drifted apart.
create unique index if not exists os_clients_name_ci on public.os_clients (lower(name));
create unique index if not exists os_clients_slug_uniq on public.os_clients (slug);

-- Reverse lookups from a tool's row back to the canonical client. Partial, so
-- the many nulls during rollout cost nothing and do not collide.
create unique index if not exists os_clients_mi   on public.os_clients (mi_client_id)   where mi_client_id   is not null;
create unique index if not exists os_clients_ch   on public.os_clients (ch_client_id)   where ch_client_id   is not null;
create unique index if not exists os_clients_an   on public.os_clients (an_client_id)   where an_client_id   is not null;
create unique index if not exists os_clients_orch on public.os_clients (orch_client_id) where orch_client_id is not null;

alter table public.os_clients enable row level security;

comment on table public.os_clients is
  'The BrokerStaffer OS canonical client list. Written and read only by the OS '
  'workspace; the Master Inbox app does not read this table. Clients are never '
  'deleted — status moves between active/paused/churned/prospect.';


-- ---------------------------------------------------------------------------
-- Onboarding a client is a JOB, not a request.
--
-- Creating a client means four writes across four separate databases, and no
-- transaction spans them. A create that succeeds in three and fails in the
-- fourth leaves a client half-made, so each leg is recorded before it is
-- attempted: a failed leg can be retried on its own, and a succeeded leg is
-- never repeated.
--
-- The order the legs run in is cheapest-to-undo-first, and Master Inbox is
-- deliberately LAST, because its insert mints a live, login-free portal token.
-- If an earlier leg fails, no wrong URL has reached anyone.
-- ---------------------------------------------------------------------------
create table if not exists public.os_client_onboarding (
  id uuid primary key default gen_random_uuid(),
  os_client_id uuid not null references public.os_clients (id) on delete cascade,

  leg text not null
    check (leg in ('analytics', 'client_health', 'onboarding', 'master_inbox')),

  -- `skipped` is a real outcome, not a failure: a client that already exists
  -- in a tool must not be created there twice.
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),

  attempts int not null default 0,
  -- The exact body we sent and got back. This is what makes a retry reviewable
  -- rather than a guess, and what proves afterwards what a tool was told.
  request jsonb not null default '{}'::jsonb,
  response jsonb,
  error text,
  -- The id the tool returned, copied onto os_clients on success.
  remote_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per leg per client: the unique constraint is what makes the whole
-- job idempotent, rather than relying on the caller to remember.
create unique index if not exists os_client_onboarding_once
  on public.os_client_onboarding (os_client_id, leg);

create index if not exists os_client_onboarding_pending
  on public.os_client_onboarding (status, created_at)
  where status in ('pending', 'failed');

alter table public.os_client_onboarding enable row level security;

comment on table public.os_client_onboarding is
  'Per-tool record of onboarding a client from the BrokerStaffer OS. One row '
  'per (client, tool) so a partial failure across four databases is visible '
  'and resumable. Master Inbox runs last because it mints the live portal token.';

-- No policy for anon or authenticated on either table: they are written and
-- read only by the service role. Enabling RLS without a permissive policy is
-- the deny-all default, which is what we want — nothing in a browser has any
-- business here, and the client portals must never see it.


-- ===========================================================================
-- ROLLBACK
--
-- Both tables are new and nothing else in the database points at them, so
-- undoing this is two statements and leaves no trace. Run only if you want the
-- OS client list gone entirely — it takes the onboarding history with it.
--
--   drop table if exists public.os_client_onboarding;
--   drop table if exists public.os_clients;
--
-- Nothing in Master Inbox, the client portals, Client Health, Analytics or
-- Onboarding reads these tables, so the rollback cannot affect any of them
-- either. The indexes and RLS settings are dropped with their tables.
-- ===========================================================================
