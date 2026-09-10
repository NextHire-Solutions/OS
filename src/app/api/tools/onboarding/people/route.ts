import { NextResponse } from "next/server";
import { z } from "zod";

import { createPerson } from "@/lib/tools/onboarding/people";
import { MAX_PHOTO, ROLES } from "@/lib/tools/onboarding/people-types";

/*
 * The roster — salespeople and account managers.
 *
 * Both roles live in `orch_salespeople`; `role` separates them. Nothing
 * automatic reads a person: they are labels shown in the app and dropped into
 * emails by name.
 */
export const dynamic = "force-dynamic";

const createSchema = z.object({
  role: z.enum(ROLES),
  name: z.string().min(1).max(120),
  email: z.string().max(200).default(""),
  // Validated properly in `validatePhoto` — the cap is repeated here so an
  // oversized body is refused before it reaches the database layer.
  photo: z.string().max(MAX_PHOTO).nullable().default(null),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { role, name, email, photo } = parsed.data;
  const result = await createPerson(role, name, email, photo);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
