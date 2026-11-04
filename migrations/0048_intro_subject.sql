-- 0048: A client's own introduction subject (5 Nov).
--
-- The Introduce button and the reply agent's handover build one subject for
-- every client: "Intro: {lead first name} & {brokerage}". This column holds a
-- client's own, edited on the client's record (Clients, the client, Introduce
-- to). NULL, every client today, keeps the standard subject.
--
-- Additive: one new nullable column. Safe to re-run, and safe to run before or
-- after the code that reads it is deployed.

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS intro_subject text;

NOTIFY pgrst, 'reload schema';
