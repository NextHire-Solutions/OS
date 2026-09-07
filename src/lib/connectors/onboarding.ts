import "server-only";

import { DEFAULT_POLICY, defineConnector, type MetricsResult } from "./types";
import { classifyReach } from "@/lib/http/classify";
import { NotConfiguredError, UnsupportedError, optionalEnv } from "@/lib/env";

/*
 * Onboarding (the Orchestrator) — Next 15, Supabase-backed.
 *
 * Client intake from Typeform through the 30-step onboarding, coordinating the
 * other tools rather than duplicating them: it pushes clients into Client
 * Health and Master Inbox, and reads replies back.
 *
 * ---------------------------------------------------------------------------
 * NO METRICS YET, AND THAT IS REPORTED HONESTLY
 *
 * Every route it exposes is either a webhook (Typeform, Bison, Stripe,
 * Calendly, Master Inbox) or a cron target. There is no read endpoint a
 * dashboard can ask "how many clients are mid-onboarding?" — that number lives
 * behind its own session, on the Pipeline page.
 *
 * So the card shows reachability and says the rest is unavailable, as an INFO
 * note rather than a warning. Nothing is broken; there is simply nothing
 * published to read. `/api/cron/health-status` is the natural place to add one.
 */

export const onboardingConnector = defineConnector({
  id: "onboarding",
  name: "Onboarding",
  shortName: "Onboarding",
  description: "Client intake and the 30-step onboarding pipeline.",
  baseUrlEnv: "ONBOARDING_URL",
  home: "/",
  deepLinks: [
    { id: "pipeline", label: "Pipeline", path: "/", verified: true, keywords: ["clients", "intake"] },
    { id: "stages", label: "Stages", path: "/stages", verified: true },
    { id: "templates", label: "Templates", path: "/templates", verified: true },
    { id: "settings", label: "Settings", path: "/settings", verified: true },
  ],
  env: { required: ["ONBOARDING_URL"], optional: [] },
  policy: { ...DEFAULT_POLICY },

  /*
   * A 401 means the app is up and correctly refusing us — which is exactly
   * what a healthy, protected app should do to an unauthenticated probe.
   * Treating it as an outage would paint the card red for working properly.
   */
  async reach(ctx) {
    const res = await ctx.http(`${ctx.baseUrl}/`, { timeoutMs: ctx.policy.reachTimeoutMs });
    // classifyReach already treats an auth challenge as "up" — a protected app
    // refusing an anonymous probe is working, not failing.
    return classifyReach(res, ctx.policy.slowMs);
  },

  async metrics(): Promise<MetricsResult> {
    if (!optionalEnv("ONBOARDING_URL")) throw new NotConfiguredError("ONBOARDING_URL");
    throw new UnsupportedError(
      "no read endpoint yet — pipeline counts live behind the app's own session",
    );
  },
});
