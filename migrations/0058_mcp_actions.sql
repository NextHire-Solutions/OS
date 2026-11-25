-- 0058: actions through the Claude connector (25 Nov 2026) — one row per confirmed action.
--
-- The connector can act (inbox labels and snooze, pausing / resuming a client's campaigns) only in two calls: a preview,
-- then a confirmation code (lib/mcp/actions/core.ts). The code's nonce is claimed HERE before the action runs, so a
-- repeated call never acts twice, and the row is the record of who did what through Claude.
--
-- Run once in the Master Inbox database (Supabase, SQL editor). Additive and safe to re-run. Until it is run, every
-- action refuses ("needs migrations/0058_mcp_actions.sql") and nothing changes; the connector's reading is unaffected.

CREATE TABLE IF NOT EXISTS public.os_mcp_actions (
  nonce        text        PRIMARY KEY,
  email        text        NOT NULL,
  action       text        NOT NULL,
  args         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  preview      text        NOT NULL DEFAULT '',
  status       text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS os_mcp_actions_created_idx ON public.os_mcp_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS os_mcp_actions_email_idx ON public.os_mcp_actions (email, created_at DESC);

-- Server only, like every os_* table.
ALTER TABLE public.os_mcp_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.os_mcp_actions FROM anon, authenticated;
GRANT ALL ON public.os_mcp_actions TO service_role;

NOTIFY pgrst, 'reload schema';
