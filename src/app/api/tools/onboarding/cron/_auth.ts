import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerAccepted } from "@/lib/tools/onboarding/webhook-auth";

/*
 * The cron routes' gate: `Authorization: Bearer <ONBOARDING_CRON_SECRET>`.
 * Fails CLOSED — no secret, no access. These routes do real work (poll the
 * mailbox, launch a campaign whose leads landed), so an unset variable must
 * not open them to the internet. They run with no workspace session: the proxy
 * must let /api/tools/onboarding/cron/* through, and this is the credential.
 */
export function cronGate(req: Request): NextResponse | null {
  const auth = bearerAccepted(req.headers.get("authorization"), optionalEnv("ONBOARDING_CRON_SECRET"));
  if (auth === "unconfigured") {
    // 503, not 500: the route is deliberately closed until its secret exists,
    // the same answer every other secret-gated receiver in the OS gives.
    return NextResponse.json({ error: "ONBOARDING_CRON_SECRET is not set — cron routes are closed" }, { status: 503 });
  }
  if (auth === "denied") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
