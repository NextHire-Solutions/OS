-- 0057: Client Health's tables move into the Master Inbox project (Nov 2026), so Client Health's own Supabase project
-- (fjmxbhcxvkyimgyispaf) can be closed to save its monthly cost.
--
-- Run once in the Master Inbox database (Supabase, SQL editor). It only CREATES an empty schema, `client_health`, with
-- the same six tables, triggers and indexes Client Health has today (its 20 migrations, replayed and checked column by
-- column against the live project). Nothing reads or writes it until the OS is switched over with
-- CLIENT_HEALTH_DB=master-inbox, after the data is copied in. Safe to re-run.
--
-- ALSO NEEDED, once, in the dashboard: Project Settings → Data API → Exposed schemas → add `client_health` → Save.
-- (The OS reaches these tables through the Data API, like every other table.)
--
-- Own schema, not new names: the Master Inbox already has a `clients` table. Only the server's service role may use it:
-- the browser roles (anon, authenticated) get no access to the schema, and row level security is on with no policies.

CREATE SCHEMA IF NOT EXISTS client_health;

REVOKE ALL ON SCHEMA client_health FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA client_health TO service_role;

-- Keeps updated_at current on every update.
CREATE OR REPLACE FUNCTION client_health.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Keeps the lifecycle status and the two older flags in step (Client Health 0019, unchanged).
CREATE OR REPLACE FUNCTION client_health.clients_sync_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit status wins; otherwise the column default ('active') has
    -- already been applied by the time this runs, and the booleans follow it.
    IF NEW.status IS NULL THEN
      NEW.status := CASE
        WHEN NEW.hidden        THEN 'churned'
        WHEN NEW.client_paused THEN 'paused'
        ELSE 'active'
      END;
    END IF;
    NEW.hidden        := (NEW.status = 'churned');
    NEW.client_paused := (NEW.status = 'paused');
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.hidden        := (NEW.status = 'churned');
    NEW.client_paused := (NEW.status = 'paused');
  ELSIF NEW.hidden IS DISTINCT FROM OLD.hidden THEN
    NEW.status        := CASE WHEN NEW.hidden THEN 'churned' ELSE 'active' END;
    NEW.client_paused := (NEW.status = 'paused');
  ELSIF NEW.client_paused IS DISTINCT FROM OLD.client_paused THEN
    NEW.status := CASE WHEN NEW.client_paused THEN 'paused' ELSE 'active' END;
    NEW.hidden := (NEW.status = 'churned');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS client_health.clients (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL,
  weekly_target integer NOT NULL,
  start_date date,
  instantly_campaign_ids text[] DEFAULT '{}'::text[] NOT NULL,
  masterinbox_identifier text,
  campaign_size integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  bison_campaign_ids text[] DEFAULT '{}'::text[] NOT NULL,
  hidden boolean DEFAULT false NOT NULL,
  client_paused boolean DEFAULT false NOT NULL,
  portal_active boolean DEFAULT false NOT NULL,
  portal_synced_at timestamptz,
  billing_anchor_date date,
  billing_interval text DEFAULT 'biweekly'::text NOT NULL,
  emails_today integer DEFAULT 0 NOT NULL,
  emails_today_date date,
  billing_interval_days integer,
  time_zone text,
  dnc_count integer DEFAULT 0 NOT NULL,
  agents_count integer DEFAULT 0 NOT NULL,
  last_lead_activity_at timestamptz,
  stagnant_intros_count integer DEFAULT 0 NOT NULL,
  intros_since_last_billing integer DEFAULT 0 NOT NULL,
  monthly_target integer DEFAULT 0 NOT NULL,
  intros_this_month integer DEFAULT 0 NOT NULL,
  portal_url text,
  total_intros_corofy integer DEFAULT 0 NOT NULL,
  total_interested_corofy integer DEFAULT 0 NOT NULL,
  campaign_aliases text[] DEFAULT '{}'::text[] NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  intro_dates timestamptz[] DEFAULT '{}'::timestamptz[] NOT NULL,
  toggle_paused_campaigns jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT clients_billing_interval_check CHECK (billing_interval = ANY (ARRAY['biweekly'::text, '28-days'::text, 'monthly'::text, 'custom'::text])),
  CONSTRAINT clients_plan_check CHECK (plan = ANY (ARRAY['minimum'::text, 'production'::text, 'partner'::text])),
  CONSTRAINT clients_status_check CHECK (status = ANY (ARRAY['onboarding'::text, 'active'::text, 'paused'::text, 'churned'::text])),
  CONSTRAINT clients_weekly_target_check CHECK (weekly_target >= 0)
);

CREATE TABLE IF NOT EXISTS client_health.bison_campaigns (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  status text,
  emails_sent_total integer DEFAULT 0 NOT NULL,
  campaign_size integer DEFAULT 0 NOT NULL,
  progress_pct numeric(5,2) DEFAULT 0 NOT NULL,
  status_changed_at timestamptz,
  updated_at timestamptz DEFAULT now() NOT NULL,
  int_id integer,
  reply_count integer DEFAULT 0 NOT NULL,
  interested_count integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS client_health.instantly_campaigns (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  status text,
  emails_sent_total integer DEFAULT 0 NOT NULL,
  campaign_size integer DEFAULT 0 NOT NULL,
  progress_pct numeric(5,2) DEFAULT 0 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  status_changed_at timestamptz,
  reply_count integer DEFAULT 0 NOT NULL,
  interested_count integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS client_health.weekly_metrics (
  client_id uuid NOT NULL REFERENCES client_health.clients(id) ON DELETE CASCADE,
  week_key date NOT NULL,
  emails_sent integer DEFAULT 0 NOT NULL,
  intros integer DEFAULT 0 NOT NULL,
  last_intro_at timestamptz,
  updated_at timestamptz DEFAULT now() NOT NULL,
  intros_corofy integer DEFAULT 0 NOT NULL,
  last_corofy_intro_at timestamptz,
  interested_corofy integer DEFAULT 0 NOT NULL,
  last_interested_at timestamptz,
  hired_corofy integer DEFAULT 0 NOT NULL,
  last_hired_at timestamptz,
  replies integer DEFAULT 0 NOT NULL,
  emails_sent_instantly integer DEFAULT 0 NOT NULL,
  replies_instantly integer DEFAULT 0 NOT NULL,
  emails_sent_bison integer DEFAULT 0 NOT NULL,
  replies_bison integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (client_id, week_key)
);

-- Ids continue above the copied rows (20 today), so a pause/resume logged after the move never collides with one copied.
CREATE SEQUENCE IF NOT EXISTS client_health.campaign_toggle_log_id_seq START WITH 1000;
CREATE TABLE IF NOT EXISTS client_health.campaign_toggle_log (
  id bigint DEFAULT nextval('client_health.campaign_toggle_log_id_seq'::regclass) NOT NULL PRIMARY KEY,
  client_id uuid REFERENCES client_health.clients(id) ON DELETE SET NULL,
  client_name text NOT NULL,
  action text NOT NULL,
  actor text,
  results jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT campaign_toggle_log_action_check CHECK (action = ANY (ARRAY['pause'::text, 'resume'::text]))
);
ALTER SEQUENCE client_health.campaign_toggle_log_id_seq OWNED BY client_health.campaign_toggle_log.id;

CREATE TABLE IF NOT EXISTS client_health.sync_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz DEFAULT now() NOT NULL,
  finished_at timestamptz,
  ok boolean,
  error text,
  CONSTRAINT sync_runs_source_check CHECK (source = ANY (ARRAY['instantly'::text, 'masterinbox'::text, 'bison'::text, 'corofy'::text]))
);

CREATE INDEX IF NOT EXISTS campaign_toggle_log_client_idx ON client_health.campaign_toggle_log USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clients_client_paused_idx ON client_health.clients USING btree (client_paused) WHERE (client_paused = true);
CREATE INDEX IF NOT EXISTS clients_hidden_idx ON client_health.clients USING btree (hidden) WHERE (hidden = true);
CREATE INDEX IF NOT EXISTS clients_name_idx ON client_health.clients USING btree (name);
CREATE INDEX IF NOT EXISTS clients_status_idx ON client_health.clients USING btree (status);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON client_health.sync_runs USING btree (started_at DESC);
CREATE INDEX IF NOT EXISTS weekly_metrics_week_idx ON client_health.weekly_metrics USING btree (week_key);

DROP TRIGGER IF EXISTS bison_campaigns_updated_at ON client_health.bison_campaigns;
CREATE TRIGGER bison_campaigns_updated_at BEFORE UPDATE ON client_health.bison_campaigns FOR EACH ROW EXECUTE FUNCTION client_health.set_updated_at();
DROP TRIGGER IF EXISTS clients_sync_lifecycle ON client_health.clients;
CREATE TRIGGER clients_sync_lifecycle BEFORE INSERT OR UPDATE ON client_health.clients FOR EACH ROW EXECUTE FUNCTION client_health.clients_sync_lifecycle();
DROP TRIGGER IF EXISTS clients_updated_at ON client_health.clients;
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON client_health.clients FOR EACH ROW EXECUTE FUNCTION client_health.set_updated_at();
DROP TRIGGER IF EXISTS instantly_campaigns_updated_at ON client_health.instantly_campaigns;
CREATE TRIGGER instantly_campaigns_updated_at BEFORE UPDATE ON client_health.instantly_campaigns FOR EACH ROW EXECUTE FUNCTION client_health.set_updated_at();
DROP TRIGGER IF EXISTS weekly_metrics_updated_at ON client_health.weekly_metrics;
CREATE TRIGGER weekly_metrics_updated_at BEFORE UPDATE ON client_health.weekly_metrics FOR EACH ROW EXECUTE FUNCTION client_health.set_updated_at();

-- Row level security on, with no policies: only the service role (which bypasses it) reads or writes.
ALTER TABLE client_health.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health.bison_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health.instantly_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health.weekly_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health.campaign_toggle_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health.sync_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA client_health FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA client_health FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA client_health FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA client_health TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA client_health TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA client_health TO service_role;

NOTIFY pgrst, 'reload schema';
