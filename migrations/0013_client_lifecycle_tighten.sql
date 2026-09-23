-- 0013 — retire 'prospect', the old spelling of 'onboarding'.
--
-- The contract half of 0012's expand/contract. RUN THIS ONLY AFTER the OS
-- deploy that stops writing 'prospect' is live, because until then the Adopt
-- route still writes that word and this constraint would refuse it.
--
-- There is no rush: 0012 already normalised every row, and a stale browser tab
-- is the only thing that could still send the old word. This migration simply
-- closes that door.
--
-- SAFE TO RE-RUN. It refuses rather than corrupts if a 'prospect' row has
-- appeared since, so the error tells you the deploy has not actually gone out.

BEGIN;

DO $$
DECLARE stragglers INT;
BEGIN
  SELECT count(*) INTO stragglers FROM public.os_clients WHERE status = 'prospect';
  IF stragglers > 0 THEN
    RAISE EXCEPTION
      'still % row(s) with status = ''prospect''. The OS deploy that stops writing it is not live yet — deploy first, then re-run this.',
      stragglers;
  END IF;
END $$;

ALTER TABLE public.os_clients DROP CONSTRAINT IF EXISTS os_clients_status_check;

ALTER TABLE public.os_clients
  ADD CONSTRAINT os_clients_status_check
  CHECK (status IN ('onboarding', 'active', 'paused', 'churned'));

COMMENT ON COLUMN public.os_clients.status IS
  'onboarding | active | paused | churned — the platform-wide client '
  'lifecycle. THIS is the master; every other tool mirrors it.';

COMMIT;
