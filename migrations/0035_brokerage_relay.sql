-- 0035 — Interested replies → the brokerage, by Postmark (16 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: four new tables and one new
-- column on os_clients. No existing row, column, constraint or trigger is
-- changed; nothing the standalone Master Inbox or the portals read is touched.
--
-- WHAT IT IS FOR
--
-- The approved plan "Interested replies, straight to the brokerage": when a
-- reply is marked Interested (or Meetings Booked), the agent's own reply is
-- delivered by Postmark to the right people at the brokerage the agent's
-- CAMPAIGN belongs to, from "<Agent> via BrokerStaffer" on leads.brokerstaffer
-- .com, Reply-To the agent. Code: src/lib/tools/master-inbox/relay/.
--
-- WHAT RUNNING IT SWITCHES ON
--
-- Nothing. With these tables in place the relay still does nothing until a
-- person turns it on in Inbox → Settings → Brokerage hand-off (os_relay_settings
-- .enabled). Even then it starts in PRACTICE: it decides and records what it
-- would have sent, and sends nothing. A real send additionally needs
-- practice_mode off, the brokerage's own switch on, POSTMARK_SERVER_TOKEN set
-- and OS_BROKERAGE_RELAY_LIVE_SEND=1 on the OS service.

BEGIN;

-- 1. The relay's switches — one row per workspace. No row = off.
CREATE TABLE IF NOT EXISTS public.os_relay_settings (
  workspace_id            uuid        PRIMARY KEY,
  -- The global switch. false = nothing at all happens, not even practice.
  enabled                 boolean     NOT NULL DEFAULT false,
  -- true = decide and record only; never send. The plan's practice week.
  practice_mode           boolean     NOT NULL DEFAULT true,
  -- Plan §7, open: send as soon as a reply is marked, or wait for a person to
  -- press "Send to brokerage". The cautious answer is the default.
  mode                    text        NOT NULL DEFAULT 'one_click' CHECK (mode IN ('automatic', 'one_click')),
  -- Plan §7, open: relay the agent's LATER replies to the same brokerage too.
  forward_later_replies   boolean     NOT NULL DEFAULT false,
  -- Plan §7, open: whether a hand-off counts as an introduction (portal entry,
  -- Follow Up Boss, notices, numbers). Recorded only — see the code.
  counts_as_introduction  boolean     NOT NULL DEFAULT false,
  -- Plan §4: at most this many deliveries to one brokerage per hour.
  hourly_cap              integer     NOT NULL DEFAULT 5 CHECK (hourly_cap BETWEEN 1 AND 100),
  -- Set each time the switch goes on. Nothing labelled before it is relayed
  -- (no backfill).
  enabled_since           timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text
);
ALTER TABLE public.os_relay_settings ENABLE ROW LEVEL SECURITY;

-- 2. Every hand-off the relay considered: practised, held, ready, sent or
--    skipped, with the message it built. This is the practice-week log, the
--    "short list" of held conversations, and the record each conversation
--    shows ("Sent to Angela at 10:42").
CREATE TABLE IF NOT EXISTS public.os_brokerage_relays (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid        NOT NULL,
  -- 'handoff:<thread id>' or 'follow_up:<message id>'. UNIQUE: each
  -- conversation is handed off once, each later reply relayed once.
  dedupe_key              text        NOT NULL UNIQUE,
  kind                    text        NOT NULL DEFAULT 'handoff' CHECK (kind IN ('handoff', 'follow_up')),
  thread_id               uuid        NOT NULL,
  -- The agent's message that was (or would be) delivered.
  message_id              uuid,
  parent_id               uuid        REFERENCES public.os_brokerage_relays(id) ON DELETE SET NULL,
  -- 'Interested', 'Meetings Booked' or 'later reply'.
  trigger                 text        NOT NULL,
  triggered_at            timestamptz,
  status                  text        NOT NULL CHECK (status IN ('held', 'skipped', 'ready', 'practice', 'sending', 'sent', 'failed', 'bounced')),
  reason                  text,
  detail                  text,
  platform                text,
  campaign_id             text,
  campaign_name           text,
  os_client_id            uuid        REFERENCES public.os_clients(id) ON DELETE SET NULL,
  mi_client_id            uuid,
  brokerage_name          text,
  -- How the brokerage was found: 'team', 'campaign_portal' or 'campaign_name'.
  resolved_by             text,
  agent_email             text,
  agent_name              text,
  -- [{ "name": "Angela Oakes", "email": "angela@…" }]
  recipients              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  from_name               text,
  from_address            text,
  reply_to                text,
  subject                 text,
  text_body               text,
  html_body               text,
  headers                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- What the client's pipeline-entry setting would do ('none' or
  -- 'enter_at_interested'). Recorded only: nothing writes the portal.
  pipeline_action         text,
  counts_as_introduction  boolean     NOT NULL DEFAULT false,
  practice                boolean     NOT NULL DEFAULT true,
  provider_message_id     text,
  attempts                integer     NOT NULL DEFAULT 0,
  error                   text,
  decided_by              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  decided_at              timestamptz,
  sent_at                 timestamptz,
  bounced_at              timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS os_brokerage_relays_thread   ON public.os_brokerage_relays (thread_id);
CREATE INDEX IF NOT EXISTS os_brokerage_relays_status   ON public.os_brokerage_relays (status, created_at DESC);
CREATE INDEX IF NOT EXISTS os_brokerage_relays_client   ON public.os_brokerage_relays (os_client_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS os_brokerage_relays_provider ON public.os_brokerage_relays (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS os_brokerage_relays_held     ON public.os_brokerage_relays (platform, campaign_id) WHERE status = 'held';
ALTER TABLE public.os_brokerage_relays ENABLE ROW LEVEL SECURITY;

-- 3. "Never twice": one delivery per agent per brokerage, ever. The primary
--    key is the guarantee — whichever process inserts first delivers, every
--    other one is refused by the database. Practice and live are kept apart so
--    a practice week does not use up the live delivery.
CREATE TABLE IF NOT EXISTS public.os_brokerage_relay_agents (
  workspace_id  uuid        NOT NULL,
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  agent_email   text        NOT NULL,
  mode          text        NOT NULL CHECK (mode IN ('practice', 'live')),
  relay_id      uuid        REFERENCES public.os_brokerage_relays(id) ON DELETE SET NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, os_client_id, agent_email, mode)
);
ALTER TABLE public.os_brokerage_relay_agents ENABLE ROW LEVEL SECURITY;

-- 4. The team's answer for a campaign the relay could not place (the held
--    list). Read by the relay only — it does NOT change which portal a reply
--    is filed in (that is os_campaign_portals, 0025, which this never writes).
CREATE TABLE IF NOT EXISTS public.os_relay_campaigns (
  platform       text        NOT NULL,
  campaign_id    text        NOT NULL,
  campaign_name  text,
  os_client_id   uuid        REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- "Not a brokerage campaign" (an internal or mixed campaign): never relayed.
  ignored        boolean     NOT NULL DEFAULT false,
  decided_by     text,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, campaign_id),
  CHECK (ignored OR os_client_id IS NOT NULL)
);
ALTER TABLE public.os_relay_campaigns ENABLE ROW LEVEL SECURITY;

-- 5. Each brokerage's own relay settings: its on/off switch (pilot), who
--    receives (introduction contacts by territory, or one address), an hourly
--    cap override and a mode override. Empty = all defaults = off.
ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS relay_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
