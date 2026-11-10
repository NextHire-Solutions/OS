-- 0047 — "Ask for a person" in the portal's chat: our team replies in the same chat (4 Nov 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: two new tables. No existing row,
-- column, constraint or trigger is changed; nothing the standalone Master Inbox
-- or the portals read is touched.
--
-- WHAT IT IS FOR
--
-- A client presses "Ask for a person" in their portal's chat. Our team hears on
-- Slack with a link; opening it shows the conversation in that portal's chat, and
-- what they type appears in the client's chat and goes to their email (Amy, 4 Nov:
-- "I like number 1; we'd probably have to research the issue from there, anyway";
-- Eddy: "Our reply should reach the client's email as well"). Until now a chat lived
-- only in the browser's open page, so nothing could come back to it. Only a
-- conversation someone asked a person about is kept: what was said up to that
-- moment, and everything after it. Ordinary chats with the assistant still aren't.
-- Code: src/lib/portal-chat/.
--
-- RUN IT BEFORE the OS deploy that reads these tables.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. One conversation with our team: one person, on one portal.
CREATE TABLE IF NOT EXISTS public.os_portal_chat_threads (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The portal (Master Inbox `clients`): a portal deleted takes its conversations with it.
  portal_id       uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_email    text        NOT NULL,
  client_name     text,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by       text,
  closed_at       timestamptz,
  -- When the client last saw it: any reply from our team after this is unread.
  client_read_at  timestamptz,
  -- When our team was last told on Slack. NULL: not told yet — nobody is shown it or can write to it, and pressing
  -- again tries again.
  last_alert_at   timestamptz,
  -- The press that is telling our team right now (set while it posts to Slack; last_alert_at only once the post has
  -- gone). A second press waits for it; one left behind by a press that never finished is taken over after a minute.
  alert_claimed_at timestamptz,
  -- Our own team pressing it, or the Demo Portal: said so on Slack, so nobody calls a client about it.
  test            boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One open conversation per person per portal: two presses at once can't make two.
CREATE UNIQUE INDEX IF NOT EXISTS os_portal_chat_one_open ON public.os_portal_chat_threads (portal_id, client_email) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS os_portal_chat_threads_portal ON public.os_portal_chat_threads (portal_id, status, created_at DESC);
ALTER TABLE public.os_portal_chat_threads ENABLE ROW LEVEL SECURITY;

-- 2. What was said, in order.
CREATE TABLE IF NOT EXISTS public.os_portal_chat_messages (
  id            bigserial   PRIMARY KEY,
  thread_id     uuid        NOT NULL REFERENCES public.os_portal_chat_threads(id) ON DELETE CASCADE,
  -- client, assistant (what the chat's assistant said before they asked), team (our team), note (the chat's own "we'll get back to you").
  role          text        NOT NULL CHECK (role IN ('client', 'assistant', 'team', 'note')),
  text          text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  -- Our team's: the name the client sees, and who it really was (never shown to a client).
  sender_name   text,
  sender_email  text,
  -- A reply from our team: when it went to the client's email. NULL: it didn't (shown to our team, never the client).
  emailed_at    timestamptz,
  -- The sender's own key for this one message: sent again after a timeout, it's saved — and emailed — once.
  client_key    text CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 8 AND 64),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS os_portal_chat_messages_thread ON public.os_portal_chat_messages (thread_id, id);
-- 3. Columns added on 9 Nov, for a database that ran this file before them (CREATE TABLE IF NOT EXISTS skips a table
-- that's already there). Nothing happens where they exist.
ALTER TABLE public.os_portal_chat_threads ADD COLUMN IF NOT EXISTS alert_claimed_at timestamptz;
ALTER TABLE public.os_portal_chat_messages ADD COLUMN IF NOT EXISTS client_key text CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 8 AND 64);
CREATE UNIQUE INDEX IF NOT EXISTS os_portal_chat_messages_once ON public.os_portal_chat_messages (thread_id, client_key) WHERE client_key IS NOT NULL;
ALTER TABLE public.os_portal_chat_messages ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
