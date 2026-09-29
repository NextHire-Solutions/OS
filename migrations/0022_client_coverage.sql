-- 0022 — Markets, MLS and Area as the client data sheet has them (30 Sep).
--
-- The sheet records three independent things per client:
--   Markets   how many markets the client covers — a number
--   MLS       the MLS boards, a list of codes
--   Area      the areas, a list of names
-- They are NOT paired: ChuckTown covers 6 markets across 7 areas and 5 boards,
-- and that is simply what is true. 0017 stored (market, MLS, area) as paired
-- rows, which forced a symmetry the business does not have; the client asked
-- for the sheet's shape instead.
--
-- Additive: three columns on os_clients. os_client_markets (0017) is left in
-- place, unread, so nothing is lost. Safe to re-run.

BEGIN;

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS market_count integer
  CHECK (market_count IS NULL OR (market_count >= 0 AND market_count <= 999));
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS mls_codes text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS areas text[] NOT NULL DEFAULT '{}';

COMMIT;
