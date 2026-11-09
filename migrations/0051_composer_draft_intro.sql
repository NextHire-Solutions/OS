-- 0051 — A reopened introduction still tags the thread Introduction (10 Nov 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. One new, empty column on composer_drafts; no
-- existing row, column, constraint or trigger is changed.
--
-- WHY
--
-- The Introduce button tags a thread "Introduction" once the intro is sent, and
-- that tag puts the agent on the client's portal. Which text the button put in
-- was held only by the open composer: an intro written with Introduce, left, and
-- sent later from the saved draft went out as an ordinary reply, and the thread
-- stayed Interested (Amy, 9 Nov: Isaac Hernandez, FAST Real Estate). The saved
-- draft now keeps it. The rule is unchanged: only the Introduce button tags, and
-- only while what it inserted is still in what's sent.
--
-- The OS works before this is run (drafts save and load without it, as today);
-- a reopened introduction is tagged once it has been.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.composer_drafts
  ADD COLUMN IF NOT EXISTS intro_inserted text
  CHECK (intro_inserted IS NULL OR char_length(intro_inserted) <= 20000);

COMMIT;

NOTIFY pgrst, 'reload schema';
