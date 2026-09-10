import { NextResponse } from "next/server";
import { z } from "zod";

import { createStage, getStagesBoard } from "@/lib/tools/onboarding/stages";

/*
 * Onboarding stages — the team's own board, readable and writable.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO AUTH CHECK IN THIS FILE
 *
 * Everything under /api/tools/* is gated by the workspace's front door — the
 * HMAC-signed cookie checked in `src/proxy.ts` before any route here is
 * reachable (see PUBLIC_PREFIXES: only /login, /api/auth and /api/health are
 * open). By the time this handler runs the caller is a signed-in member of
 * staff.
 *
 * Master Inbox's routes call `requireSession()` on top of that, but only to read
 * `activeWorkspace.id` for its per-workspace tables. Onboarding has no workspace
 * column and no session of its own; adding that call here would gate these
 * writes on a Master Inbox workspace lookup that has nothing to do with them.
 */
export const dynamic = "force-dynamic";

const createSchema = z.object({ name: z.string().min(1).max(80) });

export async function GET() {
  return NextResponse.json(await getStagesBoard());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const result = await createStage(parsed.data.name);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
