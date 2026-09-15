import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { createInstantlyClient } from "@/lib/tools/master-inbox/instantly/client";
import { RELEVANT_EVENTS } from "@/lib/tools/master-inbox/instantly/types";
import {
  OS_PUBLIC_URL,
  WEBHOOK_PATHS,
  normalizeBase,
  pointsAtReceiver,
  receiverUrl,
} from "@/lib/tools/master-inbox/webhooks/public-paths";

// One-shot admin endpoint: register (or refresh) our Instantly webhook so
// reply_received events start flowing into webhooks/instantly. The tool's
// /api/admin/instantly/register-webhook.
//
// Idempotent: lists existing webhooks, deletes any that point at our URL,
// then creates a fresh one with the desired event types. Run after the
// app is first deployed and any time MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET
// changes.
//
// Auth: the same as the other ported admin routes (sync-workspaces,
// retag-all-clients) — a super-admin session OR ?token=<service-role>
// (also accepted as x-admin-token).

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  let authorized = false;
  if (supplied && serviceKey && supplied === serviceKey) authorized = true;
  else {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && isSuperAdmin(user.email)) authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    base_url?: string;
    campaign_ids?: string[];
  };
  const base = normalizeBase(body.base_url ?? OS_PUBLIC_URL);

  // Webhook receiver URL. The shared secret rides along as `?token=` so we can
  // verify deliveries match what we registered (Instantly does not sign
  // payloads itself — this is the only thing standing between us and a
  // spoofed POST). The tool registered a bare URL when the secret was unset;
  // the OS receiver rejects every delivery in that state, so registering
  // would only wire Instantly to a 503.
  const secret = env.INSTANTLY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET is not set — the receiver would reject every delivery, so nothing was registered",
      },
      { status: 503 },
    );
  }
  const targetUrl = receiverUrl(base, WEBHOOK_PATHS.instantly, secret);

  let instantly;
  try {
    instantly = createInstantlyClient();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Instantly not configured" },
      { status: 400 },
    );
  }

  // Remove every existing webhook pointing at our endpoint. Match on the URL
  // PATH (not query string) so rotating the secret doesn't leave orphans.
  let deleted = 0;
  try {
    const existing = await instantly.listWebhooks();
    const items = existing.items ?? [];
    for (const hook of items) {
      const hookUrl = hook.target_hook_url ?? "";
      if (pointsAtReceiver(hookUrl, base, WEBHOOK_PATHS.instantly)) {
        try {
          await instantly.deleteWebhook(hook.id);
          deleted += 1;
        } catch (err) {
          console.error("[instantly] failed to delete stale webhook", hook.id, err);
        }
      }
    }
  } catch (err) {
    console.error("[instantly] listWebhooks failed", err);
  }

  // Instantly is one webhook per event type — POST per event in RELEVANT_EVENTS.
  const created: Array<{ id: string; event_type: string }> = [];
  const errors: Array<{ event_type: string; error: string }> = [];
  for (const ev of RELEVANT_EVENTS) {
    try {
      const c = await instantly.createWebhook({
        name: `BrokerStaffer Master Inbox — ${ev}`,
        target_hook_url: targetUrl,
        event_type: ev,
      });
      created.push({ id: c.id, event_type: c.event_type });
    } catch (err) {
      errors.push({
        event_type: ev,
        error: err instanceof Error ? err.message : "createWebhook failed",
      });
    }
  }

  // The secret is part of the registered URL; the response shows the path only.
  const shownTarget = `${base}${WEBHOOK_PATHS.instantly}`;

  if (created.length === 0 && errors.length > 0) {
    return NextResponse.json(
      { ok: false, errors, target_url: shownTarget, deleted_stale: deleted },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      target_url: shownTarget,
      created,
      errors,
      deleted_stale: deleted,
    },
    { status: 200 },
  );
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    note: "POST as a super admin (or with ?token=<service-role>) to register the Instantly webhook.",
    target_url: `${OS_PUBLIC_URL}${WEBHOOK_PATHS.instantly}`,
    events: RELEVANT_EVENTS,
  });
}
