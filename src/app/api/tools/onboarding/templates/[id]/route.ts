import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteTemplate, saveTemplate } from "@/lib/tools/onboarding/templates";

/*
 * One template: save its wording, or delete it.
 *
 * DELETE answers 400 with the tool's own sentence for the nine templates the
 * automation sends by key — see lib/tools/onboarding/templates.ts.
 */
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    // Subject and body may be emptied — a campaign-copy template has no subject,
    // and clearing a body is a legitimate edit. Only `name` has a floor.
    subject: z.string().max(500).optional(),
    body: z.string().max(100_000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const result = await saveTemplate(id, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await deleteTemplate(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
