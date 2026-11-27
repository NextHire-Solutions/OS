-- 0059: adding agents from the agent database to a campaign, through the Claude connector (28 Nov 2026).
--
-- Claude's campaign_add_agents action (lib/mcp/actions/campaign-agents.ts) records ONE job: which campaign, and the agent
-- database filters it was confirmed with. The OS's every-minute run (lib/clients/campaign-agents/run.ts) collects every
-- matching agent into the job's items (no cap), then adds them to the campaign in batches the way a client's Prospects
-- go in (prospect-sync's addInto: the database's own email, a lead EmailBison already has added as it is, the audited
-- attach). Each item says what became of its agent; the job holds the totals.
--
-- Run once in the Master Inbox database (Supabase, SQL editor). Additive and safe to re-run. Until it is run, the action
-- refuses ("needs migrations/0059_campaign_agent_jobs.sql") and nothing changes.

CREATE TABLE IF NOT EXISTS public.os_campaign_agent_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    text        NOT NULL,
  campaign_name  text,
  os_client_id   uuid,
  filters        jsonb       NOT NULL,
  described      text,
  mls_codes      text[],
  matched        integer,
  collected      integer     NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'adding', 'done', 'failed')),
  detail         text,
  requested_by   text        NOT NULL,
  added          integer     NOT NULL DEFAULT 0,
  already        integer     NOT NULL DEFAULT 0,
  skipped        integer     NOT NULL DEFAULT 0,
  failed         integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS os_campaign_agent_jobs_status_idx ON public.os_campaign_agent_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS os_campaign_agent_jobs_campaign_idx ON public.os_campaign_agent_jobs (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.os_campaign_agent_job_items (
  id            bigserial   PRIMARY KEY,
  job_id        uuid        NOT NULL REFERENCES public.os_campaign_agent_jobs (id) ON DELETE CASCADE,
  agent_id      uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'skipped', 'failed')),
  kind          text,
  detail        text,
  email         text,
  eb_lead_id    text,
  attempts      integer     NOT NULL DEFAULT 0,
  claim_token   uuid,
  claimed_at    timestamptz,
  next_try_at   timestamptz,
  processed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, agent_id)
);
CREATE INDEX IF NOT EXISTS os_campaign_agent_job_items_due_idx ON public.os_campaign_agent_job_items (job_id, status, next_try_at, id);

-- Server only, like every os_* table.
ALTER TABLE public.os_campaign_agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_campaign_agent_job_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.os_campaign_agent_jobs FROM anon, authenticated;
REVOKE ALL ON public.os_campaign_agent_job_items FROM anon, authenticated;
GRANT ALL ON public.os_campaign_agent_jobs TO service_role;
GRANT ALL ON public.os_campaign_agent_job_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.os_campaign_agent_job_items_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
