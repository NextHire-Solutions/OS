-- 0039 — A client's offer, from the new portal's Setup wizard (22 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where `clients` — the
-- portals — lives). Safe to run more than once. Purely additive: one new
-- table. Nothing existing is changed.
--
-- The wizard's last step, "Tell us your offer" (Eddy's design, Setup-5-Offer):
-- what the client gives agents who join, why agents join them, and anything
-- we should never say. BrokerStaffer writes the client's recruiting emails
-- from it. The user, 22 Oct: "yes please save the data". One row per portal;
-- saved from the portal (the Demo Portal only until launch), shown read-only
-- on the portal's page in the OS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_portal_offers (
  portal_id   uuid        PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  offers      text[]      NOT NULL DEFAULT '{}',
  why_join    text        NOT NULL,
  never_say   text,
  updated_by  citext,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Only the server (service role) reads or writes it.
ALTER TABLE public.os_portal_offers ENABLE ROW LEVEL SECURITY;

COMMIT;
