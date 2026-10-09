-- 0032 — Pause date, entered on the master record (9 Oct).
--
-- Performance's Client movement gains a Paused column: how many clients were
-- paused each month. Pauses since 13 Sep 2026 come from the status history
-- (os_client_status_history, 0012), which records every change. Pauses BEFORE
-- that were never recorded anywhere, so:
--
--   pause_date  entered by hand on the client's record in Clients, for a pause
--               the status history does not have. Never set automatically —
--               nothing is backfilled and no existing row changes.
--
-- The record shows the latest of this and the history's last pause; the
-- Paused column counts both.
--
-- Additive: one nullable date column. Safe to re-run.

BEGIN;

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS pause_date date;

COMMIT;

NOTIFY pgrst, 'reload schema';
