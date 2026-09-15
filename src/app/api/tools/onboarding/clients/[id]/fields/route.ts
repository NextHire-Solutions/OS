import { NextResponse } from "next/server";
import { z } from "zod";

import { addClientField } from "@/lib/tools/onboarding/client-fields";
import { FIELD_TYPES } from "@/lib/tools/onboarding/client-field-types";

/*
 * The team's own custom fields on a client — add one.
 *
 * Nothing in the automation reads these: no email template, no lead filter, no
 * connector. That is what makes them safe to add and delete at will, unlike the
 * built-in profile fields above them.
 */
export const dynamic = "force-dynamic";

const postSchema = z
  .object({
    label: z.string().min(1).max(120),
    type: z.enum(FIELD_TYPES),
    // Allowed to be blank: a field can be added before its value is known.
    value: z.string().max(2000).default(""),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const r = await addClientField(id, parsed.data.label, parsed.data.type, parsed.data.value);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, id: r.id });
}
