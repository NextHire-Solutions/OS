-- 0015 — the six master-record fields that are currently recorded nowhere.
--
-- §6 lists what the master client record should contain. Measured against the
-- live databases on 2026-09-24, six of those fields have no real home:
--
--     Account Manager   set on  0 of 46 clients
--     Sender            set on  1 of 46
--     MLS               set on  2 of 46
--     Market / location set on  2 of 46
--     Salesperson       set on  4 of 46
--     Area              stored nowhere at all
--
-- Everything else §6 asks for already has exactly one owner: status here,
-- plan/targets/billing/timezone in Client Health, team/agents/DNC/portal in
-- Master Inbox, attribution in Analytics. So this migration is not about
-- centralising fields that are spread around — it is about the six that were
-- never captured.
--
-- THIS IS WHY §5's EXAMPLE CANNOT BE BUILT TODAY. "Change the Account Manager
-- once and every tool updates" is not blocked by architecture; no client has
-- an Account Manager. There is nowhere in any tool to record one properly.
-- These columns are that place.
--
-- ---------------------------------------------------------------------------
-- NAMES, NOT FOREIGN KEYS
--
-- orch_clients points salesperson_id at orch_salespeople, which holds six rows
-- — one of them literally named "test" with an @outreachify.io address, and
-- two spellings of the same person ("Ryan Jagdeo" and "RYan"). Pointing the
-- master record at that table would inherit its problems and couple the OS to
-- another tool's schema for a field the OS is meant to own.
--
-- Plain text, chosen deliberately. The cost is that typos are possible; the
-- Edit dialog offers the names already in use so the common case is a click.
--
-- ---------------------------------------------------------------------------
-- COMPLETELY ADDITIVE. Six nullable columns on one table. No constraint, no
-- default, no trigger, no backfill that can fail, and nothing reads them until
-- the UI that writes them ships. No tool, no portal and no existing query can
-- behave differently because this ran.
--
-- SAFE TO RE-RUN.

BEGIN;

ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS account_manager TEXT,
  ADD COLUMN IF NOT EXISTS salesperson     TEXT,
  ADD COLUMN IF NOT EXISTS sender_name     TEXT,
  ADD COLUMN IF NOT EXISTS market          TEXT,
  ADD COLUMN IF NOT EXISTS mls             TEXT,
  ADD COLUMN IF NOT EXISTS area            TEXT;

COMMENT ON COLUMN public.os_clients.account_manager IS
  'Who runs this client. §6 master-record field. Recorded nowhere before '
  'migration 0015 — orch_clients.account_manager_id was set on 0 of 46 rows.';
COMMENT ON COLUMN public.os_clients.salesperson IS
  'Who sold this client. §6 master-record field. Names rather than a foreign '
  'key into orch_salespeople, which holds six rows including a test entry.';
COMMENT ON COLUMN public.os_clients.sender_name IS
  'The sending identity used for this client''s campaigns. §6 field.';
COMMENT ON COLUMN public.os_clients.market IS
  'The market this client works. §6 field; orch_clients.location had it for '
  '2 of 46.';
COMMENT ON COLUMN public.os_clients.mls IS
  'The MLS this client''s leads come from. §6 field, and §8 puts it at the '
  'centre of the Database view; orch_clients.mls had it for 2 of 46.';
COMMENT ON COLUMN public.os_clients.area IS
  'Sub-area within the market. §6 field, stored nowhere before this.';

COMMIT;
