-- 0052 — the Demo Portal's sample campaigns, for the portal's Campaigns page (17 Nov 2026).
--
-- Run once in the Master Inbox database (Supabase → SQL editor). Safe to run
-- again. It adds one new, empty table; nothing existing is changed, and no
-- real client's portal or campaign reads or writes it.
--
-- On the new client portal, Campaigns is where a client edits the emails of
-- their campaigns (Eddy and Amy, 16 Nov). A real client's campaigns are their
-- EmailBison campaigns, edited there directly. The Demo Portal has none, so
-- its sample campaigns are kept here: each one's steps as EmailBison holds
-- them (subject, body, order, wait, A/B versions, replies in the thread) and
-- how many emails each step has "sent". The rows are made the first time the
-- Demo Portal's Campaigns page opens; only the Demo Portal ever writes here
-- (lib/crm-preview/campaigns.ts). Nothing here is ever sent to anyone.

CREATE TABLE IF NOT EXISTS public.os_demo_campaigns (
  portal_id    uuid        NOT NULL,
  campaign_id  text        NOT NULL,
  name         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active',
  steps        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sent         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (portal_id, campaign_id)
);

ALTER TABLE public.os_demo_campaigns ENABLE ROW LEVEL SECURITY;

-- The OS reads and writes it with the service key; tell the API it exists.
NOTIFY pgrst, 'reload schema';
