-- ===========================================================================
-- 0009_reply_agent_modes — the reply agent gets an operating mode, a client,
--                          a schedule, a qualification script and a handover
--
-- WHAT THIS IS FOR
--
-- `reply_agents.mode` exists today and nothing reads it: every agent behaves
-- identically — it drafts, a human sends. The upgrade plan (§9) turns that
-- dead config into real behaviour and adds the four things an agent needs to
-- qualify a lead and hand it to the client:
--
--   run_mode       pause / shadow / live       what the agent is allowed to do
--   client_ids     uuid[]                      whose threads it runs on
--   schedule       jsonb                       when a LIVE agent may send
--   qualification  jsonb                       the questions it asks
--   handover       jsonb                       who gets CC'd, and what it says
--
-- plus `agent_thread_state`, which is where a multi-turn conversation keeps
-- its place: which question we are on, what the lead has answered, and whether
-- the lead has qualified, been handed over, or been stopped.
--
-- WHY NEW COLUMNS RATHER THAN REUSING `mode`
--
-- `mode` is an enum (agent_mode: human_in_loop / auto) referenced by the
-- decrypt RPC and by the standalone Master Inbox app, which reads the same
-- database. Widening a shared enum to add 'pause' and 'shadow' would change
-- behaviour in an app this migration is not deploying. `run_mode` is a new
-- text column with its own check constraint, so the old app sees exactly what
-- it saw yesterday and the new code reads the new column.
--
-- THE DEFAULT IS 'shadow', AND THAT IS THE SAFE DEFAULT ON PURPOSE
--
-- Shadow is what every agent does today: it writes a draft that appears in
-- MasterInbox and never sends. Defaulting to 'shadow' means running this
-- migration changes nothing about what the live system does — the agents go on
-- drafting. 'live' is never a default, is never reachable by a backfill, and
-- (see src/lib/tools/master-inbox/ai/live-gate.ts) cannot send at all unless a
-- server environment variable that does not exist yet is set by a human.
--
-- WHAT THIS DOES NOT DO
--
--   · it does not write to threads, messages, clients, labels,
--     label_assignments, client_pipeline_entries or reply_templates
--   · it does not change any existing column, constraint or default
--   · it does not backfill any row to 'live'
--   · it does not send anything
--
-- The one existing object it replaces is the `reply_agent_decrypt` function,
-- which must be rebuilt to return the new columns — Postgres refuses to change
-- a function's return type in place, so it is dropped and recreated exactly as
-- migration 0008 did when `channel_filter` was added. The added columns are
-- appended, so the standalone app (which reads the result by name and ignores
-- what it does not know) is unaffected.
--
-- ROLLBACK
--   drop table if exists public.agent_thread_state;
--   alter table public.reply_agents
--     drop column if exists run_mode,
--     drop column if exists client_ids,
--     drop column if exists schedule,
--     drop column if exists qualification,
--     drop column if exists handover;
--   -- then re-run migration 0008 to restore the previous reply_agent_decrypt.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The agent's operating mode.
-- ---------------------------------------------------------------------------
alter table public.reply_agents
  add column if not exists run_mode text not null default 'shadow';

alter table public.reply_agents
  drop constraint if exists reply_agents_run_mode_check;
alter table public.reply_agents
  add constraint reply_agents_run_mode_check
  check (run_mode in ('pause', 'shadow', 'live'));

comment on column public.reply_agents.run_mode is
  'pause = do nothing; shadow = draft into MasterInbox, never send; live = send within the schedule and the safety gate. Live additionally requires the server env gate — see ai/live-gate.ts.';

-- ---------------------------------------------------------------------------
-- 2. Per-client assignment.
--
-- An array rather than a single column because the plan's §7 says "which
-- client(s) this agent runs for", and because a house agent covering three
-- small clients is the obvious first thing anyone will ask for. Empty means
-- "any client", which is today's behaviour — an agent that has not been
-- assigned keeps matching on channel alone, so nothing stops working the
-- moment this migration lands.
--
-- Deliberately NOT a foreign key: uuid[] cannot carry one, and the alternative
-- (a join table) buys referential integrity at the cost of a second table for
-- what is a short list read on every draft. A deleted client leaves a dangling
-- id that simply never matches a thread.
-- ---------------------------------------------------------------------------
alter table public.reply_agents
  add column if not exists client_ids uuid[] not null default '{}'::uuid[];

comment on column public.reply_agents.client_ids is
  'clients.id values this agent runs for. Empty = any client (the pre-upgrade behaviour).';

-- ---------------------------------------------------------------------------
-- 3. When a live agent may send.
--
--   { "kind": "always" }
--   { "kind": "off_hours",
--     "timezone": "America/New_York",
--     "business_days": [1,2,3,4,5],       -- 0 = Sunday
--     "business_start": "09:00",
--     "business_end":   "17:00" }
--
-- jsonb rather than five columns: the shape is read as a unit by one pure
-- function (ai/schedule.ts) and is very likely to grow a holiday list. The
-- default is `always`, which is inert while run_mode is pause/shadow.
-- ---------------------------------------------------------------------------
alter table public.reply_agents
  add column if not exists schedule jsonb not null default '{"kind": "always"}'::jsonb;

comment on column public.reply_agents.schedule is
  'When a LIVE agent may auto-send: {"kind":"always"} or {"kind":"off_hours", timezone, business_days, business_start, business_end}. Inside business hours an off_hours agent drafts and holds; the release job sends when the window opens.';

-- ---------------------------------------------------------------------------
-- 4. The qualification script.
--
--   { "enabled": false,
--     "questions": [ { "id": "q1", "text": "..." } ],
--     "required": 2,                       -- answers needed before handover
--     "pass_rule": "all_answered" }        -- all_answered | any_answered
--
-- `enabled` defaults false so running this migration does not put a single
-- existing agent into a multi-turn conversation it was not configured for.
-- ---------------------------------------------------------------------------
alter table public.reply_agents
  add column if not exists qualification jsonb not null
  default '{"enabled": false, "questions": [], "required": 0, "pass_rule": "all_answered"}'::jsonb;

comment on column public.reply_agents.qualification is
  'The questions the agent asks before a lead is qualified, how many answers are required, and the pass rule. enabled=false means the agent replies as it does today with no qualification state.';

-- ---------------------------------------------------------------------------
-- 5. The handover.
--
--   { "cc_emails": ["client@example.com"],
--     "message": "Great — I am introducing you to ...",
--     "mark_introduction": false }
--
-- `mark_introduction` is OFF by default and stays off until someone asks for
-- it: applying the Introduction label is not bookkeeping. It notifies the
-- client over n8n and Slack, opens a portal pipeline entry and pushes it to
-- Follow Up Boss (see lib/outbox.ts). The agent must reuse that existing
-- guarded path rather than writing a label_assignment of its own.
-- ---------------------------------------------------------------------------
alter table public.reply_agents
  add column if not exists handover jsonb not null
  default '{"cc_emails": [], "message": "", "mark_introduction": false}'::jsonb;

comment on column public.reply_agents.handover is
  'CC addresses and the message sent when a lead qualifies. mark_introduction is off by default — that label fires real client notifications.';

-- Agents are selected per inbound reply, filtered to the active ones and then
-- matched on client. Small table (single digits today), but the index costs
-- nothing and documents the access path.
create index if not exists reply_agents_run_mode_idx
  on public.reply_agents (workspace_id, run_mode, active);

-- ---------------------------------------------------------------------------
-- 6. Per-thread qualification state — plan §9.
--
-- One row per (thread, agent). This is what makes the conversation multi-turn:
-- without it every inbound reply looks like the first one and the agent asks
-- question 1 forever.
--
-- It is also half of the analytics. `v_reply_agent_stats` (migration 0010)
-- counts started / qualified / handed-over / stopped straight off this table,
-- so there is no second set of counters to keep in step with reality.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_thread_state (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null,

  -- Which conversation, and which agent is running it. Both cascade: a purged
  -- thread or a deleted agent leaves no orphan state behind.
  thread_id               uuid not null references public.threads(id) on delete cascade,
  agent_id                uuid not null references public.reply_agents(id) on delete cascade,

  -- qualifying   → still asking questions
  -- qualified    → the pass rule is satisfied, handover is due
  -- handed_over  → the handover reply went out (or was drafted, in shadow)
  -- stopped      → the safety gate or a human stopped it; see stop_reason
  status                  text not null default 'qualifying'
                          check (status in ('qualifying', 'qualified', 'handed_over', 'stopped')),

  -- Which question is next (0-based index into qualification.questions).
  step                    integer not null default 0,

  -- [{ "question_id": "q1", "question": "...", "answer": "...", "at": "..." }]
  -- The lead's own words, kept verbatim — they are what the handover message
  -- and the client both want to see.
  answers                 jsonb not null default '[]'::jsonb,

  stop_reason             text,

  -- Guards against acting twice on the same inbound message. Webhooks retry,
  -- and a duplicated delivery must not advance the script a second time.
  last_inbound_message_id uuid,
  last_action_at          timestamptz,

  -- ---- live-path bookkeeping (phase 3; all zero while nothing can send) ----
  -- Per-thread send cap, one of the safety gate's checks.
  sends_attempted         integer not null default 0,
  sends_made              integer not null default 0,
  -- A reply the gate refused to send now: why, which draft is waiting, and
  -- since when. The release job (ai/release.ts) reads exactly these three.
  hold_reason             text,
  held_draft_id           uuid,
  held_at                 timestamptz,
  handover_at             timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- One state per agent per thread. The engine upserts on this.
  unique (thread_id, agent_id)
);

create index if not exists agent_thread_state_agent_idx
  on public.agent_thread_state (agent_id, status);
create index if not exists agent_thread_state_thread_idx
  on public.agent_thread_state (thread_id);
-- The release job's query: everything still held, oldest first.
create index if not exists agent_thread_state_held_idx
  on public.agent_thread_state (workspace_id, held_at)
  where hold_reason is not null;

comment on table public.agent_thread_state is
  'Per-thread qualification progress for one reply agent: which question is next, what the lead answered, and whether they qualified, were handed over or were stopped. Powers multi-turn continuity and the per-agent stats view.';

-- Deny-all RLS, exactly as migrations/0006 does for the os_ tables: the
-- service role reaches this table through the server, and nothing else does.
alter table public.agent_thread_state enable row level security;

-- Keep updated_at honest. `set_updated_at` already exists in this database
-- (migration 0001 defines it and a dozen tables use it).
drop trigger if exists agent_thread_state_set_updated_at on public.agent_thread_state;
create trigger agent_thread_state_set_updated_at
  before update on public.agent_thread_state
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Rebuild reply_agent_decrypt so the new columns come back with the key.
--
-- Same drop-then-create dance as migration 0008, for the same reason: Postgres
-- will not let CREATE OR REPLACE change a function's return type. The new
-- columns are APPENDED to the end of the record so a caller that selects by
-- name — which is every caller — is unaffected.
-- ---------------------------------------------------------------------------
drop function if exists public.reply_agent_decrypt(uuid, text);

create or replace function public.reply_agent_decrypt(
  p_agent uuid,
  p_key text
)
returns table(
  id uuid,
  workspace_id uuid,
  name text,
  mode agent_mode,
  tone text,
  response_length text,
  max_tokens integer,
  temperature numeric,
  provider ai_provider,
  model text,
  api_key text,
  system_prompt text,
  channel_ids uuid[],
  channel_filter text,
  active boolean,
  auto_respond_new boolean,
  stats jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  run_mode text,
  client_ids uuid[],
  schedule jsonb,
  qualification jsonb,
  handover jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select
    a.id, a.workspace_id, a.name, a.mode, a.tone, a.response_length,
    a.max_tokens, a.temperature, a.provider, a.model,
    case when a.api_key_encrypted is null then null
         else pgp_sym_decrypt(a.api_key_encrypted, p_key) end as api_key,
    a.system_prompt, a.channel_ids, a.channel_filter, a.active, a.auto_respond_new,
    a.stats, a.created_at, a.updated_at,
    a.run_mode, a.client_ids, a.schedule, a.qualification, a.handover
  from reply_agents a
  where a.id = p_agent;
end;
$$;

revoke all on function public.reply_agent_decrypt(uuid, text) from public;
grant execute on function public.reply_agent_decrypt(uuid, text) to service_role;
