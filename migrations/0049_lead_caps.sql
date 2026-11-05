-- 0049: Lead and spend caps (5 Nov, approved by Eddy).
--
-- A pay-per-lead client has a lead cap (its Monthly introduction target) and,
-- optionally, a spend limit. When it hits whichever comes first, its campaigns
-- pause, and restart at the start of its next 28-day window. Replies that still
-- arrive go to Keep Warm: not sent to the client, not charged.
--
-- Run once in the Master Inbox database (Supabase, SQL editor).
-- Additive and safe to re-run. Nothing acts on these until OS_LEAD_CAPS=1 is set.

-- The spend limit per window, in cents. NULL means no limit.
ALTER TABLE public.os_usage_billing_settings
  ADD COLUMN IF NOT EXISTS spend_cap_cents integer CHECK (spend_cap_cents IS NULL OR spend_cap_cents > 0);

-- One row per client per window that reached its cap, with the campaigns waiting to restart.
CREATE TABLE IF NOT EXISTS public.os_cap_windows (
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  window_start  date        NOT NULL,
  window_end    date        NOT NULL,
  reached_at    timestamptz,
  -- [{ platform, id, int_id, name, paused_at, confirmed }]: only confirmed ones restart by themselves.
  paused        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  restarted_at  timestamptz,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (os_client_id, window_start)
);
ALTER TABLE public.os_cap_windows ENABLE ROW LEVEL SECURITY;

-- A reply held over the cap. Not billed unless a person sends it, then billed in
-- the period it really goes.
CREATE TABLE IF NOT EXISTS public.os_cap_held_leads (
  thread_id     uuid        PRIMARY KEY,
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  relay_id      uuid,
  agent_name    text,
  agent_email   text,
  window_start  date        NOT NULL,
  held_at       timestamptz NOT NULL DEFAULT now(),
  labelled_at   timestamptz,
  released_at   timestamptz,
  released_by   text
);
CREATE INDEX IF NOT EXISTS os_cap_held_leads_client ON public.os_cap_held_leads (os_client_id, released_at);
ALTER TABLE public.os_cap_held_leads ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
