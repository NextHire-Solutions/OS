import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { syncExternalIntros } from "@/lib/tools/master-inbox/portals/external-intros";
import { ensureCronScheduler } from "@/lib/tools/master-inbox/sync/scheduler";
import { verifyBearer } from "@/lib/tools/master-inbox/webhooks/verify";

// Cron endpoint — pulls the legacy MasterInbox Introduction feed and
// mirrors it into the external_intros table. The tool's
// /api/cron/sync-external-intros. The upstream is ~30s, so this must NEVER
// run on a portal render; a scheduler hits it instead.
//
// Schedule it with any cron (Railway cron service, a crontab line, etc.):
//   curl -X POST https://os.brokerstaffer.com/api/tools/master-inbox/cron/sync-external-intros \
//        -H 'Authorization: Bearer <MASTER_INBOX_CRON_SECRET>'
//
// Or set MASTER_INBOX_CRON_ENABLED=1 and the OS runs it in-process on the
// cadence in sync/cron.ts — in which case this endpoint is the manual
// trigger.
//
// Auth: bearer MASTER_INBOX_CRON_SECRET, the same shape as
// ANALYTICS_CRON_SECRET. The tool accepted the service-role key or a
// super-admin session; the port takes only the dedicated secret, and 503s
// while it is unset. GET and POST both work so simple schedulers can use
// either. This path must be allowlisted in src/proxy.ts.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function run(request: Request) {
  ensureCronScheduler();

  const verdict = verifyBearer(request, env.CRON_SECRET, {
    varName: "MASTER_INBOX_CRON_SECRET",
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.error }, { status: verdict.status });
  }

  // ?enrich=N overrides how many rows get lead-detail enrichment this run.
  // Default (the scheduled cron) is a small batch; a one-off backfill can
  // pass a large N. ?enrich=0 skips enrichment entirely.
  const enrichParam = new URL(request.url).searchParams.get("enrich");
  const enrichLimit =
    enrichParam !== null ? Math.max(0, Number.parseInt(enrichParam, 10) || 0) : undefined;
  try {
    const result = await syncExternalIntros(
      enrichLimit !== undefined ? { enrichLimit } : undefined,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] sync-external-intros failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 502 },
    );
  }
}

export const GET = run;
export const POST = run;
