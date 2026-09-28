-- 0019 — Commissions: each account manager's rates, and a monthly gross for
-- clients that are not linked to Stripe.
--
-- Everything else Commissions shows is derived, not stored:
--   who earns        the client's Account Manager (os_clients.account_manager,
--                    a Team access member)
--   what came in     paid Stripe invoices on the client's subscription
--                    (os_clients.stripe_subscription_id)
--   when it is paid  the next payout run (1st / 15th) after the payment
--
-- Additive: two new tables, nothing existing is altered. Safe to re-run.
-- Until it is run, the Commissions page still works — default rates (70% /
-- 15%) and Stripe clients only — and says that settings cannot be saved.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- One row per account manager whose rates differ from the default.
CREATE TABLE IF NOT EXISTS public.os_commission_reps (
  email           citext       PRIMARY KEY,
  month_one_rate  numeric(5,4) NOT NULL DEFAULT 0.70 CHECK (month_one_rate >= 0 AND month_one_rate <= 1),
  residual_rate   numeric(5,4) NOT NULL DEFAULT 0.15 CHECK (residual_rate >= 0 AND residual_rate <= 1),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  updated_by      text
);

-- A client's gross per 28 days, for a client with no Stripe subscription
-- linked. Payments are then ESTIMATED on its billing schedule and shown as
-- estimates. A linked client's real Stripe payments always win over this.
CREATE TABLE IF NOT EXISTS public.os_client_commission (
  client_id       uuid          PRIMARY KEY REFERENCES public.os_clients(id) ON DELETE CASCADE,
  monthly_gross   numeric(12,2) NOT NULL CHECK (monthly_gross >= 0),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  updated_by      text
);

ALTER TABLE public.os_commission_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.os_client_commission ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all except the service role, like os_users.

COMMIT;
