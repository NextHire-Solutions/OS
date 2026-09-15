import { NextResponse } from "next/server";
import { z } from "zod";

import { planStep, RUNNABLE_KEYS } from "@/lib/tools/onboarding/step-run";
import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";

/*
 * The step buttons.
 *
 * A real press, a real fetch, real auth, real validation, real precondition
 * checks — and then the action itself for the steps that run from the OS:
 * portal, Health Dash, team, lead list, campaign build/launch/pause and the
 * post-approval chain. See `lib/tools/onboarding/step-run.ts` for the list.
 *
 *   200  the step ran; `detail` / `chain` say what it did
 *   400  the step does not exist, or its own precondition fails — the same
 *        sentence the real action would have refused with
 *   404  no such client
 *   501  the step is switched off pending explicit enablement — every
 *        email:* step and payment:link; here is what it would have done
 *   502  the step ran and the external call failed; the delivery log has it
 *
 * `enabled` on the body says whether the OS is allowed to run this step at all,
 * so a caller can tell "off" from "failed".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const postSchema = z
  .object({
    /*
     * Enumerated, not a free string. A step key that is not in the catalogue
     * cannot even reach the planner — the key is what chooses which external
     * service gets called.
     */
    step: z.enum(RUNNABLE_KEYS as [string, ...string[]]),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "unknown step", enabled: false },
      { status: 400 },
    );
  }

  const plan = await planStep(id, parsed.data.step);
  const { status, ...rest } = plan;
  getOnboardingPipeline.invalidate();
  return NextResponse.json({ ...rest, enabled: status !== 501 }, { status });
}
