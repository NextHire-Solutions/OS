-- 0027 — Sign up date, website, Zillow profile and point of contact (1 Oct).
--
-- Eddy asked for these on the client record. Sign up date defaults to the
-- day the client's Stripe customer was created; a value here overrides it.
-- POC is the client's business contact — separate from the people leads are
-- introduced to (contact_name …, 0005/0007).
--
-- Additive: five nullable columns. Safe to re-run.

ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS signup_date date;
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS website     text;
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS zillow_url  text;
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS poc_name    text;
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS poc_email   text;
