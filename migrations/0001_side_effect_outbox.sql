-- ===========================================================================
-- An outbox for Master Inbox's introduction side effects.
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (dukbececdyowowwyktys)
-- SQL editor → paste → run. It is safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Labelling a thread "Introduction" must notify three systems: n8n, Slack and
-- Follow Up Boss. Today those are fired with Next's `after()` — after the
-- response, in the same process, with no queue and no retry.
--
-- So a deploy or a container move in that split second loses them silently.
-- The introduction is in the database and visible in the client's portal, but
-- n8n never ran, nobody saw it in Slack, and the lead never reached the
-- client's CRM. No error is raised, because nobody is listening by then.
--
-- Follow Up Boss is partly protected — its push is gated on `fub_pushed_at`
-- being null — but nothing retries it, so a missed push waits for someone to
-- re-label the thread. n8n and Slack have no protection at all.
--
-- This table records each job BEFORE it is attempted, so a lost attempt is
-- visible and can be retried. That is the whole idea.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE TO ADD TO A LIVE DATABASE
--
-- It is purely additive: a new table, its own index, its own RLS policy.
-- Nothing existing is altered, no trigger is touched, no column changes type.
-- The running Master Inbox app does not know this table exists and cannot be
-- affected by it. If the workspace stopped using it tomorrow, the only
-- consequence would be rows nobody reads.
-- ===========================================================================

create table if not exists public.side_effect_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,

  -- What to do, and to what. `kind` is the destination; `subject_id` is the
  -- thread or pipeline entry it concerns.
  kind text not null check (kind in ('n8n_introduction', 'slack_introduction', 'fub_push')),
  subject_id uuid not null,
  payload jsonb not null default '{}'::jsonb,

  -- pending → done, or pending → failed once attempts run out. A row is never
  -- deleted on success: "it was delivered" is worth being able to prove.
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  -- Set on the way out so a stuck worker cannot re-claim the same row for a
  -- minute; also the backoff clock.
  claimed_at timestamptz,
  completed_at timestamptz
);

-- The worker's only query: pending work, oldest first.
create index if not exists side_effect_outbox_pending
  on public.side_effect_outbox (status, created_at)
  where status = 'pending';

-- One job per kind per subject. Re-labelling a thread as Introduction should
-- not queue a second Slack notice for the same introduction; the unique
-- constraint makes the enqueue idempotent rather than relying on the caller.
create unique index if not exists side_effect_outbox_once
  on public.side_effect_outbox (workspace_id, kind, subject_id);

alter table public.side_effect_outbox enable row level security;

-- No policy for anon or authenticated: this table is written and read only by
-- the service role. Enabling RLS without a permissive policy is the deny-all
-- default, which is what we want — nothing in the browser has any business
-- here, and the portals must never see it.
--
-- (The service role bypasses RLS, which is how the workspace reaches it.)

comment on table public.side_effect_outbox is
  'Durable queue for introduction side effects (n8n, Slack, Follow Up Boss). '
  'Written by the BrokerStaffer workspace before each attempt so a process '
  'restart cannot silently lose a notification. Additive: the Master Inbox '
  'app does not read this table.';
