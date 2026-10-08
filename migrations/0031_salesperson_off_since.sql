-- 0031 — When a salesperson's role was switched off (9 Oct).
--
-- Commissions pays a salesperson whose role was switched off on Team access
-- for payouts up to that day, and not after — so a payout already made is
-- never rewritten (Eddy became an account manager only on 8 Oct). This column
-- records the day. Until it exists the OS uses the record's last change.
--
-- Additive: one nullable column, filled for records already switched off.
-- Safe to re-run.

BEGIN;

ALTER TABLE public.os_salespeople ADD COLUMN IF NOT EXISTS inactive_since timestamptz;

UPDATE public.os_salespeople
   SET inactive_since = updated_at
 WHERE active = false AND inactive_since IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
