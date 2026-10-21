-- 0038 — How much each person (and each client) reads from the new portal (21 Oct 2026)
--
-- RUN THIS IN THE MASTER INBOX SUPABASE PROJECT (where os_clients lives).
-- Safe to run more than once. Purely additive: one new table and one new
-- function. Nothing existing is changed.
--
-- WHAT IT IS FOR
--
-- The user, 17 Oct: "no one should be able to extract data from this new
-- client portals". And 21 Oct: "we should not pause any funtionality in the
-- client portal. just alert in OS should work". So nothing here stops anyone:
-- use is counted in the database (a restart no longer resets it), and the OS
-- tells our team about heavy or automated-looking use.
--
--   os_portal_usage      per day, per person, per portal, per kind (market
--                        rows, reports, chats …): requests and rows served.
--   os_portal_usage_add  adds one request's numbers and returns the day's
--                        totals for the person and for the whole portal, in
--                        one atomic step (two requests at once both count).

BEGIN;

CREATE TABLE IF NOT EXISTS public.os_portal_usage (
  day         date        NOT NULL,
  who         citext      NOT NULL,
  portal_id   uuid        NOT NULL,
  kind        text        NOT NULL,
  requests    integer     NOT NULL DEFAULT 0,
  rows        integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, who, portal_id, kind)
);
CREATE INDEX IF NOT EXISTS os_portal_usage_portal_idx ON public.os_portal_usage (day, portal_id, kind);
ALTER TABLE public.os_portal_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.os_portal_usage_add(p_day date, p_who text, p_portal uuid, p_kind text, p_requests integer, p_rows integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  person jsonb;
  portal jsonb;
BEGIN
  INSERT INTO public.os_portal_usage (day, who, portal_id, kind, requests, rows)
  VALUES (p_day, lower(p_who), p_portal, p_kind, greatest(p_requests, 0), greatest(p_rows, 0))
  ON CONFLICT (day, who, portal_id, kind) DO UPDATE
    SET requests = public.os_portal_usage.requests + excluded.requests,
        rows = public.os_portal_usage.rows + excluded.rows,
        updated_at = now();
  SELECT jsonb_build_object('requests', coalesce(sum(u.requests), 0), 'rows', coalesce(sum(u.rows), 0)) INTO person
    FROM public.os_portal_usage u WHERE u.day = p_day AND u.who = lower(p_who) AND u.kind = p_kind;
  SELECT jsonb_build_object('requests', coalesce(sum(u.requests), 0), 'rows', coalesce(sum(u.rows), 0)) INTO portal
    FROM public.os_portal_usage u WHERE u.day = p_day AND u.portal_id = p_portal AND u.kind = p_kind;
  RETURN jsonb_build_object('person', person, 'portal', portal);
END;
$$;
REVOKE ALL ON FUNCTION public.os_portal_usage_add(date, text, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.os_portal_usage_add(date, text, uuid, text, integer, integer) TO service_role;

COMMIT;
