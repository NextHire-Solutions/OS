-- 0054: Billing-cycle pause (20 Nov 2026; BrokerStaffer's Section 2 request).
--
-- When a client's billing cycle reaches its required introductions (Client
-- Health's Intros / Billing "due"), every campaign of the client that is
-- sending pauses. Nothing restarts by itself: a person resumes them. One row
-- per client per cycle that reached its target, so it acts once per cycle and a
-- campaign a person resumes isn't paused again in that cycle.
--
-- Run once in the Master Inbox database (Supabase, SQL editor).
-- Additive and safe to re-run. Nothing pauses until OS_CYCLE_PAUSE=1 is set;
-- before that the sweep writes nothing here and only logs what it would do.

CREATE TABLE IF NOT EXISTS public.os_cycle_pauses (
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- The cycle as Client Health shows it: last billing date to next billing date.
  cycle_start   date        NOT NULL,
  cycle_end     date        NOT NULL,
  -- What it was measured at when it acted: the cycle's due (target + carried) and the intros counted.
  required      integer     NOT NULL,
  delivered     integer     NOT NULL,
  reached_at    timestamptz NOT NULL DEFAULT now(),
  -- [{ platform, id, int_id, name, paused_at }]: the campaigns it paused.
  paused        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- [{ platform, id, int_id, name, reason }]: left running because another client shares them.
  left_running  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- [{ platform, id, int_id, name, error }]: still to pause, tried again every run until the cycle ends.
  to_retry      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Unique per client and cycle: the insert is the claim, so two runs at once can't both act.
  PRIMARY KEY (os_client_id, cycle_start)
);
CREATE INDEX IF NOT EXISTS os_cycle_pauses_end ON public.os_cycle_pauses (cycle_end);
ALTER TABLE public.os_cycle_pauses ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
