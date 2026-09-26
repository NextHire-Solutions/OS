-- 0016 — Stripe, on the master client record at last (spec §6, §12, §22).
--
-- §12 asks for one chain: Client -> Billing -> Subscription -> Billing Dates.
-- §6 lists Stripe Customer ID and Stripe Subscription ID as fields of the
-- master record. §22 makes "Stripe is connected to the correct client record" a
-- condition of done. None of it existed.
--
-- WHAT WAS ACTUALLY THERE
--
-- Nothing. `orch_clients` carries seven Stripe columns — stripe_customer_id,
-- subscription_id, stripe_amount, stripe_payment_link_id, stripe_payment_url,
-- stripe_paid_at — and on 27 September 2026 every one of them was empty across
-- all 43 rows. The belief that "Stripe hangs off the onboarding table" was half
-- right: the columns are there, and they have never held anything.
--
-- WHY THE SUBSCRIPTION ID, AND NOT JUST THE CUSTOMER
--
-- Because a Stripe customer is not a client. Measured in the live account:
-- "Douglas Elliman Real Estate" is ONE customer carrying TWO active
-- subscriptions, and there are two Douglas Elliman clients; "Discover Team" is
-- one customer with two subscriptions against two Discover clients. Storing
-- only the customer would make those pairs indistinguishable — the subscription
-- is the thing that belongs to exactly one client.
--
-- Both are nullable and neither is unique-constrained on the customer: two
-- clients legitimately SHARE a customer. The subscription is unique, because a
-- subscription paying for two clients is a billing question nobody has asked
-- for, and if it ever happens the constraint is the right place to find out.
--
-- ADDITIVE AND REVERSIBLE. Two nullable columns and one partial unique index.
-- Touches no existing row or column, and nothing reads them yet.
--
-- SAFE TO RE-RUN.

BEGIN;

ALTER TABLE public.os_clients
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

COMMENT ON COLUMN public.os_clients.stripe_customer_id IS
  'Stripe customer (cus_...). NOT unique: one customer can pay for several '
  'clients — "Douglas Elliman Real Estate" covers two of them.';

COMMENT ON COLUMN public.os_clients.stripe_subscription_id IS
  'Stripe subscription (sub_...). This is the field that identifies WHICH '
  'client is being paid for when a customer carries more than one.';

-- A subscription belongs to one client. Partial, so the 52 nulls do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_os_clients_stripe_subscription
  ON public.os_clients(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_os_clients_stripe_customer
  ON public.os_clients(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMIT;
