import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { handleEmailBisonEvent } from "@/lib/tools/master-inbox/sync/emailbison";
import { ensureCronScheduler } from "@/lib/tools/master-inbox/sync/scheduler";
import { verifySharedSecret } from "@/lib/tools/master-inbox/webhooks/verify";
import type { EmailBisonWebhookEnvelope } from "@/lib/tools/master-inbox/emailbison/types";

// EmailBison webhook receiver — the tool's /api/webhooks/emailbison, served by
// the OS at /api/tools/master-inbox/webhooks/emailbison. Returns 200 fast even
// on processing errors so the provider doesn't keep retrying — failures
// surface via the audit_log and internal alerts.
//
// Auth: EmailBison doesn't sign webhooks. We require a shared-secret query
// parameter `?token=...` (or x-webhook-token) checked against
// MASTER_INBOX_EMAILBISON_WEBHOOK_SECRET. The tool accepted everything while
// the secret was unset; the OS refuses with 503 — see webhooks/verify.ts.
//
// This path must be allowlisted in src/proxy.ts: the provider has no session.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  ensureCronScheduler();

  const verdict = verifySharedSecret(request, env.EMAILBISON_WEBHOOK_SECRET, {
    header: "x-webhook-token",
    varName: "MASTER_INBOX_EMAILBISON_WEBHOOK_SECRET",
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.error }, { status: verdict.status });
  }

  let envelope: EmailBisonWebhookEnvelope;
  try {
    envelope = (await request.json()) as EmailBisonWebhookEnvelope;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // Log the full envelope so we can inspect actual EmailBison delivery shape
  // (sender_email field, custom_variables, anything else missing from our
  // typed handlers). Keep until we're confident extraction is correct.
  console.log("[emailbison webhook] envelope:", JSON.stringify(envelope));

  try {
    const result = await handleEmailBisonEvent(envelope);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[emailbison webhook] handler error", err);
    // 200 so provider doesn't retry. Failures land in logs.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 },
    );
  }
}

// Useful for quick reachability checks.
export async function GET() {
  return NextResponse.json({
    ok: true,
    receiver: "emailbison",
    expects_secret: Boolean(env.EMAILBISON_WEBHOOK_SECRET),
  });
}
