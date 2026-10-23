-- 0041 — the Demo Portal's own Prospects list (23 Oct 2026).
--
-- Run once in the Master Inbox database (Supabase → SQL editor). Safe to run
-- again. It adds one new, empty table; nothing existing is changed.
--
-- On the new client portal's preview, Market → "Move to Prospects" (and the
-- Setup wizard's prospects step) adds agents to the Demo Portal's Prospects
-- page. A real client's prospects are the agents in its campaigns in the agent
-- database; the Demo Portal has no campaigns, so its list is kept here — only
-- the agent's id in the agent database (never an email), who added it and
-- when. Only the Demo Portal ever writes here (lib/crm-preview/demo-market.ts).

CREATE TABLE IF NOT EXISTS public.os_demo_prospects (
  portal_id  uuid        NOT NULL,
  agent_id   text        NOT NULL,
  added_by   text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portal_id, agent_id)
);

ALTER TABLE public.os_demo_prospects ENABLE ROW LEVEL SECURITY;
