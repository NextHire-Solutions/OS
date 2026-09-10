import "server-only";

import { headers } from "next/headers";

import { hasGrant, readSsoCookie, verifySso } from "@/lib/bs-auth";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

/*
 * A shim, so the Master Inbox's own code runs here unmodified.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHIM RATHER THAN EDITS AT EVERY CALL SITE
 *
 * The tool's routes and loaders all reach the database through
 * `createServerSupabase()`. Rewriting each call site would work exactly once:
 * the next time a file is copied across it breaks again, and the diff against
 * the original stops being readable — which is most of why copying was worth
 * doing.
 *
 * Providing the module the original code already imports means those files
 * stay byte-identical to the tool's, and a future copy needs no edits at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGES BEHIND THIS NAME — READ BEFORE USING IT
 *
 * In the tool this returns an ANON client carrying the signed-in user's cookie,
 * so every query is filtered by RLS: policies resolve
 * `is_workspace_member(workspace_id)` through `auth.uid()`, and a query that
 * forgets its workspace filter returns that user's rows rather than everyone's.
 *
 * Here it returns a SERVICE-ROLE client, because the OS authenticates users
 * itself and has no Supabase session to present. Service-role bypasses RLS.
 *
 *   The consequence, stated plainly: a query that omits
 *   `.eq("workspace_id", …)` returns EVERY workspace's rows instead of none.
 *
 * That is safe today for one specific reason rather than by luck: BrokerStaffer
 * is single-tenant, and `workspaceId()` throws if a second workspace ever
 * appears — so the day the assumption stops holding, the app stops rather than
 * leaks. The tool's own queries carry the filter anyway; it was single-tenant
 * there too.
 *
 * ---------------------------------------------------------------------------
 * THE `auth.getUser()` ADAPTER, AND WHY IT IS NOT A LIE
 *
 * 23 copied route files gate themselves like this:
 *
 *     const { data: { user } } = await supabase.auth.getUser();
 *     if (!user) return NextResponse.json({ error: "…" }, { status: 401 });
 *
 * With a service-role client that call resolves to `user: null` every single
 * time, so all 23 returned 401 to everybody. That is not a hypothetical: it is
 * how `/clients`, `/clients/portals` and `/clients/intro-stats` were found
 * dead during testing, and it is the exact failure mode of copying code and
 * not exercising it.
 *
 * The question those lines are asking is "is the caller a signed-in member of
 * staff?" — and the OS has a true answer to that; it simply lives somewhere
 * else. `proxy.ts` verifies the signed `bs_sso` cookie before any of this is
 * reachable. So this adapter answers the question the code is asking, from the
 * authority that actually knows, rather than from a Supabase session that will
 * never exist here.
 *
 * Two things it deliberately does NOT do:
 *
 *   IT DOES NOT INVENT AN ID. `id` is null, for the reason set out in full in
 *   `src/lib/auth/workspace.ts`: the columns it would feed are foreign keys
 *   into `auth.users`, OS users have no row there, and a fabricated UUID would
 *   fail the constraint on insert. Every one of those columns is nullable and
 *   the tool already stores null in most of them.
 *
 *   IT DOES NOT WAVE EVERYONE THROUGH. A caller without a valid cookie, or
 *   without the `inbox` grant, still gets `user: null` — and every one of those
 *   23 gates then returns its own 401, unchanged.
 */

/** The OS's answer to "who is calling", shaped the way Supabase's client returns it. */
async function currentUser(): Promise<{ id: null; email: string } | null> {
  try {
    const session = await verifySso(
      process.env.AUTH_SECRET ?? "",
      readSsoCookie((await headers()).get("cookie")),
    );
    if (!session) return null;
    // The grant check belongs here rather than at 23 call sites: this is the
    // one place that claims to know who the caller is.
    if (!hasGrant(session, "inbox")) return null;
    return { id: null, email: session.email };
  } catch {
    // `headers()` throws outside a request scope — a cron, a script, a build.
    // No request means no user, which is the correct answer, not an error.
    return null;
  }
}

export async function createServerSupabase() {
  const client = getMasterInboxSupabase();

  /*
   * A Proxy rather than a mutation, because `getMasterInboxSupabase()` returns
   * a shared singleton — assigning onto `client.auth` would change the client
   * that every service-role caller in the app is holding, including the ones
   * that must stay anonymous.
   */
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "auth") return Reflect.get(target, prop, receiver);

      const auth = Reflect.get(target, prop, receiver) as unknown as Record<string, unknown>;
      return new Proxy(auth, {
        get(authTarget, authProp, authReceiver) {
          if (authProp !== "getUser") return Reflect.get(authTarget, authProp, authReceiver);
          return async () => ({ data: { user: await currentUser() }, error: null });
        },
      });
    },
  }) as typeof client;
}
