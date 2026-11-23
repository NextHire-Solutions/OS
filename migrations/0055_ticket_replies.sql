-- 0055: Replies from Tickets (24 Nov 2026).
--
-- Anyone with the Tickets page can answer a client from the ticket; the reply goes out from the inbox the client
-- wrote to (Amy's or Eddy's only), in the same Gmail conversation. The reply is stored with the ticket, and so is who
-- pressed Send: "Sent as Amy by Eddy". A reply written in Gmail stays a one-line marker, as before (sent_by is null).
--
-- Run once in the Master Inbox database (Supabase, SQL editor), BEFORE the code that uses it is deployed.
-- Additive and safe to re-run: one nullable column and one new table; nothing else changes.

ALTER TABLE public.os_ticket_messages ADD COLUMN IF NOT EXISTS sent_by citext;

COMMENT ON COLUMN public.os_ticket_messages.sent_by IS
  'The teammate who sent this reply from Tickets (the From is the inbox it went out from). Null: written in Gmail, or the client''s own email.';

-- Every send from Tickets, claimed BEFORE Gmail is asked (one row per reply draft): the same draft sent again — a
-- double click, a retry after a lost answer, a deploy restarting the server mid-send — finds its row and never
-- sends a second email. state: sending (claimed; if it stays so, the server stopped mid-send: treated as "may have
-- gone"), sent, unsure (Gmail didn't confirm), refused (Gmail refused: nothing went, the draft may be sent again).
CREATE TABLE IF NOT EXISTS public.os_ticket_sends (
  nonce       text PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES public.os_tickets(id) ON DELETE CASCADE,
  mailbox     citext NOT NULL,
  actor       citext NOT NULL,
  state       text NOT NULL CHECK (state IN ('sending', 'sent', 'unsure', 'refused')),
  gmail_id    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.os_ticket_sends ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
