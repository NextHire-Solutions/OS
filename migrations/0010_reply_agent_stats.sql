-- ===========================================================================
-- 0010_reply_agent_stats — v_reply_agent_stats, one row per agent
--
-- WHAT THIS IS FOR
--
-- Plan §8 asks for per-agent numbers in the screen AND the same numbers over
-- an API, and plan §9 says the view is "built from existing draft records +
-- the new thread-state, so no double bookkeeping". That last clause is the
-- whole design: nothing here is a counter the application has to remember to
-- increment. Every number is derived, so it cannot drift from what happened.
--
--   replies drafted / sent / rejected   reply_drafts, stamped with agent_id
--   AI token usage                      reply_drafts.tokens_*
--   lead replies received               inbound messages on the agent's threads
--   qualification started / qualified
--   / handed over / stopped             agent_thread_state (migration 0009)
--
-- THE CURSOR
--
-- `updated_at` is the greatest of the agent's own updated_at, its newest
-- draft, and its newest thread-state change. That is what makes the API's
-- `updated_since` incremental: any event that could move a number also moves
-- this column.
--
-- WHY LATERALS RATHER THAN GROUP BY
--
-- Three independent aggregates over three tables. A single grouped join would
-- multiply rows together and silently inflate the counts — the classic
-- fan-out. Each lateral is its own scalar subquery over one table, so the
-- counts are what they say they are. There are single digits of agents, so
-- the cost is irrelevant either way.
--
-- SAFETY
--   · a view, over tables this migration does not change
--   · reads only; creates nothing writable
--   · no PII beyond what the reply agent screen already shows
--
-- ROLLBACK
--   drop view if exists public.v_reply_agent_stats;
-- ===========================================================================

create or replace view public.v_reply_agent_stats as
select
  -- ---- config summary: what this agent IS (plan §8: "config summary + stats")
  a.id                         as agent_id,
  a.workspace_id,
  a.name,
  a.run_mode,
  a.active,
  a.client_ids,
  a.channel_filter,
  a.provider,
  a.model,
  a.tone,
  a.schedule,
  -- The questions themselves, not just a count: an external tool comparing two
  -- variants needs to know WHICH script produced which numbers. No secrets
  -- here — api_key_encrypted is never exposed by this view.
  a.qualification,
  -- Handover minus the message body, which can be long and is not a metric.
  jsonb_build_object(
    'cc_count',          jsonb_array_length(coalesce(a.handover -> 'cc_emails', '[]'::jsonb)),
    'mark_introduction', coalesce(a.handover -> 'mark_introduction', 'false'::jsonb)
  )                            as handover_summary,

  -- ---- drafting -----------------------------------------------------------
  coalesce(d.drafted, 0)       as replies_drafted,
  coalesce(d.sent, 0)          as replies_sent,
  coalesce(d.rejected, 0)      as drafts_failed,
  coalesce(d.tokens_prompt, 0) as tokens_prompt,
  coalesce(d.tokens_completion, 0) as tokens_completion,
  coalesce(d.tokens_prompt, 0) + coalesce(d.tokens_completion, 0) as tokens_total,

  -- ---- the conversation ---------------------------------------------------
  coalesce(r.lead_replies, 0)  as lead_replies_received,
  coalesce(s.started, 0)       as qualification_started,
  coalesce(s.qualified, 0)     as qualification_qualified,
  coalesce(s.handed_over, 0)   as qualification_handed_over,
  coalesce(s.stopped, 0)       as qualification_stopped,
  -- Replies the safety gate refused to send and parked. Non-zero is the number
  -- to look at: it means a live agent wanted to send and was not allowed.
  coalesce(s.held, 0)          as sends_held,
  coalesce(s.stop_reasons, '{}'::jsonb) as stop_reasons,

  -- ---- rates (plan §8) ----------------------------------------------------
  -- Stated as fractions 0..1, rounded to 4dp. Null rather than 0 when the
  -- denominator is 0: "no data" and "zero percent" are different answers and
  -- an external tool should be able to tell them apart.
  case when coalesce(d.drafted, 0) > 0
       then round(coalesce(d.sent, 0)::numeric / d.drafted, 4) end       as reply_rate,
  case when coalesce(s.started, 0) > 0
       then round(coalesce(s.qualified, 0)::numeric / s.started, 4) end  as qualification_rate,
  case when coalesce(s.qualified, 0) > 0
       then round(coalesce(s.handed_over, 0)::numeric / s.qualified, 4) end as handover_rate,

  -- ---- cursor -------------------------------------------------------------
  a.created_at,
  greatest(a.updated_at, d.last_draft_at, s.last_state_at) as updated_at

from public.reply_agents a

-- Every draft this agent has ever written. `status` is Master Inbox's own
-- draft_status: pending (waiting in the composer), sent (a reply went out on
-- that thread), rejected (the provider call failed).
left join lateral (
  select
    count(*)                                          as drafted,
    count(*) filter (where dd.status = 'sent')        as sent,
    count(*) filter (where dd.status = 'rejected')    as rejected,
    sum(coalesce(dd.tokens_prompt, 0))                as tokens_prompt,
    sum(coalesce(dd.tokens_completion, 0))            as tokens_completion,
    max(greatest(dd.created_at, dd.sent_at))          as last_draft_at
  from public.reply_drafts dd
  where dd.agent_id = a.id
) d on true

-- The qualification funnel. `started` is every thread the agent has opened
-- state on, which is the honest denominator for a qualification rate.
left join lateral (
  select
    count(*)                                             as started,
    count(*) filter (where t.status in ('qualified', 'handed_over')) as qualified,
    count(*) filter (where t.status = 'handed_over')      as handed_over,
    count(*) filter (where t.status = 'stopped')          as stopped,
    count(*) filter (where t.hold_reason is not null)     as held,
    -- Why the stopped ones stopped, as { reason: count } — the plan asks for
    -- the stop reason alongside the count, and one aggregated object keeps the
    -- API's row shape flat. Grouped in its own subquery rather than aggregated
    -- alongside the counts above: jsonb_object_agg over ungrouped rows would
    -- silently keep only the last row per reason.
    (
      select coalesce(jsonb_object_agg(g.stop_reason, g.n), '{}'::jsonb)
      from (
        select t2.stop_reason, count(*) as n
        from public.agent_thread_state t2
        where t2.agent_id = a.id and t2.stop_reason is not null
        group by t2.stop_reason
      ) g
    )                                                     as stop_reasons,
    max(t.updated_at)                                     as last_state_at
  from public.agent_thread_state t
  where t.agent_id = a.id
) s on true

-- What the leads said back, on the threads this agent is running. Counted from
-- `messages` rather than from a counter, so a backfilled or re-synced thread
-- is reflected without any extra bookkeeping.
left join lateral (
  select count(*) as lead_replies
  from public.messages m
  where m.direction = 'inbound'
    and m.thread_id in (
      select t2.thread_id from public.agent_thread_state t2 where t2.agent_id = a.id
    )
) r on true;

comment on view public.v_reply_agent_stats is
  'Per-agent config summary + derived stats. Feeds the Reply Agents analytics panel and GET /api/reply-agents/stats. Every number is derived from reply_drafts, agent_thread_state and messages — there are no counters to keep in step.';

-- The API reads this with the service role, the same as every other feed.
grant select on public.v_reply_agent_stats to service_role;
