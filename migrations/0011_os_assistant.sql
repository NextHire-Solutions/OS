-- ===========================================================================
-- 0011_os_assistant — the cross-product assistant: stored chats, and the
--                     client identity map that makes a cross-product answer
--                     possible at all.
--
-- WHY AN IDENTITY MAP IS THE FIRST THING BUILT
--
-- "Which client is performing badly" spans four databases that each keep their
-- own client list, and they do NOT agree:
--
--   Master Inbox   clients                59 rows   the canonical roster
--   Analytics      clients.portal_client_id         50/50 resolve — a real FK
--   Client Health  clients.masterinbox_identifier   48/49 by name
--   Agent Search   orch_clients                     32/42 by name ONLY
--
-- That last row is the problem this table exists for. Agent Search's
-- `db_client_id` is NULL on every one of its 42 rows, so the only join left is
-- the name — and the names differ: "Howe Realty" there is "Howe Realty Group"
-- here, "JPAR Ironhorse" is "JPAR Iron Horse". Ten of forty-two miss.
--
-- A miss is not a visible error. Asked "what did we scrape for Howe Realty",
-- a name-only lookup finds nothing and answers "no scrapes" — confidently,
-- and wrongly. An alias row is how a human says "these two names are one
-- client" once, instead of the assistant guessing every time.
--
-- FUZZY MATCHING IS DELIBERATELY NOT THE ANSWER. "Rise Realty Of Florida LLC"
-- and "Rise Loan Officers" share a word and are different companies; a
-- similarity score confident enough to join those is confident enough to join
-- things that must never be joined. So: exact alias rows, entered on purpose.
--
-- SAFETY
--   · three new os_-prefixed tables; touches nothing Master Inbox owns
--   · no client, thread, campaign or portal row is read or written here
--
-- ROLLBACK
--   drop table if exists public.os_assistant_messages;
--   drop table if exists public.os_assistant_chats;
--   drop table if exists public.os_client_aliases;
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The identity map.
--
-- `client_id` is the Master Inbox clients.id — the canonical roster. Not a
-- foreign key: this table lives in the OS's own namespace and Master Inbox's
-- table is not ours to constrain, which is the same rule os_clients follows.
--
-- UUID, not bigint. All four products key clients with a uuid, and an earlier
-- draft of the resolver typed them as numbers: Number("<uuid>") is NaN, Map
-- compares NaN keys as EQUAL, so all 59 clients collapsed into one entry and
-- the coverage report read a confident, meaningless 59/59.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.os_client_aliases (
  id           BIGSERIAL PRIMARY KEY,
  -- A uuid: every one of the four products keys its clients with one.
  client_id    UUID         NOT NULL,
  -- Which product speaks this name: 'agent_search', 'analytics', 'client_health'.
  source       TEXT         NOT NULL,
  -- The name AS THAT PRODUCT SPELLS IT, lowercased and trimmed on write.
  alias        TEXT         NOT NULL,
  -- Who decided, and when. An alias is a human judgement, so it carries one.
  confirmed_by TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- One meaning per name per product. A name cannot point at two clients.
  CONSTRAINT os_client_aliases_unique UNIQUE (source, alias)
);

CREATE INDEX IF NOT EXISTS os_client_aliases_client
  ON public.os_client_aliases (client_id);

COMMENT ON TABLE public.os_client_aliases IS
  'Names a product uses for a client that differ from the Master Inbox roster. '
  'Entered by a person; never inferred by similarity.';

-- ---------------------------------------------------------------------------
-- Stored chats.
--
-- PER PERSON, not per workspace. The assistant answers across every client's
-- numbers, so one shared pile would mean anyone's question is everyone's
-- history. `user_email` is the identity the session already carries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.os_assistant_chats (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email  TEXT         NOT NULL,
  -- Written from the first question once it is answered, so the sidebar reads
  -- like the conversation rather than "New chat" forever.
  title       TEXT         NOT NULL DEFAULT 'New chat',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Sidebar order and the Today/Yesterday grouping both read this, so it moves
  -- on every message rather than only on creation.
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS os_assistant_chats_recent
  ON public.os_assistant_chats (user_email, updated_at DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- The turns.
--
-- `tool_calls` and `citations` are stored alongside the text on purpose. An
-- answer citing "Client Health, week of 15 Sep — 12 intros" must still say 12
-- when the chat is reopened next month, even though the live figure has moved
-- on. Recomputing on read would quietly rewrite history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.os_assistant_messages (
  id           BIGSERIAL    PRIMARY KEY,
  chat_id      UUID         NOT NULL REFERENCES public.os_assistant_chats(id) ON DELETE CASCADE,
  role         TEXT         NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT         NOT NULL DEFAULT '',
  -- What the model asked for and what came back, for "how do you know that".
  tool_calls   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- [{label, source, period, href}] — what the answer footnotes link to.
  citations    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  tokens_prompt     INTEGER,
  tokens_completion INTEGER,
  error        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS os_assistant_messages_chat
  ON public.os_assistant_messages (chat_id, created_at);

COMMIT;

NOTIFY pgrst, 'reload schema';
