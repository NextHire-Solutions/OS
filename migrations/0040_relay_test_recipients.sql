-- 0040 — the brokerage hand-off's TEST address(es) (23 Oct 2026).
--
-- Run once in the Master Inbox database (Supabase → SQL editor). Safe to run
-- again. It adds one empty column; nothing is updated, dropped or re-defaulted,
-- and until someone saves an address the tests keep going to
-- admin@outreachify.io, exactly as today.
--
-- Set on Inbox → Settings → Brokerage hand-off → "Test with our own address".
-- Tests only (a sample, or a TEST copy of a prepared hand-off): never a
-- brokerage, never an agent. The OS checks every address when it is saved AND
-- again at every send: our own domains (outreachify.io, brokerstaffer.com) or
-- someone on Team access, never an address on a brokerage's contact list, at
-- most three. Portal sign-in emails are NOT affected — they keep their own
-- fixed test address.

ALTER TABLE public.os_relay_settings ADD COLUMN IF NOT EXISTS test_recipients text[];
