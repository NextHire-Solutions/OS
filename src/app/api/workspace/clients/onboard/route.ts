import { NextResponse } from "next/server";

import { planOnboarding, type OnboardInput } from "@/lib/clients/onboard-plan";

/*
 * What onboarding a client WOULD send to each tool.
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE SENDS NOTHING
 *
 * It builds the three requests and returns them. Nothing is contacted, nothing
 * is created, and there is no flag on it that makes it execute — running the
 * plan will be a separate route, added deliberately, so that it is impossible
 * to onboard a client by accident from here.
 *
 * The reason is the third leg: Master Inbox's insert mints a `portal_token`
 * that is live and login-free the moment it exists. A mistake there is not a
 * bad row, it is a wrong URL in a customer's hands.
 *
 * The returned plan describes its auth by the NAME of each secret, never its
 * value, so it is safe to render on screen.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const input = (body ?? {}) as Partial<OnboardInput>;
  const plan = planOnboarding({
    name: String(input.name ?? ""),
    plan: input.plan as OnboardInput["plan"],
    weeklyTarget: Number(input.weeklyTarget),
    aliases: Array.isArray(input.aliases) ? input.aliases.map(String) : undefined,
    startDate: input.startDate ? String(input.startDate) : undefined,
    billingAnchorDate: input.billingAnchorDate ? String(input.billingAnchorDate) : undefined,
    billingInterval: input.billingInterval,
    billingIntervalDays:
      input.billingIntervalDays == null ? undefined : Number(input.billingIntervalDays),
    matchMode: input.matchMode,
    introMacro: input.introMacro,
  });

  // 200 even when the plan is invalid: the errors ARE the answer the form
  // wants, and a 400 would make the client treat a perfectly good validation
  // response as a request failure.
  return NextResponse.json({ dryRun: true, plan });
}
