-- 0043 — Pay per lead: per-client settings and one record per billing period
-- (26 Oct 2026). FIRST VERSION — TEST MODE ONLY.
--
-- NOT RUN. A PERSON MUST RUN THIS, on the user's word, in the MASTER INBOX
-- SUPABASE PROJECT (where os_clients lives), Supabase → SQL editor. Safe to run
-- more than once. Purely additive: two new, empty os_* tables. No existing
-- table, row, column, constraint or trigger is changed; nothing the standalone
-- Master Inbox, the portals or the existing billing (payment links,
-- pause/resume, refunds, the Billing tab) reads is touched.
--
-- WHAT IT IS FOR
--
-- The user, 26 Oct: "for pay per lead work, we do not want to make this live
-- for any of the client right now. we just need to build this and make a way
-- to test this." Instead of a fixed subscription, a client is charged per lead
-- (e.g. $100 or $200 a lead), every 7 or 14 days, automatically, to the card
-- they saved through a Stripe Checkout page. The OS builds one Stripe invoice
-- per client per period with one line per lead, previews it, then finalizes
-- and pays it. Code: src/lib/clients/usage-billing/.
--
-- WHAT RUNNING IT SWITCHES ON
--
-- Nothing. With these tables in place:
--   - No client is billed. A settings row exists only once a person saves one
--     on a client's Billing tab, and every row is test_only = true (the
--     default; the OS has no way to set it false).
--   - The code refuses any Stripe key that is not a TEST key
--     (OS_USAGE_BILLING_STRIPE_KEY must start sk_test_ / rk_test_).
--   - The scheduled run does not exist unless OS_USAGE_BILLING_ENABLED=1 is set
--     on the Railway service, and even then it only records previews unless
--     OS_USAGE_BILLING_CHARGE=1 is set as well.
-- Going live is a deliberate code change the user must approve.

BEGIN;

-- Never wait on a busy os_clients: the new foreign keys briefly lock it
-- against writes. If that lock is not free within 5 seconds, this stops and
-- changes nothing — just run it again.
SET LOCAL lock_timeout = '5s';

-- 1. A client's pay-per-lead settings. No row = not billed per lead.
CREATE TABLE IF NOT EXISTS public.os_usage_billing_settings (
  os_client_id               uuid        PRIMARY KEY REFERENCES public.os_clients(id) ON DELETE CASCADE,
  -- The scheduled run looks only at enabled rows. Off until a person turns it on.
  enabled                    boolean     NOT NULL DEFAULT false,
  -- A TEST client: only ever billed with a Stripe TEST key. The OS never sets
  -- this to false; a live client needs a code change the user approves.
  test_only                  boolean     NOT NULL DEFAULT true,
  -- The price of one lead, in cents ($1 to $10,000).
  price_cents                integer     NOT NULL CHECK (price_cents BETWEEN 100 AND 1000000),
  -- Bill every 7 or every 14 days.
  every_days                 integer     NOT NULL DEFAULT 7 CHECK (every_days IN (7, 14)),
  -- The first day of the first period (a US Eastern calendar day). Periods are
  -- [anchor + k·every_days, anchor + (k+1)·every_days). Nothing before it is billed.
  anchor_date                date        NOT NULL,
  -- What counts as a billable lead (not decided yet — see leads.ts):
  -- 'handoffs' = each Interested reply handed to the brokerage, once per agent;
  -- 'introductions' = each portal entry we made (not the client's own).
  lead_source                text        NOT NULL DEFAULT 'handoffs' CHECK (lead_source IN ('handoffs', 'introductions')),
  -- Stripe (test mode): the customer and the card saved through Checkout.
  stripe_customer_id         text,
  default_payment_method_id  text,
  card_label                 text,
  setup_session_id           text,
  created_by                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 text,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS os_usage_billing_settings_enabled ON public.os_usage_billing_settings (enabled) WHERE enabled;
ALTER TABLE public.os_usage_billing_settings ENABLE ROW LEVEL SECURITY;

-- 2. One row per client per period: the preview, then the invoice. The unique
--    (os_client_id, period_start, test_mode) is the "never twice" guarantee — whichever
--    process claims the row (status preview → draft) bills it; every other one
--    finds it taken, however many servers are running.
CREATE TABLE IF NOT EXISTS public.os_usage_billing_periods (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  os_client_id           uuid        NOT NULL REFERENCES public.os_clients(id) ON DELETE CASCADE,
  period_start           date        NOT NULL,
  -- Exclusive: the next period's first day.
  period_end             date        NOT NULL,
  -- Billed with a Stripe TEST key. Always true in this version.
  test_mode              boolean     NOT NULL DEFAULT true,
  lead_source            text        NOT NULL,
  lead_count             integer     NOT NULL DEFAULT 0,
  price_cents            integer     NOT NULL,
  amount_cents           integer     NOT NULL DEFAULT 0,
  -- The leads billed, as they were when the period was claimed:
  -- [{ "key": "agent@x.com", "name": "Jordan Ellis", "at": "<iso>", "source": "handoff" }]
  leads                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- preview: computed, nothing in Stripe · draft: claimed, invoice being built ·
  -- charged: finalized, payment asked · paid · failed: the card was refused (the
  -- invoice stays open and payable by its link) · void: nothing to bill / voided.
  status                 text        NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'draft', 'charged', 'paid', 'failed', 'void')),
  stripe_invoice_id      text,
  stripe_invoice_number  text,
  hosted_invoice_url     text,
  note                   text,
  error                  text,
  claimed_by             text,
  claimed_at             timestamptz,
  charged_at             timestamptz,
  paid_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- One period per client, kept apart for test and live: a test charge on a
-- real client's period never makes it (or its agents) "already billed" once
-- billing goes live. (A database that ran the first version of this file
-- also has UNIQUE (os_client_id, period_start) — stricter, so still safe;
-- dropping it is a go-live step.)
CREATE UNIQUE INDEX IF NOT EXISTS os_usage_billing_periods_client_period_mode ON public.os_usage_billing_periods (os_client_id, period_start, test_mode);
CREATE INDEX IF NOT EXISTS os_usage_billing_periods_status ON public.os_usage_billing_periods (status, period_start DESC);
CREATE INDEX IF NOT EXISTS os_usage_billing_periods_invoice ON public.os_usage_billing_periods (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
ALTER TABLE public.os_usage_billing_periods ENABLE ROW LEVEL SECURITY;

COMMIT;
