-- 0026 — A client's own introduction (1 Oct).
--
-- The Introduce button, the reply agent's handover and the stored
-- "Intro Macro - <client>" template all send one standard wording built
-- from the client's contacts. Some clients want their own words. This
-- column holds the introduction pasted on the client's record (Clients →
-- the client → Introduce to); when it is set it is sent instead of the
-- standard wording. NULL — every client today — keeps the standard one.
--
-- Additive: one new nullable column. Safe to re-run.

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS intro_override text;
