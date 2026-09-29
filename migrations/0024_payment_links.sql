-- 0024 — Create a subscription from the OS (30 Sep).
--
-- An admin enters an amount and how often (every 14 days, every 28 days or
-- monthly) on a client's record; the OS creates a Stripe Payment Link for
-- exactly that, payable once. When the client pays, Stripe creates the
-- subscription and the OS links it to the client (os_clients.stripe_*).
-- This table remembers each link until it is paid or cancelled.
--
-- Additive: one new table. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_payment_links (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  stripe_payment_link_id  text        NOT NULL UNIQUE,
  url                     text        NOT NULL,
  amount_cents            integer     NOT NULL CHECK (amount_cents > 0),
  every                   text        NOT NULL CHECK (every IN ('14 days', '28 days', 'month')),
  status                  text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  subscription_id         text,
  customer_id             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              text,
  paid_at                 timestamptz
);

CREATE INDEX IF NOT EXISTS idx_os_payment_links_open ON public.os_payment_links (client_id) WHERE status = 'open';

ALTER TABLE public.os_payment_links ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all except the service role, like os_users.

COMMIT;
