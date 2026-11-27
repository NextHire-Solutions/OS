import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { applySettings, planSettings, readSettings, Settings } from "@/lib/tools/analytics/campaigns/settings-update.ts";

/*
 * Campaign settings (spec §9.2 Settings tab). The logic lives in campaigns/settings-update.ts (moved there unchanged,
 * 27 Nov, so the Claude connector runs the same code): EmailBison decides, the cache is written only after a 2xx, and
 * every attempt is recorded with what the values were before.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => analyticsTeamId();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const parsed = Settings.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const teamId = TEAM_ID();
  const before = await readSettings(campaignId, teamId);
  if (!before) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const { changed, conflict } = planSettings(before, parsed.data as Record<string, unknown>);
  if (Object.keys(changed).length === 0) {
    return NextResponse.json({ ok: true, changed: {}, note: "No values differed" });
  }
  if (conflict) {
    return NextResponse.json({ error: conflict }, { status: 422 });
  }

  const outcome = await applySettings(campaignId, before, changed, session.email, teamId);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 502 });
  return NextResponse.json({ ok: true, changed: outcome.changed });
}
