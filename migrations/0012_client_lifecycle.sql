-- 0012 — the client lifecycle: the spec's four statuses, and a record of when
-- each one changed.
--
-- TWO CHANGES, both additive. Nothing is dropped, nothing is renamed, and no
-- row changes value.
--
-- 1. THE VOCABULARY. os_clients allowed 'prospect' where the architecture
--    spec says 'onboarding'. Two words for one idea is the spec's own
--    complaint.
--
--    THE NEW CONSTRAINT DELIBERATELY STILL ACCEPTS 'prospect'. This is the
--    expand half of expand/contract, and it exists to remove a window in
--    which the live app would break. Today's deployed code writes 'prospect'
--    in two places — the Adopt route and the status dropdown. If this
--    migration accepted only the four new words, every Adopt would fail from
--    the moment it ran until the next deploy. Accepting both means the
--    running app keeps working, the new deploy also works, and 0013 removes
--    the old word once that deploy is out. Order stops mattering, which is
--    the point.
--
-- 2. A STATUS HISTORY. Today a churn is a flag with no date, so "9 churned"
--    can be counted but "churned this month" cannot. The Performance screen
--    says so on its own face: "all time · needs status history for a rate".
--    The spec asks for pause date, churn date and reactivation date (§12) and
--    for out-of-sync detection (§16); a history answers all of it, and answers
--    it for changes nobody remembered to record, because the trigger writes
--    the row rather than a person.
--
-- NOT TOUCHED: orch_clients.status in the onboarding database. That is a
-- PIPELINE — new, assigned, copy_sent, copy_approved, team_built, leads_built,
-- campaign_launched, live, paused — answering how far through onboarding a
-- client is, not whether they are active. The two share the word 'paused' and
-- mean different things by it. OS maps the pipeline to a lifecycle; it must
-- never overwrite it.
--
-- SAFE TO RE-RUN.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The vocabulary
-- ---------------------------------------------------------------------------

/*
 * Drop every CHECK on os_clients that constrains status, found by what it
 * constrains rather than by a name Postgres generated.
 *
 * A loop, not a single SELECT INTO: if more than one such constraint exists,
 * taking only the first would leave the other one still refusing the new
 * word, and the failure would arrive later as a puzzling rejected write
 * rather than here where it can be seen.
 */
DO $$
DECLARE con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.os_clients'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.os_clients DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'dropped status constraint: %', con_name;
  END LOOP;
END $$;

-- Normalise the data to the spec's word. Zero rows today; here so a re-run
-- after someone has set one is still correct.
UPDATE public.os_clients SET status = 'onboarding' WHERE status = 'prospect';

-- Accepts the legacy word as well — see the note at the top. 0013 removes it.
ALTER TABLE public.os_clients
  ADD CONSTRAINT os_clients_status_check
  CHECK (status IN ('onboarding', 'active', 'paused', 'churned', 'prospect'));

COMMENT ON COLUMN public.os_clients.status IS
  'onboarding | active | paused | churned — the platform-wide client '
  'lifecycle. THIS is the master; every other tool mirrors it. '
  '(''prospect'' is the retired spelling of ''onboarding'', still accepted '
  'until migration 0013.)';

-- ---------------------------------------------------------------------------
-- 2. The history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.os_client_status_history (
  id            BIGSERIAL PRIMARY KEY,
  -- The OS client. Not a foreign key for the same reason os_clients holds
  -- none: a client is never deleted, only moved to churned, so there is no
  -- cascade to protect against — and a history that a delete could erase
  -- would defeat its own purpose.
  os_client_id  UUID        NOT NULL,
  from_status   TEXT,                    -- NULL on the first row: it came from nowhere
  to_status     TEXT        NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who, when a person did it. NULL when the trigger recorded a change made
  -- by a script, which is honest rather than attributing it to somebody.
  changed_by    TEXT,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS os_client_status_history_client
  ON public.os_client_status_history (os_client_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS os_client_status_history_when
  ON public.os_client_status_history (changed_at DESC);

COMMENT ON TABLE public.os_client_status_history IS
  'Every lifecycle change, written by a trigger so none is missed. Makes '
  'pause/churn/reactivation dates and churn-per-month answerable.';

/*
 * Record the change, not the intention. The trigger fires on the row that
 * actually changed, so a status set by a script, a backfill or the UI is
 * recorded the same way and none of them can forget.
 *
 * AFTER, and it only ever INSERTs into a different table, so it cannot alter
 * or reject the write it is observing. A client save can never fail because
 * of this trigger.
 */
CREATE OR REPLACE FUNCTION public.os_clients_record_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.os_client_status_history (os_client_id, from_status, to_status)
    VALUES (NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.os_client_status_history (os_client_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS os_clients_record_status ON public.os_clients;
CREATE TRIGGER os_clients_record_status
  AFTER INSERT OR UPDATE ON public.os_clients
  FOR EACH ROW EXECUTE FUNCTION public.os_clients_record_status();

/*
 * Seed one row per existing client so every client has a history rather than
 * only those that change from now on.
 *
 * `changed_at` is the client's own created_at, NOT now(): dating thirty-seven
 * clients to the minute this migration ran would put a spike in every
 * month-by-month chart that reads this table, which is the first thing it
 * will be used for. from_status is NULL because we genuinely do not know what
 * came before — the flag carried no date, which is the whole reason this
 * table exists.
 *
 * This INSERT targets the history table, not os_clients, so the trigger above
 * does not fire for it and no row is recorded twice. The NOT EXISTS makes a
 * re-run a no-op.
 */
INSERT INTO public.os_client_status_history (os_client_id, from_status, to_status, changed_at, note)
SELECT c.id, NULL, c.status, COALESCE(c.created_at, now()),
       'seeded from the status held at migration 0012; earlier changes were never dated'
FROM public.os_clients c
WHERE NOT EXISTS (
  SELECT 1 FROM public.os_client_status_history h WHERE h.os_client_id = c.id
);

COMMIT;
