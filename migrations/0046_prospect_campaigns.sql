-- 0046 — a client's Prospects in its campaign; its first campaign at setup (2 Nov 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: three new tables and one new
-- column (os_campaign_list_clients.prospects_by_mls, empty by default). No
-- existing row, column, constraint or trigger is changed; nothing the
-- standalone Master Inbox or the portals read is touched.
--
-- WHAT IT IS FOR
--
-- Eddy (2 Nov): "1. Create campaign when they setup portal 2. Add their
-- selected prospects as leads 3. Have an automation to auto add/remove leads
-- from campaigns as they add/remove/edit their prospects lists on their
-- portal". Each change to a portal's Prospects becomes a row in
-- os_prospect_sync, which the OS works off in the background: an agent added
-- goes into the client's Prospects campaign (a new client's: a draft copy of
-- the setup template, made once, recorded in os_setup_campaigns); an agent
-- removed comes out of the client's own campaigns. Code:
-- src/lib/clients/prospect-sync/.
--
-- WHAT RUNNING IT SWITCHES ON
--
-- Nothing in any campaign. From the OS deploy on, the portals RECORD each
-- Prospects change here; nothing is done with them until OS_PROSPECT_SYNC=1 is
-- set on the OS service — and while OS_PROSPECT_SYNC_ONLY lists portals, only
-- theirs. Switching it on applies what was recorded meanwhile.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Every Prospects change, one row per agent, and what became of it.
CREATE TABLE IF NOT EXISTS public.os_prospect_sync (
  id             bigserial   PRIMARY KEY,
  portal_id      uuid        NOT NULL,
  os_client_id   uuid        REFERENCES public.os_clients(id) ON DELETE SET NULL,
  agent_id       uuid        NOT NULL,
  action         text        NOT NULL CHECK (action IN ('add', 'remove')),
  -- 'setup' (picked in the Setup wizard) or 'prospects' (Market / Prospects afterwards)
  source         text        NOT NULL DEFAULT 'prospects' CHECK (source IN ('setup', 'prospects')),
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'skipped', 'failed')),
  -- The EmailBison campaign(s) it went into or came out of, and the lead.
  campaign_id    text,
  campaign_name  text,
  eb_lead_id     text,
  email          text,
  detail         text,
  attempts       integer     NOT NULL DEFAULT 0,
  -- Not before then: a change waiting for a campaign, or tried again after a failure, steps aside.
  next_try_at    timestamptz,
  -- A removal: the campaigns the portal showed the agent in ([{ provider, id, name }]) — looked in too.
  in_campaigns   jsonb,
  claim_token    uuid,
  claimed_at     timestamptz,
  requested_by   text        NOT NULL,
  -- Made while OS_PROSPECT_SYNC_ONLY fenced the run to test portals.
  test           boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);
-- (A table made by an earlier draft of this file gets the columns too.)
ALTER TABLE public.os_prospect_sync ADD COLUMN IF NOT EXISTS next_try_at timestamptz;
ALTER TABLE public.os_prospect_sync ADD COLUMN IF NOT EXISTS in_campaigns jsonb;
CREATE INDEX IF NOT EXISTS os_prospect_sync_work ON public.os_prospect_sync (status, next_try_at, id);
CREATE INDEX IF NOT EXISTS os_prospect_sync_agent ON public.os_prospect_sync (portal_id, agent_id, status);
CREATE INDEX IF NOT EXISTS os_prospect_sync_portal_due ON public.os_prospect_sync (portal_id, status, next_try_at, id);
ALTER TABLE public.os_prospect_sync ENABLE ROW LEVEL SECURITY;

-- The portals with changes due now, the longest-waiting first — so the run takes a share of each, and one busy portal
-- never hides another's. Reads only.
CREATE OR REPLACE FUNCTION public.os_prospect_sync_due_portals(p_now timestamptz, p_limit integer)
RETURNS TABLE (portal_id uuid)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT s.portal_id
  FROM public.os_prospect_sync s
  WHERE s.status = 'pending' AND (s.next_try_at IS NULL OR s.next_try_at <= p_now)
  GROUP BY s.portal_id
  ORDER BY min(s.id)
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.os_prospect_sync_due_portals(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.os_prospect_sync_due_portals(timestamptz, integer) TO service_role;

-- 2. The campaign made for a client that had none when it finished setup —
--    at most one per client, or for a client with several MLSs one per MLS
--    (the primary key is the claim: whichever run inserts first makes it).
CREATE TABLE IF NOT EXISTS public.os_setup_campaigns (
  os_client_id          uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- The MLS it is for (the agent database's code); '' for a client with one market.
  mls_code              text        NOT NULL DEFAULT '',
  portal_id             uuid        NOT NULL,
  status                text        NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'ready', 'failed')),
  campaign_id           text        UNIQUE,
  campaign_name         text,
  template_campaign_id  text        NOT NULL,
  error                 text,
  created_by            text        NOT NULL,
  test                  boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (os_client_id, mls_code)
);
ALTER TABLE public.os_setup_campaigns ENABLE ROW LEVEL SECURITY;

-- 3. The setup template: the EmailBison campaign a new client's first campaign
--    is copied from (its emails, schedule and sending inboxes). One row; no
--    row = no template, and a new client's prospects wait for one.
CREATE TABLE IF NOT EXISTS public.os_prospect_sync_settings (
  id                      text        PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  template_campaign_id    text,
  template_campaign_name  text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text
);
ALTER TABLE public.os_prospect_sync_settings ENABLE ROW LEVEL SECURITY;

-- 4. A client with several MLSs (Keyes: West and East Florida; Homebase: Boston
--    and Southern California) has a campaign per market: its Prospects campaign
--    per MLS, { "<MLS code>": { "id": "...", "name": "..." } }, chosen on its
--    Campaigns tab. An agent goes into the campaign of their MLS (the user,
--    3 Nov). A client with one MLS keeps prospects_campaign_id.
ALTER TABLE public.os_campaign_list_clients ADD COLUMN IF NOT EXISTS prospects_by_mls jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
