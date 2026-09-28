-- 0017 — a client works MANY markets, not one.
--
-- 0015 added os_clients.market, .mls and .area as single TEXT columns, one value
-- each. That was wrong about the business, and the client said so directly:
--
--     "one client can cover multiple Markets, MLS and Area hence have multiple
--      campaigns and 1 or multiple portals"
--
-- One value per client cannot express that. Properties & Estates works Boston
-- AND Florida; SERHANT. PA works its base market AND 15M+. Those are already
-- visible as separate Master Inbox portal rows, but the OS had no way to say
-- WHY a client has two portals — only that it did.
--
-- ---------------------------------------------------------------------------
-- A FLAT LIST, DELIBERATELY NOT LINKED TO A PORTAL
--
-- A market row does NOT reference a portal, by decision. The chain in the
-- business is:
--
--     one client -> many (market, MLS, area) -> many campaigns -> 1..n portals
--
-- Those last two arrows are not one-to-one with the first, and nothing today
-- knows which portal serves which market. Adding a portal FK would mean
-- inventing that mapping, and a guessed mapping in a foreign key is worse than
-- no mapping at all: it would look authoritative while being made up.
--
-- So this table answers "which markets does this client cover" and nothing
-- else. When the market->portal mapping is genuinely known it can be added as
-- its own nullable column here, without moving any of this data.
--
-- ---------------------------------------------------------------------------
-- WHY THE OLD COLUMNS STAY
--
-- Measured 2026-09-28, os_clients.market, .mls and .area are populated on
-- 0 of 50 clients — all three are entirely empty, so there is nothing to
-- migrate and no reader to break. They are left in place anyway: expand now,
-- contract later, so a deploy of this migration and a deploy of the code that
-- stops reading them do not have to be the same deploy. Dropping them is a
-- separate migration once the UI has shipped and settled.
--
-- ---------------------------------------------------------------------------
-- THE UNIQUE INDEX USES coalesce(), AND HAS TO
--
-- In Postgres NULL <> NULL, so a plain UNIQUE (client_id, market, mls, area)
-- would happily accept ("Boston", NULL, NULL) twice over. MLS and area are
-- both optional, so that is the common shape rather than an edge case. The
-- index therefore folds NULL to '' and lowercases, which also makes "Boston"
-- and "boston" the same market instead of two.
--
-- SAFE TO RE-RUN.

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_client_markets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- The market is the one required part: a row with no market is not a
  -- coverage area, it is an empty row. MLS and area refine it.
  market      TEXT NOT NULL CHECK (btrim(market) <> ''),
  mls         TEXT CHECK (mls IS NULL OR btrim(mls) <> ''),
  area        TEXT CHECK (area IS NULL OR btrim(area) <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "the markets for this client", so this is the only index the
-- table's own queries need.
CREATE INDEX IF NOT EXISTS idx_os_client_markets_client
  ON public.os_client_markets(client_id);

-- Case-insensitive, NULL-safe uniqueness. See the note above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_os_client_markets_unique
  ON public.os_client_markets (
    client_id,
    lower(btrim(market)),
    coalesce(lower(btrim(mls)), ''),
    coalesce(lower(btrim(area)), '')
  );

COMMENT ON TABLE public.os_client_markets IS
  'The markets a client covers, one row per (market, MLS, area). A client may '
  'have many. Deliberately NOT linked to a portal: which portal serves which '
  'market is not known anywhere, and a guessed foreign key would look '
  'authoritative while being invented. See migration 0017.';

COMMENT ON COLUMN public.os_client_markets.market IS
  'The market, e.g. "Boston" or "Florida". Required — the row means nothing '
  'without it.';
COMMENT ON COLUMN public.os_client_markets.mls IS
  'The MLS covered in this market, e.g. "MLS PIN". Optional: a market may be '
  'known before its MLS is.';
COMMENT ON COLUMN public.os_client_markets.area IS
  'The sub-area within the market, e.g. "Miami Dade". Optional.';

COMMIT;
