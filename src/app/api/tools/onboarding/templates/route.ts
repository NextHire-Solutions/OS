import { NextResponse } from "next/server";
import { z } from "zod";

import { createTemplate, getTemplates } from "@/lib/tools/onboarding/templates";
import { TEMPLATE_SECTIONS } from "@/lib/tools/onboarding/template-types";

/*
 * Onboarding templates — the wording the orchestrator actually sends.
 *
 * These rows are read by the live orchestrator at send time, so an edit here
 * takes effect on the next send. Gated by the workspace front door; see
 * ../stages/route.ts.
 */
export const dynamic = "force-dynamic";

const CATEGORIES = TEMPLATE_SECTIONS.map((s) => s.cat) as [string, ...string[]];

const createSchema = z.object({ category: z.enum(CATEGORIES) });

export async function GET() {
  return NextResponse.json(await getTemplates());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const result = await createTemplate(parsed.data.category);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
