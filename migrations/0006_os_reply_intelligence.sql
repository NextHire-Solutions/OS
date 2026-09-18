-- ===========================================================================
-- 0006_os_reply_intelligence — what the reply agent knows, and what it learns
--
-- WHAT THIS IS FOR
--
-- The reply agent writes from a bare prompt today, and it shows: of the 600
-- most recent drafts, 517 were never sent and 82 of the 83 that were followed
-- by a real reply had been rewritten from scratch. It has no idea how we
-- actually answer people.
--
-- These four tables are that knowledge:
--
--   os_reply_examples     every inbound message paired with the reply we
--                         really sent, so a draft can be written with the
--                         nearest real answers in front of it
--   os_agent_knowledge    the house style and the objection playbook,
--                         distilled from those examples and editable on
--                         screen — the agent's instructions in plain English
--   os_reply_feedback     what the agent drafted vs what we actually sent,
--                         captured on every send
--   os_knowledge_proposals  rules distilled from recurring corrections, held
--                         for a person to approve — the agent never edits its
--                         own instructions unattended
--
-- WHAT IT DOES NOT DO
--
-- It does not touch `messages`, `threads`, `reply_agents` or `reply_drafts`.
-- Those belong to Master Inbox, which is deployed and live; everything here is
-- read FROM them and written only to these `os_` tables, which reach the
-- database through the allow-list in src/lib/clients/os-tables.ts.
--
-- No extension is required. Embeddings are stored as a plain double precision
-- array and compared in the application over a label-filtered candidate set —
-- a few hundred rows per query, which is microseconds. pgvector becomes worth
-- adding somewhere past ~50k examples; there are ~24k replies in total today.
--
-- SAFETY
--   · four new tables, nothing altered
--   · RLS on with no policies: deny-all except the service role
--   · no live tool reads any of them
--
-- ROLLBACK
--   drop table if exists public.os_knowledge_proposals;
--   drop table if exists public.os_reply_feedback;
--   drop table if exists public.os_reply_examples;
--   drop table if exists public.os_agent_knowledge;
--   -- the agent falls back to the plain prompt it uses today.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The corpus: how we have actually answered people.
-- ---------------------------------------------------------------------------
create table if not exists public.os_reply_examples (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,

  -- Where it came from, so an example can always be traced back and re-read.
  thread_id           uuid,
  inbound_message_id  uuid,
  -- One example per reply we sent: re-running the builder updates rather than
  -- duplicates.
  outbound_message_id uuid unique,

  -- What the situation was.
  label               text,
  client_name         text,
  inbound_text        text not null,

  -- What we said back. This is the thing worth imitating.
  reply_text          text not null,
  sent_at             timestamptz,

  /*
   * Ranking weight, 0..1. Built from recency, from whether the thread later
   * reached a good outcome, and from whether a human wrote it rather than
   * accepting a draft unchanged. Retrieval sorts by similarity × quality, so
   * a merely similar example never beats a similar AND good one.
   */
  quality             real not null default 0.5,

  -- 'history'    — mined from what we sent
  -- 'correction' — the agent drafted something and we rewrote it; these are
  --                the most instructive examples we have, and rank highest
  source              text not null default 'history'
                      check (source in ('history', 'correction')),

  -- Embedded from `inbound_text`: we match on the situation, not the answer.
  embedding           double precision[],
  embedding_model     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists os_reply_examples_ws_label_idx
  on public.os_reply_examples (workspace_id, label);
create index if not exists os_reply_examples_quality_idx
  on public.os_reply_examples (workspace_id, quality desc);
create index if not exists os_reply_examples_thread_idx
  on public.os_reply_examples (thread_id);

comment on table public.os_reply_examples is
  'Inbound message → the reply we really sent. Retrieved at draft time so the agent writes from real precedent rather than invention.';

-- ---------------------------------------------------------------------------
-- 2. The instructions, in plain English, editable on screen.
-- ---------------------------------------------------------------------------
create table if not exists public.os_agent_knowledge (
  workspace_id        uuid primary key,
  -- How we write: length, greeting, sign-off, what we never say.
  style_guide         text,
  -- How we answer each objection, one section per kind.
  objection_playbook  text,
  -- When the distillation last ran, and over how many examples.
  distilled_at        timestamptz,
  distilled_from      integer,
  updated_at          timestamptz not null default now(),
  updated_by          text
);

comment on table public.os_agent_knowledge is
  'The reply agent''s house style and objection playbook. Distilled from os_reply_examples, then edited by people — the edited version always wins.';

-- ---------------------------------------------------------------------------
-- 3. What the agent wrote vs what we sent.
-- ---------------------------------------------------------------------------
create table if not exists public.os_reply_feedback (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  thread_id     uuid,
  draft_id      uuid,
  agent_id      uuid,

  draft_body    text,
  sent_body     text,

  /*
   * as_written  — went out unchanged (allowing for entity encoding: replies
   *               are stored HTML-encoded, so "you&#039;re" vs "you're" must
   *               not read as a human edit)
   * light_edit  — mostly kept
   * rewritten   — started again
   * discarded   — a draft that was never sent
   */
  verdict       text not null
                check (verdict in ('as_written', 'light_edit', 'rewritten', 'discarded')),
  similarity    real,
  -- Optional: the reviewer's own words about what was wrong.
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists os_reply_feedback_ws_idx on public.os_reply_feedback (workspace_id, created_at desc);
create index if not exists os_reply_feedback_verdict_idx on public.os_reply_feedback (workspace_id, verdict);
create unique index if not exists os_reply_feedback_draft_idx on public.os_reply_feedback (draft_id) where draft_id is not null;

comment on table public.os_reply_feedback is
  'Every draft measured against what was actually sent. The score on the agent screen, and the raw material for the next distillation.';

-- ---------------------------------------------------------------------------
-- 4. Rules the agent proposes, for a person to accept.
-- ---------------------------------------------------------------------------
create table if not exists public.os_knowledge_proposals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  -- "Never open with 'I hope this email finds you well'."
  rule          text not null,
  -- Why it thinks so: the corrections it drew this from.
  evidence      jsonb not null default '[]'::jsonb,
  target        text not null default 'style'
                check (target in ('style', 'playbook')),
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'rejected')),
  decided_at    timestamptz,
  decided_by    text,
  created_at    timestamptz not null default now()
);

create index if not exists os_knowledge_proposals_status_idx
  on public.os_knowledge_proposals (workspace_id, status, created_at desc);

comment on table public.os_knowledge_proposals is
  'Rules distilled from recurring corrections, held pending. The agent never edits its own instructions unattended.';

-- ---------------------------------------------------------------------------
-- Deny-all. Only the service role — the OS server — reaches these.
-- ---------------------------------------------------------------------------
alter table public.os_reply_examples     enable row level security;
alter table public.os_agent_knowledge    enable row level security;
alter table public.os_reply_feedback     enable row level security;
alter table public.os_knowledge_proposals enable row level security;
