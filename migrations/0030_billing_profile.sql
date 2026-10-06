-- 0030 — Billing across subscriptions, failed-payment notifications, portal
-- billing blocks, saved views per client, and introduction wording by market
-- or person (client feedback, 6 Oct).
--
-- Additive only: four new tables and one new column with an empty default.
-- Nothing existing changes. Safe to re-run.

BEGIN;

-- 1. Which Stripe subscriptions and customers belong to a client, beyond the
--    one on its record (os_clients.stripe_*). A row with a subscription claims
--    that subscription; a row without one claims the whole customer (every
--    card a client has paid with — "54 Realty LLC (1st Card)" and so on).
--    `excluded` undoes an automatic name match the OS made.
CREATE TABLE IF NOT EXISTS public.os_client_stripe_links (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  os_client_id           uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  stripe_customer_id     text        NOT NULL,
  stripe_subscription_id text,
  excluded               boolean     NOT NULL DEFAULT false,
  note                   text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS os_client_stripe_links_sub
  ON public.os_client_stripe_links (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL AND NOT excluded;
CREATE UNIQUE INDEX IF NOT EXISTS os_client_stripe_links_customer
  ON public.os_client_stripe_links (os_client_id, stripe_customer_id)
  WHERE stripe_subscription_id IS NULL;
ALTER TABLE public.os_client_stripe_links ENABLE ROW LEVEL SECURITY;

-- 2. Notifications shown in the OS (the bell). `ref` makes each event appear
--    once however often it is seen ("invoice:in_123:attempt:2").
CREATE TABLE IF NOT EXISTS public.os_notifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL,
  severity     text        NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title        text        NOT NULL,
  body         text,
  os_client_id uuid        REFERENCES public.os_clients(id) ON DELETE CASCADE,
  ref          text        NOT NULL UNIQUE,
  read_by      text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS os_notifications_created ON public.os_notifications (created_at DESC);
ALTER TABLE public.os_notifications ENABLE ROW LEVEL SECURITY;

-- 3. A client's portal held back for an unpaid invoice (after Stripe's third
--    failed attempt). mode 'dry_run' only records who WOULD be blocked; the
--    portal reads 'blocked' rows only. lifted_at is set when it is paid.
--    mi_client_ids are the client's Master Inbox portal rows, so the portal
--    checks one indexed row per request; pay_url is Stripe's page to pay the
--    invoice, shown on the paused portal.
CREATE TABLE IF NOT EXISTS public.os_portal_blocks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  mi_client_ids text[]      NOT NULL DEFAULT '{}',
  invoice_id    text        NOT NULL,
  mode          text        NOT NULL CHECK (mode IN ('dry_run', 'blocked')),
  reason        text,
  amount        numeric,
  pay_url       text,
  blocked_at    timestamptz NOT NULL DEFAULT now(),
  lifted_at     timestamptz,
  UNIQUE (os_client_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS os_portal_blocks_open ON public.os_portal_blocks (os_client_id) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS os_portal_blocks_portals ON public.os_portal_blocks USING gin (mi_client_ids) WHERE lifted_at IS NULL;
ALTER TABLE public.os_portal_blocks ENABLE ROW LEVEL SECURITY;

-- 4. Which Database saved views (saved_lists) belong to a client, beyond the
--    ones matched by name. `excluded` undoes a name match.
CREATE TABLE IF NOT EXISTS public.os_client_saved_views (
  os_client_id  uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  saved_list_id text        NOT NULL,
  excluded      boolean     NOT NULL DEFAULT false,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (os_client_id, saved_list_id)
);
ALTER TABLE public.os_client_saved_views ENABLE ROW LEVEL SECURITY;

-- 5. Introduction wording by market or person: [{ id, label, places[],
--    people[], text }]. The first variant whose place is in the lead's
--    campaign name (or whose person the lead is routed to) replaces the
--    client's usual introduction for that lead. Empty: as before.
ALTER TABLE public.os_clients ADD COLUMN IF NOT EXISTS intro_variants jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
