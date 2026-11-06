-- 0050: Pay per lead — a lead a billing person chose not to bill (6 Nov).
--
-- Amy: Homebase was sent one interested reply past its cap (Daniel Passalacqua)
-- and must not be charged for it. On a client's Billing tab in the OS, the
-- people named in billing-access.ts can press "Don't bill" on a lead, with a
-- reason, while its period isn't charged yet; "Bill it" takes that back. Never
-- in the client portal.
--
-- A lead here is billed in no period for this client, and uses none of its
-- lead cap. Keyed like the billing itself (model.ts leadKey: the agent's
-- address, lower-cased), and kept apart by mode as the periods are: one marked
-- while a client is still in test stays off only its test bill.
--
-- Run once in the Master Inbox database (Supabase, SQL editor).
-- Additive and safe to re-run. Until it runs, the button says this file is needed.

CREATE TABLE IF NOT EXISTS public.os_usage_billing_waivers (
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  test_mode     boolean     NOT NULL,
  lead_key      text        NOT NULL CHECK (length(lead_key) > 0),
  lead_name     text,
  reason        text        NOT NULL CHECK (length(btrim(reason)) > 0),
  waived_by     text        NOT NULL,
  waived_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (os_client_id, test_mode, lead_key)
);
ALTER TABLE public.os_usage_billing_waivers ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
