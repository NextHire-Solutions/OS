-- 0014 — intentional exceptions: a client that is deliberately NOT in a tool.
--
-- The architecture spec, §17:
--
--     There will be legitimate cases where a client does not need to exist in
--     a particular system... That should be an intentional exception. It
--     should not be because someone forgot to create the client.
--
--     Client exists in master system -> Tool connection = Yes/No
--     If No, there should be a clear reason.
--
-- Without this, the Consistency screen has no way to tell the two apart, and
-- the only options are to report every absence (which trains people to skim
-- past it) or to suppress them with a hard-coded rule (which hides the real
-- ones). A reason written by a person is the difference.
--
-- WHY A TABLE RATHER THAN COLUMNS ON os_clients
--
-- Six tools today and the spec names more coming — CRM, CSM, Commission
-- Tracker (§18). A column per tool would mean a migration every time one is
-- added, and a NULL that means both "no exception" and "tool did not exist
-- yet". A row per (client, tool) says exactly what it means and needs no
-- schema change to cover a new tool.
--
-- ADDITIVE AND REVERSIBLE. Creates one table. Touches no existing row, no
-- existing column, and nothing any tool reads today. Dropping it would lose
-- only the explanations.
--
-- SAFE TO RE-RUN.

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_client_tool_exceptions (
  id            BIGSERIAL PRIMARY KEY,
  -- Not a foreign key, for the same reason os_clients holds none: clients are
  -- never deleted, only churned, so there is no cascade to protect against.
  os_client_id  UUID        NOT NULL,
  tool          TEXT        NOT NULL,
  /*
   * Required, and deliberately not defaulted. An exception with no reason is
   * indistinguishable from the forgetfulness this table exists to rule out —
   * so the database refuses one rather than storing a blank that looks
   * intentional on screen.
   */
  reason        TEXT        NOT NULL CHECK (btrim(reason) <> ''),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who decided. Null when a script did, which is honest rather than
  -- attributing a judgement call to somebody who did not make it.
  created_by    TEXT,

  CONSTRAINT os_client_tool_exceptions_tool_check CHECK (
    tool IN ('master_inbox', 'client_health', 'analytics', 'onboarding', 'database', 'portal')
  )
);

-- One standing exception per client per tool. A second would mean two reasons
-- for the same absence, and no way to tell which is current.
CREATE UNIQUE INDEX IF NOT EXISTS os_client_tool_exceptions_unique
  ON public.os_client_tool_exceptions (os_client_id, tool);

COMMENT ON TABLE public.os_client_tool_exceptions IS
  'Clients deliberately absent from a tool, with the reason. Lets the '
  'Consistency screen tell an intentional exception from a system failure '
  '(architecture spec §17).';

COMMIT;
