-- 0037 — Client sign-in for the new portal: a fixed list, a link by email (21 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: three new tables. No existing
-- row, column, constraint or trigger is changed; today's portals (opened by
-- their link) are not touched and keep working exactly as before.
--
-- WHAT IT IS FOR
--
-- The user, 21 Oct: "enter email and then a button saying send link to login.
-- but we have to make sure client cannot enter any email and can login. there
-- should a fixed email address that is allowed to login." So:
--
--   os_portal_logins        the fixed list — which addresses may sign in to
--                           which portal. Kept by the people with the Client
--                           Portals switch in the OS. An address not on it
--                           never gets a link (and is never told so).
--   os_portal_login_tokens  one sign-in email each: a one-time link and a
--                           6-digit code (the code is the backup for company
--                           mail scanners that open links), valid 15 minutes.
--                           Only their hashes are stored.
--   os_portal_sessions      a signed-in browser: 30 days (the user's choice),
--                           ended at once when the address leaves the list.
--
-- WHAT RUNNING IT SWITCHES ON
--
-- Nothing. Sign-in stays off until the new portal is launched for clients.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- 1. Who may sign in, to which portal (portal = a Master Inbox clients row).
CREATE TABLE IF NOT EXISTS public.os_portal_logins (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_id        uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  email            citext      NOT NULL,
  name             text,
  added_by         text        NOT NULL,
  added_at         timestamptz NOT NULL DEFAULT now(),
  -- Removing an address keeps the row (who had access, until when); it can no longer sign in.
  removed_at       timestamptz,
  removed_by       text,
  last_sign_in_at  timestamptz,
  UNIQUE (portal_id, email)
);
CREATE INDEX IF NOT EXISTS os_portal_logins_email_idx ON public.os_portal_logins (email) WHERE removed_at IS NULL;
ALTER TABLE public.os_portal_logins ENABLE ROW LEVEL SECURITY;

-- 2. One sign-in email: a link and a code, hashed; single use; 15 minutes.
CREATE TABLE IF NOT EXISTS public.os_portal_login_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext      NOT NULL,
  link_hash     text        NOT NULL UNIQUE,
  code_hash     text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  -- Wrong codes against this email; past the limit the code stops working.
  attempts      integer     NOT NULL DEFAULT 0,
  requested_ip  text
);
CREATE INDEX IF NOT EXISTS os_portal_login_tokens_email_idx ON public.os_portal_login_tokens (email, created_at DESC);
ALTER TABLE public.os_portal_login_tokens ENABLE ROW LEVEL SECURITY;

-- 3. A signed-in browser. Only the hash of its secret is stored.
CREATE TABLE IF NOT EXISTS public.os_portal_sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext      NOT NULL,
  secret_hash   text        NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  user_agent    text,
  ip            text
);
CREATE INDEX IF NOT EXISTS os_portal_sessions_email_idx ON public.os_portal_sessions (email) WHERE revoked_at IS NULL;
ALTER TABLE public.os_portal_sessions ENABLE ROW LEVEL SECURITY;

COMMIT;
