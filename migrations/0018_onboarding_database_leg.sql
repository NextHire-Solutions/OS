-- 0018 — let the onboarding history record the Database leg.
--
-- os_client_onboarding (migration 0002) keeps one row per onboarding step. Its
-- `leg` CHECK allows 'analytics', 'client_health', 'onboarding', 'master_inbox'
-- — written before the Database leg existed. When that leg was added
-- (onboard-plan.ts: analytics, client_health, database, master_inbox), its
-- history rows were refused by this constraint, and onboard-run.ts did not
-- check the upsert's error, so the refusal was silent.
--
-- Found 28 Sep 2026 by onboarding a test client on production: the Database
-- record WAS created and linked — only its history row was missing, so the
-- onboarding record showed three steps done instead of four.
--
-- Additive: widens an allowed set. No existing row can violate the new check,
-- no reader depends on 'database' being absent. Safe to re-run.

BEGIN;

ALTER TABLE public.os_client_onboarding
  DROP CONSTRAINT IF EXISTS os_client_onboarding_leg_check;

ALTER TABLE public.os_client_onboarding
  ADD CONSTRAINT os_client_onboarding_leg_check
  CHECK (leg IN ('analytics', 'client_health', 'onboarding', 'database', 'master_inbox'));

COMMIT;
