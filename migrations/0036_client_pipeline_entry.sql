-- 0036 — Where a client's agents enter its portal pipeline (16 Oct 2026; revised 17 Oct)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT, after 0035. Safe to run more
-- than once. Additive: one new column on os_clients. Nothing else.
--
-- Eddy (16 Oct): a per-client switch. EXISTING clients keep entering the
-- pipeline at "Introduction" (today's behaviour); NEW clients are meant to
-- enter at "Interested", via the Postmark hand-off (0035).
--
-- WHAT RUNNING IT CHANGES TODAY: NOTHING, for any client.
--
-- Every row — the existing ones AND every client created after this runs —
-- reads 'introduction', today's behaviour. The "enter the portal at
-- Interested" side is NOT built (it would write the live portal, and the
-- portal needs that stage first). Until it is, a client is 'interested' only
-- if an admin sets it on purpose in Inbox → Settings → Brokerage hand-off, and
-- even then the only effect is a field RECORDED on each hand-off
-- (os_brokerage_relays.pipeline_action) for the team to review. No portal
-- entry, label, Follow Up Boss push or count changes.
--
-- The first draft of this file then switched the column's default to
-- 'interested', so new clients would silently differ from existing ones
-- before anything used the difference. That step was removed on review
-- (17 Oct). Make 'interested' the default for new clients in a LATER
-- migration, shipped together with the portal side:
--
--   ALTER TABLE public.os_clients ALTER COLUMN pipeline_entry SET DEFAULT 'interested';

ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS pipeline_entry text NOT NULL DEFAULT 'introduction'
  CHECK (pipeline_entry IN ('introduction', 'interested'));
