import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteStage, moveStage, updateStage } from "@/lib/tools/onboarding/stages";
import { STAGE_COLORS } from "@/lib/tools/onboarding/stage-types";
import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";

/*
 * One stage: rename, recolour, reorder, delete.
 *
 * Gated by the workspace front door — see ../route.ts for why there is no
 * `requireSession()` here.
 */
export const dynamic = "force-dynamic";

/*
 * A move is a PATCH rather than its own endpoint because it is what it looks
 * like: an edit to this stage's position. `.strict()` so a typo in a field name
 * is a 400 rather than a silently ignored no-op.
 */
const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    color: z.enum(STAGE_COLORS).optional(),
    move: z.enum(["up", "down"]).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined || v.move !== undefined, {
    message: "nothing to change",
  });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  if (parsed.data.move) {
    const moved = await moveStage(id, parsed.data.move);
    if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: 400 });
  }

  if (parsed.data.name !== undefined || parsed.data.color !== undefined) {
    const updated = await updateStage(id, { name: parsed.data.name, color: parsed.data.color });
    if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: 400 });
  }

  getOnboardingPipeline.invalidate();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await deleteStage(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  getOnboardingPipeline.invalidate();
  // `moved` is how many clients just became unplaced — the screen says so.
  return NextResponse.json(result);
}
