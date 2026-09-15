import { NextResponse } from "next/server";

import { runOnboarding } from "@/lib/clients/onboard-run";
import { LEGS, type Leg, type OnboardInput } from "@/lib/clients/onboard-plan";

/*
 * Run an onboarding for real.
 *
 * A SEPARATE ROUTE from the dry run, deliberately. The preview route has no
 * flag that makes it execute, because a dry run that becomes a real run by
 * flipping one argument is a dry run nobody trusts.
 *
 * Two guards on top of the ones in runOnboarding():
 *
 *   · `confirm` must equal the client's name, typed back. Not a checkbox — a
 *     checkbox is one stray click, and the last leg publishes a live portal
 *     URL for whatever name is in the body.
 *   · `stopBefore` lets the irreversible leg be held back, which is how this
 *     is exercised end to end without putting an address into the world.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const { osClientId, confirm, stopBefore, ...rest } = (body ?? {}) as Record<string, unknown>;
  const input = rest as unknown as OnboardInput;

  if (typeof osClientId !== "string" || !osClientId) {
    return NextResponse.json({ error: "osClientId is required" }, { status: 400 });
  }
  if (typeof confirm !== "string" || confirm.trim() !== String(input.name ?? "").trim()) {
    return NextResponse.json(
      { error: "confirm must repeat the client's name exactly" },
      { status: 400 },
    );
  }
  if (stopBefore !== undefined && !LEGS.includes(stopBefore as Leg)) {
    return NextResponse.json({ error: `stopBefore must be one of ${LEGS.join(", ")}` }, { status: 400 });
  }

  try {
    const result = await runOnboarding(osClientId, input, { stopBefore: stopBefore as Leg | undefined });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    console.error("[api/workspace/clients/onboard/execute]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Onboarding failed" },
      { status: 500 },
    );
  }
}
