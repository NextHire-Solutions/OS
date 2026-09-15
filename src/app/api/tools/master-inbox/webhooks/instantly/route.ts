import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { handleInstantlyEvent } from "@/lib/tools/master-inbox/sync/instantly";
import { ensureCronScheduler } from "@/lib/tools/master-inbox/sync/scheduler";
import { verifySharedSecret } from "@/lib/tools/master-inbox/webhooks/verify";
import type { InstantlyWebhookEnvelope } from "@/lib/tools/master-inbox/instantly/types";

// Instantly.ai webhook receiver — the tool's /api/webhooks/instantly, served
// by the OS at /api/tools/master-inbox/webhooks/instantly. Same contract as
// the EmailBison one: ack with 200 even on processing errors so the provider
// doesn't keep retrying — failures land in logs and the audit_log.
//
// Auth: Instantly does NOT publish a webhook secret / HMAC signature. We
// require a shared-secret query parameter `?token=...` (or x-webhook-token)
// checked against MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET. The token is set
// when registering the webhook (admin/instantly/register-webhook). The tool
// accepted everything while the secret was unset; the OS refuses with 503 —
// see webhooks/verify.ts.
//
// This path must be allowlisted in src/proxy.ts: the provider has no session.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  ensureCronScheduler();

  const verdict = verifySharedSecret(request, env.INSTANTLY_WEBHOOK_SECRET, {
    header: "x-webhook-token",
    varName: "MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET",
  });
  if (!verdict.ok) {
    console.warn("[instantly drop]", JSON.stringify({ reason: "invalid token at edge", status: verdict.status }));
    return NextResponse.json({ ok: false, error: verdict.error }, { status: verdict.status });
  }

  let envelope: InstantlyWebhookEnvelope;
  try {
    envelope = (await request.json()) as InstantlyWebhookEnvelope;
  } catch {
    console.warn("[instantly drop]", JSON.stringify({ reason: "invalid json at edge" }));
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // Full envelope dump kept around — lets us reconstruct any drop from log
  // grep alone without needing to replay the request.
  console.log("[instantly webhook] envelope:", JSON.stringify(envelope));

  try {
    const result = await handleInstantlyEvent(envelope);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.warn(
      "[instantly drop]",
      JSON.stringify({
        reason: "handler threw",
        email_id: envelope.email_id ?? null,
        lead: envelope.lead_email ?? envelope.email ?? null,
        campaign_id: envelope.campaign_id ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    receiver: "instantly",
    expects_secret: Boolean(env.INSTANTLY_WEBHOOK_SECRET),
  });
}
