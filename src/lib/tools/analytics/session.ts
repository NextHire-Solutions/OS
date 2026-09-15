import { verifySso, SSO_COOKIE } from "@/lib/bs-auth";

/*
 * Who is acting, for Analytics' audit trail.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * Fourteen of the tool's write routes open with the same seven lines:
 *
 *     const cookieStore = await cookies();
 *     const session = await verifySessionToken(
 *       process.env.AUTH_SECRET ?? "",
 *       cookieStore.get(AUTH_COOKIE)?.value,
 *     );
 *     if (!session?.email) return 401;
 *
 * and the comment beside them in `campaigns/actions/route.ts` says exactly what
 * they are for: *"The proxy already gates this path; reading the session here is
 * for the audit trail, which is worthless if it can't name who acted."*
 *
 * That reason survives the port. `campaign_audit_log.actor` is the only record
 * of who paused a campaign or replaced a sequence, and a port that wrote
 * "system" into every row would destroy it silently.
 *
 * What changes is the cookie. The tool signs `bsa_session` with its own
 * AUTH_SECRET; the workspace signs `bs_sso` with the workspace's. Rather than
 * edit fourteen files into a different shape — and risk one of them losing the
 * 401 — this module exports the SAME TWO NAMES with the same signatures, so the
 * port is a one-line import change per route and the bodies stay verbatim.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COOKIE RATHER THAN THE HEADER
 *
 * `src/proxy.ts` already sets `x-bs-user` on every gated request, which would
 * be cheaper to read. It is not read here on purpose: those headers exist for
 * the SHELL's benefit, and a route that trusted a header would be one Next
 * version away from trusting an inbound one. Verifying the signature is a few
 * microseconds and cannot be spoofed. Same conclusion the tool reached.
 */

/** The workspace's session cookie — `bs_sso`, not the tool's `bsa_session`. */
export const AUTH_COOKIE = SSO_COOKIE;

/**
 * Verifies the workspace session, in the tool's `verifySessionToken` shape.
 *
 * `secret` is accepted and ignored: every call site passes
 * `process.env.AUTH_SECRET ?? ""`, which is the same secret `verifySso` reads,
 * and taking it as an argument keeps the fourteen call sites byte-identical to
 * the tool's. Passing "" — which is what the tool's own routes do when the
 * variable is unset — must never verify anything, so it falls back to the
 * environment rather than to an empty key.
 */
export async function verifySessionToken(
  secret: string,
  token: string | undefined,
): Promise<{ email: string } | null> {
  const key = secret || process.env.AUTH_SECRET || "";
  if (!key || !token) return null;
  const session = await verifySso(key, token);
  return session?.email ? { email: session.email } : null;
}
