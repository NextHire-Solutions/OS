-- 0036 — Where a client's agents enter its portal pipeline (16 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT, after 0035. Safe to run more
-- than once. Additive: one new column on os_clients.
--
-- Eddy (16 Oct): a per-client switch. EXISTING clients keep entering the
-- pipeline at "Introduction" (today's behaviour); NEW clients enter at
-- "Interested", via the Postmark hand-off (0035).
--
-- So the column is added with 'introduction' — which every existing row takes
-- — and only then is its default changed to 'interested', which applies to
-- rows created from now on. No existing row is changed by the second step.
--
-- What it changes today: nothing a client can see. The relay reads it and
-- RECORDS what the hand-off would do to the pipeline (pipeline_action on
-- os_brokerage_relays). Creating the portal pipeline entry at Interested is
-- not built — it writes the live portal and needs the portal to have that
-- stage — so the Introduction label keeps working exactly as before for every
-- client.
--
-- If you would rather new clients also start at 'introduction' until that
-- part is built, skip the ALTER ... SET DEFAULT below.

ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS pipeline_entry text NOT NULL DEFAULT 'introduction'
  CHECK (pipeline_entry IN ('introduction', 'interested'));

ALTER TABLE public.os_clients
  ALTER COLUMN pipeline_entry SET DEFAULT 'interested';
