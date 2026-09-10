import { NextResponse } from "next/server";
import { z } from "zod";

import { getOnboardingSettings } from "@/lib/tools/onboarding/settings-view";
import { cleanStepLabels, setSetting } from "@/lib/tools/onboarding/settings";

/*
 * Onboarding settings — the automation master switch and the step-button names.
 *
 * Both live in `orch_settings`, the same two rows the live orchestrator reads on
 * every webhook and every scheduler tick. Turning automation off here really does
 * stop the orchestrator firing; this is not a workspace-local preference.
 */
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    automationEnabled: z.boolean().optional(),
    stepLabels: z.record(z.string(), z.string().max(80)).optional(),
  })
  .strict()
  .refine((v) => v.automationEnabled !== undefined || v.stepLabels !== undefined, {
    message: "nothing to change",
  });

export async function GET() {
  return NextResponse.json(await getOnboardingSettings());
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    if (parsed.data.automationEnabled !== undefined) {
      await setSetting("automation_enabled", parsed.data.automationEnabled);
    }
    if (parsed.data.stepLabels !== undefined) {
      // Blank captions are dropped rather than stored, so an emptied box restores
      // the default rather than producing a button with no text.
      await setSetting("step_labels", cleanStepLabels(parsed.data.stepLabels));
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
