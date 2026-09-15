import "server-only";

import { headers } from "next/headers";

/*
 * Who is actually signed in.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES, WHICH TWO TABS WERE QUIETLY LOSING TO
 *
 * The copied Master Inbox code asks `requireSession()` for the user. That is a
 * shim (src/lib/auth/workspace.ts): the OS has no Supabase user, so it answers
 *
 *     user: { id: null, email: null, name: null, avatar_url: null }
 *
 * and documents exactly why `id` is null. `email` being null is a consequence
 * rather than a decision, and two settings tabs depend on it:
 *
 *   · Personal rendered `defaultValue={session.user.email ?? ""}` — so the
 *     "Your account information" panel showed an EMPTY email box to everybody.
 *
 *   · Members ran `isSuperAdmin(session.user.email)`, which is `false` for
 *     null no matter what `SUPER_ADMIN_EMAILS` says. The invite form, the
 *     workspace picker, the member list and the password reset were therefore
 *     unreachable for every user of this workspace — the whole tab was the
 *     "ask the admin" refusal card, permanently.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ADDRESS COMES FROM INSTEAD
 *
 * `proxy.ts` verifies the signed `bs_sso` cookie on every gated request and
 * writes the address onto `x-bs-user`. `app/[[...slug]]/page.tsx` already reads
 * exactly this header to build the sidebar, and Next strips inbound headers of
 * that name, so a client cannot inject one. This is the same source, read the
 * same way, rather than a second notion of identity.
 *
 * `requireSession()` is left alone deliberately: 47 call sites depend on its
 * shape, and this is the two places that need the address.
 */
export async function signedInEmail(): Promise<string> {
  return (await headers()).get("x-bs-user") ?? "";
}
