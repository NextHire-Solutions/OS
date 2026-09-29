-- 0023 — Onboarding date and churn date, stored on the master record (30 Sep).
--
-- Both were only ever DERIVED from the status history, which starts on
-- 13 Sep 2026: a client that churned before then has no churn date anywhere,
-- so Performance could not say who left in which month. Now:
--   onboarding_date  entered on the client's record in Clients (and set when a
--                    client is created); the Performance "added" month
--   churn_date       entered on the record, and set to the day a client's
--                    status changes to Churned; the Performance "churned"
--                    month, and the day Commissions stops accruing
--
-- Additive: two nullable date columns. Safe to re-run.

BEGIN;

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS onboarding_date date;
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS churn_date date;

COMMIT;
