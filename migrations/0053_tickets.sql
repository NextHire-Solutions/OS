-- 0053 — Tickets: client emails that reach the team's Gmail, shared and tracked (20 Nov 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: seven new tables. No existing row,
-- column, constraint or trigger is changed; nothing the standalone Master Inbox
-- or the portals read is touched.
--
-- WHAT IT IS FOR
--
-- The user (20 Nov): "one tickets section in OS where I can see emails that come in
-- our team's inbox (… eddy, amy and more team members) … emails that come from our
-- clients so that every team member can see those emails."
--
-- Each team member connects their own Gmail (read-only). The OS reads each new
-- message's headers and keeps ONLY emails FROM A CLIENT ADDRESS (an exact address on a
-- client's record or its portals' lists — the user: "make sure we only see emails that
-- came from client's email addresses. no other emails should be shown here"). A
-- teammate's reply in that conversation is kept only as a dated marker (who, when: no
-- subject, text or recipients) so the ticket can move to Waiting. Everything else is
-- never stored. One ticket per conversation, the same email received by two teammates
-- kept once. Code: src/lib/tools/tickets/.
--
-- PRIVACY OF THE STORED TOKEN: os_ticket_mailboxes.token_enc holds the Google refresh
-- token encrypted (AES-256-GCM) with a key that lives only in the OS's environment,
-- never in this database.
--
-- RUN IT BEFORE the OS deploy that reads these tables. Until then the Tickets screen
-- says the setup step is missing and the sync does nothing.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- A connected Gmail mailbox (one per Google account).
CREATE TABLE IF NOT EXISTS public.os_ticket_mailboxes (
  email            citext PRIMARY KEY,
  name             text,
  connected_by     citext NOT NULL,
  token_enc        text,
  scope            text,
  state            text NOT NULL DEFAULT 'syncing' CHECK (state IN ('syncing', 'ok', 'reconnect', 'paused')),
  history_id       text,
  backfill_done_at timestamptz,
  last_sync_at     timestamptz,
  last_ok_at       timestamptz,
  last_error       text,
  error_count      integer NOT NULL DEFAULT 0,
  claim_token      uuid,
  claimed_at       timestamptz,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One conversation with a client.
CREATE TABLE IF NOT EXISTS public.os_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY,
  os_client_id      uuid REFERENCES public.os_clients(id) ON DELETE SET NULL,
  match_method      text CHECK (match_method IN ('address', 'domain', 'manual')),
  subject           text NOT NULL DEFAULT '',
  contact_email     citext,
  contact_name      text,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'ignored')),
  assignee          citext,
  snoozed_until     timestamptz,
  snippet           text,
  first_message_at  timestamptz,
  last_message_at   timestamptz,
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  waiting_since     timestamptz,
  first_response_at timestamptz,
  message_count     integer NOT NULL DEFAULT 0,
  closed_at         timestamptz,
  closed_by         citext,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS os_tickets_number ON public.os_tickets (number);
CREATE INDEX IF NOT EXISTS os_tickets_status ON public.os_tickets (status, waiting_since);
CREATE INDEX IF NOT EXISTS os_tickets_assignee ON public.os_tickets (assignee) WHERE status IN ('open', 'waiting');
CREATE INDEX IF NOT EXISTS os_tickets_client ON public.os_tickets (os_client_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS os_tickets_activity ON public.os_tickets (last_activity_at DESC);

-- Each email, once, however many teammates received it (keyed by its RFC Message-ID).
CREATE TABLE IF NOT EXISTS public.os_ticket_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES public.os_tickets(id) ON DELETE CASCADE,
  rfc_id       text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  trimmed      boolean NOT NULL DEFAULT false,
  from_email   citext,
  from_name    text,
  to_list      jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_list      jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject      text,
  snippet      text,
  body_html    text,
  body_text    text,
  attachments  jsonb NOT NULL DEFAULT '[]'::jsonb,
  in_reply_to  text,
  refs         text[] NOT NULL DEFAULT '{}',
  sent_at      timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- For a database that ran an earlier draft of this file.
ALTER TABLE public.os_ticket_messages ADD COLUMN IF NOT EXISTS trimmed boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS os_ticket_messages_rfc ON public.os_ticket_messages (rfc_id);
CREATE INDEX IF NOT EXISTS os_ticket_messages_ticket ON public.os_ticket_messages (ticket_id, sent_at);

-- Which mailbox holds a copy of which email (Gmail ids are per mailbox): "Received by", Open in Gmail, threading.
CREATE TABLE IF NOT EXISTS public.os_ticket_copies (
  mailbox          citext NOT NULL,
  gmail_id         text NOT NULL,
  gmail_thread_id  text NOT NULL,
  message_id       uuid NOT NULL REFERENCES public.os_ticket_messages(id) ON DELETE CASCADE,
  ticket_id        uuid NOT NULL REFERENCES public.os_tickets(id) ON DELETE CASCADE,
  labels           text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, gmail_id)
);
CREATE INDEX IF NOT EXISTS os_ticket_copies_thread ON public.os_ticket_copies (mailbox, gmail_thread_id);
CREATE INDEX IF NOT EXISTS os_ticket_copies_ticket ON public.os_ticket_copies (ticket_id);
CREATE INDEX IF NOT EXISTS os_ticket_copies_message ON public.os_ticket_copies (message_id);

-- The ticket's timeline besides the emails: notes, status, assignment, snooze, client changes.
CREATE TABLE IF NOT EXISTS public.os_ticket_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES public.os_tickets(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('note', 'status', 'assign', 'snooze', 'created', 'reopened', 'client', 'gmail')),
  actor       citext,
  body        text,
  mentions    citext[] NOT NULL DEFAULT '{}',
  from_value  text,
  to_value    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz
);
CREATE INDEX IF NOT EXISTS os_ticket_events_ticket ON public.os_ticket_events (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS os_ticket_events_mentions ON public.os_ticket_events USING gin (mentions);

-- When each teammate last looked at a ticket (bold rows for what's new to you).
CREATE TABLE IF NOT EXISTS public.os_ticket_reads (
  ticket_id  uuid NOT NULL REFERENCES public.os_tickets(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, email)
);

-- Conversations someone removed from Tickets: never imported again ('msg:<Message-ID>' or 'thread:<mailbox>:<id>').
CREATE TABLE IF NOT EXISTS public.os_ticket_blocks (
  key         text PRIMARY KEY,
  removed_by  citext,
  removed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.os_ticket_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_tickets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_ticket_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_ticket_copies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_ticket_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_ticket_reads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_ticket_blocks    ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
