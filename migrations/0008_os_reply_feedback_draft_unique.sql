-- ===========================================================================
-- 0008_os_reply_feedback_draft_unique — make the draft verdict upsertable
--
-- WHAT THIS FIXES
--
-- 0006 gives os_reply_feedback a PARTIAL unique index:
--
--     create unique index os_reply_feedback_draft_idx
--       on public.os_reply_feedback (draft_id) where draft_id is not null;
--
-- which is the right shape for the data and the wrong shape for the code that
-- writes it. Both writers upsert on draft_id — the live capture in
-- lib/tools/master-inbox/ai/feedback.ts, so re-sending a thread cannot file a
-- second verdict for the same draft, and the backfill in feedback-backfill.ts,
-- so judging 12,451 drafts twice updates rather than doubles.
--
-- PostgreSQL will not infer a PARTIAL index from `on conflict (draft_id)`. It
-- needs the predicate repeated — `on conflict (draft_id) where draft_id is not
-- null` — and PostgREST, which is what supabase-js speaks, has no way to send
-- that: `?on_conflict=draft_id` is the entire vocabulary. The write would fail
-- with "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification", and it would fail on every row of the backfill.
--
-- A plain unique index is equivalent here. In PostgreSQL nulls are distinct
-- under a unique index, so `draft_id is null` rows are still unconstrained —
-- exactly what the partial index was expressing — and `on conflict (draft_id)`
-- now resolves.
--
-- WHY A SEPARATE FILE RATHER THAN AN EDIT TO 0006
--
-- So that a database where 0006 has already been applied converges on the same
-- state as one where it has not. Both are idempotent and safe to re-run.
--
-- SAFETY
--   · one index dropped, one created, on a table only the OS reads or writes
--   · no data is read, changed or deleted
--   · nothing outside os_reply_feedback is touched
--
-- ROLLBACK
--   drop index if exists public.os_reply_feedback_draft_key;
--   create unique index if not exists os_reply_feedback_draft_idx
--     on public.os_reply_feedback (draft_id) where draft_id is not null;
-- ===========================================================================

create unique index if not exists os_reply_feedback_draft_key
  on public.os_reply_feedback (draft_id);

drop index if exists public.os_reply_feedback_draft_idx;

comment on index public.os_reply_feedback_draft_key is
  'One verdict per draft. Non-partial so PostgREST''s on_conflict=draft_id can infer it — see migrations/0008.';
