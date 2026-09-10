import { NextResponse } from "next/server";
import { z } from "zod";

import { deletePerson, updatePerson } from "@/lib/tools/onboarding/people";
import { MAX_PHOTO, ROLES } from "@/lib/tools/onboarding/people-types";

/*
 * One person on the roster.
 *
 * DELETE hides rather than deletes anyone a client is still assigned to, and
 * reports how many — removing them outright would rewrite those clients' history.
 */
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().max(200).optional(),
    photo: z.string().max(MAX_PHOTO).nullable().optional(),
    active: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
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
  const result = await updatePerson(id, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await deletePerson(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
