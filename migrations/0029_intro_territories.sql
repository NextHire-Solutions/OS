-- 0029 — Introduce by territory (Jeff Cook, 6 Oct).
--
-- A client with one point of contact per territory wants each lead introduced
-- to that territory's people only. Each person lists the places they cover;
-- a person is introduced when one appears in the lead's campaign name.
--
-- People 1-3: this column, {"1": [...], "2": [...], "3": [...]}.
-- People 4+:  a "territories" list inside their os_clients.more_contacts entry
--             (no schema change).
--
-- Additive: one new column, empty for every client, so every client's
-- introductions stay exactly as they are until someone sets a territory.
-- Safe to re-run.

ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS contact_territories jsonb NOT NULL DEFAULT '{}'::jsonb;
