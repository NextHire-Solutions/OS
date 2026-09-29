-- 0021 — Team roles: every person on Team access can be an Admin, an Account
-- Manager and/or a Salesperson, set and edited on Team access (30 Sep).
--
--   is_admin            an admin, as well as the owners in ADMIN_EMAILS (who
--                       stay admins whatever this says, so an owner can never
--                       be locked out from the screen)
--   is_account_manager  can be chosen as a client's Account Manager, and earns
--                       commission as one
--   Salesperson         lives on os_salespeople (0020), linked by email, so a
--                       salesperson's clients and rates are kept when they are
--                       invited. Ryan Jagdeo and Scott Craigue stay there until
--                       they are invited.
--
-- Additive: two columns with safe defaults. Safe to re-run.

BEGIN;

ALTER TABLE public.os_users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE public.os_users ADD COLUMN IF NOT EXISTS is_account_manager boolean NOT NULL DEFAULT false;

-- Today's account managers, as the client data sheet names them.
UPDATE public.os_users SET is_account_manager = true WHERE lower(name) IN ('amy', 'eddy');

-- Eddy also sells: link his salesperson record to his sign-in.
UPDATE public.os_salespeople s SET email = u.email
  FROM public.os_users u
 WHERE lower(u.name) = 'eddy' AND lower(s.name::text) = 'eddy' AND s.email IS NULL;

COMMIT;
