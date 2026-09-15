import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteClientField, moveClientField, updateClientField } from "@/lib/tools/onboarding/client-fields";
import { FIELD_TYPES } from "@/lib/tools/onboarding/client-field-types";

/*
 * One custom field: edit it, move it, delete it.
 *
 * The client id is in the path AND in every filter underneath, so a field id
 * belonging to another client changes nothing rather than the wrong row.
 */
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    type: z.enum(FIELD_TYPES).optional(),
    value: z.string().max(2000).optional(),
    move: z.enum(["up", "down"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id, fieldId } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const p = parsed.data;

  if (p.move) {
    const moved = await moveClientField(id, fieldId, p.move);
    if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: 400 });
  }

  if (p.label !== undefined || p.type !== undefined || p.value !== undefined) {
    const r = await updateClientField(id, fieldId, { label: p.label, type: p.type, value: p.value });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; fieldId: string }> },
) {
  const { id, fieldId } = await context.params;
  const r = await deleteClientField(id, fieldId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
