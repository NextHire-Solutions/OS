-- 0056 (Hassan's 0055, renumbered at the merge: 0055 is ticket_replies): The area name for each MLS of a client (client request).
--
-- A client covering several MLSs gets a campaign per MLS. {CLIENT_AREA} in that
-- campaign's emails is filled with the area set for its MLS here — edited on the
-- client's Record tab ("Area for each MLS") — e.g. {"MLSPIN": "Greater Boston"}.
-- Keys are the client's MLS codes as os_clients.mls_codes spells them; an MLS
-- with no entry keeps today's behaviour. Empty for every client to begin with.
--
-- Additive: one new column with an empty default. Safe to re-run, and safe to
-- run before or after the code that reads it is deployed (without it, the
-- Record tab says the column is needed and everything else works as before).

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS mls_areas jsonb NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
