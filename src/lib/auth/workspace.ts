import "server-only";

import { cache } from "react";

import { headers } from "next/headers";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { workspaceId } from "@/lib/tools/master-inbox/supabase";

/*
 * `requireSession()` — the shim the copied Master Inbox code calls 47 times.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ORIGINAL DID
 *
 * Verified a Supabase JWT with `auth.getUser()`, redirected to /login if it was
 * missing, and returned the user plus the single workspace. Everything after
 * that ran under RLS as that user.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS HERE INSTEAD
 *
 * The OS authenticates at its own front door — an HMAC-signed cookie checked in
 * `proxy.ts` before any of this code is reachable. By the time a route calls
 * `requireSession()`, the caller is already known to be a signed-in member of
 * staff. So this does not re-authenticate; it answers the two questions the
 * copied code actually asks.
 *
 * Only two fields are ever read across all 47 call sites — checked, not
 * assumed:
 *
 *     session.activeWorkspace.id   42 uses
 *     session.user.id               5 uses
 *
 * ---------------------------------------------------------------------------
 * WHY `user.id` IS NULL, AND WHY THAT IS THE CORRECT ANSWER
 *
 * All five uses insert into a column that is a foreign key into `auth.users`:
 * `lists.owner_user_id`, `custom_views.owner_user_id`,
 * `label_assignments.assigned_user_id`, `reminders.user_id`.
 *
 * OS users do not exist in `auth.users`. Inventing a UUID would violate the
 * foreign key and the insert would fail at runtime — a build-clean feature that
 * breaks the first time somebody uses it.
 *
 * Null is not a workaround. All four columns are nullable (confirmed against
 * the live PostgREST schema, not inferred from sample rows), and the tool
 * already stores null in most of them — 176 of 200 label assignments, 25 of 55
 * lists, 11 of 15 custom views. A row written by the OS is therefore
 * indistinguishable from one the tool wrote, which is the property that
 * matters while both can write the same database.
 *
 * The cost is honest and worth stating: per-user attribution on those four
 * columns. Nothing in the UI reads them today. If attribution is wanted later,
 * the fix is a real `auth.users` row per OS user, not a fabricated id here.
 */

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
}

export interface SessionContext {
  user: {
    id: string | null;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
  };
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary;
}

/*
 * `cache` for the same reason the original used it: a single render can call
 * this from a page, a layout and three components, and without it each one
 * re-runs the workspace lookup.
 */
export const requireSession = cache(async function requireSession(): Promise<SessionContext> {
  // Throws if a second workspace ever appears. That is deliberate — every
  // service-role query in the copied code is scoped by this id, so the moment
  // "the workspace" becomes ambiguous the app must stop rather than guess.
  const id = await workspaceId();

  const summary: WorkspaceSummary = {
    id,
    name: "BrokerStaffer",
    slug: "brokerstaffer",
    role: "owner",
  };

  return {
    /*
     * `id` stays null on purpose — see the note above: these columns are
     * foreign keys into `auth.users`, OS users have no row there, and a
     * fabricated UUID fails the constraint on insert.
     *
     * `email` is NOT null, and the difference matters. It was null here
     * originally, and because `isSuperAdmin()` returns false for a null
     * address, that silently disabled every super-admin gate in the app for
     * EVERY user, whatever `SUPER_ADMIN_EMAILS` contained. The Members tab —
     * the entire invite / reset-password admin panel — was unreachable by
     * anybody, and Personal rendered an empty email box. Nothing errored; the
     * UI simply behaved as though nobody qualified.
     *
     * The OS does know who is calling: `proxy.ts` has already verified the
     * signed `bs_sso` cookie before any of this is reachable. Reading the
     * address from that cookie answers what the call sites are actually
     * asking, from the only authority here that can answer it.
     */
    user: { id: null, email: await signedInEmail(), name: null, avatar_url: null },
    workspaces: [summary],
    activeWorkspace: summary,
  };
});

/*
 * The signed-in address, read from the same cookie `proxy.ts` already verified.
 *
 * Returns null rather than throwing when there is no request scope at all — a
 * build, a cron, a script. "No request" genuinely means "no signed-in user",
 * which is the correct answer for a gate rather than an error to propagate.
 */
async function signedInEmail(): Promise<string | null> {
  try {
    const session = await verifySso(
      process.env.AUTH_SECRET ?? "",
      readSsoCookie((await headers()).get("cookie")),
    );
    return session?.email ?? null;
  } catch {
    return null;
  }
}
