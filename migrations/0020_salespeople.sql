-- 0020 — Salespeople: who sold each client, and what they earn.
--
-- A record kept "just for our records" under Team access. A salesperson does
-- not need to sign in; one who does (an email that matches their Team access
-- sign-in) sees their own commissions and nobody else's.
--
-- Commissions are earned by the client's Salesperson (os_clients.salesperson
-- holds the name, exactly as it always has), at that salesperson's rates:
-- 70% of the first month, then a residual of 15% or 25%.
--
-- Additive: one new table, nothing existing is altered. Safe to re-run.
-- os_commission_reps (0019) is no longer read and is left in place.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS public.os_salespeople (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The name the client record shows and every tool mirrors. Unique ignoring
  -- case, so "Ryan" and "RYan" cannot both exist.
  name            citext       NOT NULL UNIQUE CHECK (btrim(name::text) <> '' AND position(',' in name::text) = 0),
  -- Optional. Set it to the salesperson's sign-in email to let them see their
  -- own commissions.
  email           citext       UNIQUE CHECK (email IS NULL OR position('@' in email::text) > 1),
  active          boolean      NOT NULL DEFAULT true,
  month_one_rate  numeric(5,4) NOT NULL DEFAULT 0.70 CHECK (month_one_rate >= 0 AND month_one_rate <= 1),
  residual_rate   numeric(5,4) NOT NULL DEFAULT 0.15 CHECK (residual_rate >= 0 AND residual_rate <= 1),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  updated_by      text
);

-- The three salespeople named in the client data sheet, as Onboarding already
-- knows them. Anyone else is added on Team access → Salespeople.
INSERT INTO public.os_salespeople (name) VALUES
  ('Ryan Jagdeo'), ('Scott Craigue'), ('Eddy')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.os_salespeople ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all except the service role, like os_users.

COMMIT;
