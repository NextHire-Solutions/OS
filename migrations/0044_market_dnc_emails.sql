-- 0044 — the hidden address of an agent a client moves to their DNC List from Market (28 Oct 2026).
--
-- Run once in the Master Inbox database (Supabase → SQL editor). Safe to run
-- again. It adds one new, empty table; nothing existing is changed.
--
-- On the new client portal, Market → "Move to DNC List" saves the agent onto
-- the client's DNC List by name and brokerage only: the agent database's email
-- is never shown to the client (the user, 28 Oct: "Block them by email, keep
-- emails hidden"). Its PREFERRED email (the user's choice, 28 Oct) is blocked
-- at EmailBison and Instantly — and kept here, so the checks that read the DNC
-- List by address still see that person: the reply agent's do-not-contact
-- check (ai/safety-facts.ts) and the Postmark relay's (relay/relay.ts).
--
-- Never read by any page or export. Written only by lib/crm-preview/portal-save.ts.
-- A row goes with its DNC entry (ON DELETE CASCADE): taking the agent off the
-- DNC List takes the address off here too.

CREATE TABLE IF NOT EXISTS public.os_market_dnc_emails (
  entry_id   uuid        NOT NULL REFERENCES public.client_dnc_entries(id) ON DELETE CASCADE,
  client_id  uuid        NOT NULL,
  email      text        NOT NULL CHECK (email = lower(email)),
  added_by   text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, email)
);

-- The reply agent looks an address up across every client. Addresses are kept lower-case (as it asks for them).
CREATE INDEX IF NOT EXISTS os_market_dnc_emails_email_idx ON public.os_market_dnc_emails (email);
CREATE INDEX IF NOT EXISTS os_market_dnc_emails_client_idx ON public.os_market_dnc_emails (client_id);

-- Server-side only (the service role); no client, browser or anon key reads it.
ALTER TABLE public.os_market_dnc_emails ENABLE ROW LEVEL SECURITY;

-- So the database API sees the new table at once.
NOTIFY pgrst, 'reload schema';
