-- 0028 — More than three "Introduce to" people (client ask, 5 Oct).
--
-- People 1–3 stay where they are (contact_*, contact2_*, contact3_* — 0005,
-- 0007), so nothing existing moves and everything that reads them keeps
-- working. People 4 and up live here as an ordered list of
-- {"name": …, "role": …, "email": …}. Up to 10 people in all.
--
-- Additive: one new column defaulting to an empty list. Safe to re-run.

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS more_contacts jsonb NOT NULL DEFAULT '[]'::jsonb;
