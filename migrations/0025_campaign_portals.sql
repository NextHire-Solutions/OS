-- 0025 — Which portal each campaign's leads go to (1 Oct).
--
-- A client can own several portals (Properties & Estates: Boston and
-- Florida). A reply used to be sorted into a portal by guessing from the
-- campaign's NAME, and the guess sent Florida leads to the Boston portal.
-- This table records the portal for each campaign of such a client:
-- chosen automatically once (source 'auto'), changeable on the client's
-- record (source 'manual'). Master Inbox reads it first when a reply
-- arrives; with no row here it guesses exactly as before, so clients with
-- one portal are unaffected.
--
-- campaign_id is stored the way threads.campaign_id stores it: EmailBison's
-- number, Instantly's UUID.
--
-- Additive: one new table. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_campaign_portals (
  platform       text        NOT NULL CHECK (platform IN ('emailbison', 'instantly')),
  campaign_id    text        NOT NULL,
  campaign_name  text,
  os_client_id   uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  mi_client_id   uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  source         text        NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  decided_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  PRIMARY KEY (platform, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_os_campaign_portals_client ON public.os_campaign_portals (os_client_id);

ALTER TABLE public.os_campaign_portals ENABLE ROW LEVEL SECURITY;

COMMIT;
