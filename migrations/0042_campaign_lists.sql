-- 0042 — My Agents and DNC off the client's own campaigns; each client's
-- Prospects campaign (26 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: three new tables. No existing
-- row, column, constraint or trigger is changed; nothing the standalone
-- Master Inbox or the portals read is touched.
--
-- WHAT IT IS FOR
--
-- Eddy (16 Oct): "Remove all DNC and My agents from campaigns" and "Add them
-- [Prospects] to campaign automatically". When a portal adds someone to My
-- Agents or DNC, the OS takes that address off THAT client's own EmailBison
-- campaigns (never another client's, never a blocklist — the blocklists stay
-- exactly as they are). Code: src/lib/clients/campaign-lists/.
--
-- WHAT RUNNING IT SWITCHES ON
--
-- Nothing. With these tables in place nothing happens until a person turns
-- the clean-up on in Inbox → Settings → Campaign clean-up. Even then it starts
-- in PRACTICE: it looks each person up and records which campaigns they would
-- come off, and removes nothing. A real removal additionally needs practice
-- mode off, the client's own switch on and OS_CAMPAIGN_CLEANUP_LIVE=1 on the
-- OS service (and, while OS_CAMPAIGN_CLEANUP_LIVE_ONLY is set, a campaign on
-- that list).

BEGIN;

-- 1. The switches. One row; no row = off.
CREATE TABLE IF NOT EXISTS public.os_campaign_list_settings (
  id             text        PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  -- false = nothing at all happens, not even practice.
  enabled        boolean     NOT NULL DEFAULT false,
  -- true = look up and record only; never remove.
  practice_mode  boolean     NOT NULL DEFAULT true,
  -- Moved to "now" whenever the clean-up is switched on or leaves practice:
  -- entries added before it are never acted on (no backfill). The sweep's
  -- place is (cursor_at, cursor_id) — bulk imports share one created_at.
  cursor_at      timestamptz,
  cursor_id      uuid,
  -- Entries looked at per pass (about one EmailBison call each).
  per_run        integer     NOT NULL DEFAULT 40 CHECK (per_run BETWEEN 1 AND 500),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);
ALTER TABLE public.os_campaign_list_settings ENABLE ROW LEVEL SECURITY;

-- 2. Each client's own switch and Prospects campaign.
CREATE TABLE IF NOT EXISTS public.os_campaign_list_clients (
  os_client_id             uuid        PRIMARY KEY REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- Live removals for this client. Default off.
  remove_enabled           boolean     NOT NULL DEFAULT false,
  -- The EmailBison campaign new Prospects go to (Eddy's "add them to
  -- campaign automatically"). Chosen in the client's Campaigns tab.
  prospects_campaign_id    text,
  prospects_campaign_name  text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               text
);
ALTER TABLE public.os_campaign_list_clients ENABLE ROW LEVEL SECURITY;

-- 3. Every My Agents / DNC entry the clean-up looked at: skipped, practised,
--    removed or failed, with each campaign's outcome. UNIQUE dedupe_key is the
--    claim: whichever process inserts first acts, every other is refused.
CREATE TABLE IF NOT EXISTS public.os_campaign_removals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- '<source>:<entry id>'
  dedupe_key        text        NOT NULL UNIQUE,
  source            text        NOT NULL CHECK (source IN ('my_agents', 'dnc')),
  entry_id          uuid        NOT NULL,
  entry_created_at  timestamptz,
  mi_client_id      uuid,
  os_client_id      uuid        REFERENCES public.os_clients(id) ON DELETE SET NULL,
  email             text,
  person_name       text,
  status            text        NOT NULL CHECK (status IN ('pending', 'skipped', 'not_in_campaigns', 'practice', 'removed', 'partly_removed', 'failed')),
  reason            text,
  -- [{ campaignId, campaignName, leadId, leadStatus, outcome, reason?, error? }]
  campaigns         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  attempts          integer     NOT NULL DEFAULT 0,
  error             text,
  decided_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS os_campaign_removals_recent ON public.os_campaign_removals (created_at DESC);
CREATE INDEX IF NOT EXISTS os_campaign_removals_client ON public.os_campaign_removals (os_client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS os_campaign_removals_status ON public.os_campaign_removals (status, updated_at);
ALTER TABLE public.os_campaign_removals ENABLE ROW LEVEL SECURITY;

COMMIT;
