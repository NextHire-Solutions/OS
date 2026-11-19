import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { realRenewIO } from "@/lib/tools/analytics/campaigns/renew/io.ts";
import { getJob, runningFor, startRenewJob } from "@/lib/tools/analytics/campaigns/renew/jobs.ts";
import { previewRenew } from "@/lib/tools/analytics/campaigns/renew/renew.ts";

/*
 * Duplicate & Renew Campaign (BrokerStaffer spec, 19 Nov) — see
 * lib/tools/analytics/campaigns/renew/renew.ts.
 *
 *   GET              the review: names, leads, inboxes, tag, schedule, links,
 *                    anything stopping it. Reads only.
 *   GET ?job=<id>    how a started renewal is getting on, and its result.
 *   POST             starts it: { token, poolIds, confirm: true }. The token is
 *                    the review's; the run refuses if the names, tag or the old
 *                    campaign's inboxes changed since. poolIds are the review's
 *                    wider-pool picks, each re-checked before it is added.
 *                    Campaign Management switch only (proxy).
 *
 * EmailBison only: the id is EmailBison's.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function session() {
  const store = await cookies();
  return verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
}

function campaignId(raw: string): number | null {
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = campaignId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  if (!(await session())?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = request.nextUrl.searchParams.get("job");
  if (jobId) {
    const job = getJob(jobId);
    if (!job || job.sourceId !== id) return NextResponse.json({ error: "That renewal is not known here (the server may have restarted). Check the campaign audit log." }, { status: 404 });
    return NextResponse.json({ job });
  }

  const running = runningFor(id);
  try {
    const preview = await previewRenew(id, realRenewIO());
    if ("error" in preview) return NextResponse.json(preview, { status: 404 });
    return NextResponse.json({ preview, runningJobId: running?.id ?? null });
  } catch (e) {
    return NextResponse.json({ error: `The review could not be read: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

const Body = z.object({
  token: z.string().min(8).max(100),
  // The wider-pool inboxes the review showed; each is checked again before it is added.
  poolIds: z.array(z.number().int().positive()).max(5000).default([]),
  // Renewing moves leads off a live campaign: never on a stray request.
  confirm: z.literal(true),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = campaignId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  const current = await session();
  if (!current?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      { error: missingConfirm ? "Renewing a campaign must be confirmed." : "Invalid request" },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const { job, started } = startRenewJob(id, parsed.data.token, parsed.data.poolIds, current.email, realRenewIO());
  if (!started) {
    return NextResponse.json({ error: "This campaign is already being renewed. Its progress is shown here.", jobId: job.id }, { status: 409 });
  }
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
