import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { createEmailBisonClient } from "@/lib/tools/master-inbox/emailbison/client";
import { RELEVANT_EVENTS } from "@/lib/tools/master-inbox/emailbison/types";
import {
  OS_PUBLIC_URL,
  WEBHOOK_PATHS,
  normalizeBase,
  pointsAtReceiver,
  receiverUrl,
} from "@/lib/tools/master-inbox/webhooks/public-paths";
import { verifySharedSecret } from "@/lib/tools/master-inbox/webhooks/verify";

// Registers (or replaces) webhook URLs with EmailBison so it starts pushing
// events into the OS. The tool's /api/webhooks/register.
//
// EmailBison is multi-workspace ("team") — webhooks are scoped per team, so we
// iterate every team the API key can see, switch context, then upsert the
// webhook URL there.
//
// Idempotent: list existing webhooks, delete any pointing at our URL, create
// fresh ones.
//
// Auth: POST with `?token=<MASTER_INBOX_WEBHOOK_REGISTER_SECRET>` (or the
// x-register-token header). The tool fell back to the service-role key when
// that secret was unset; here an unset secret is a 503.
//
// Two things differ from the tool because the receiver now fails closed:
//   - the registered URL carries `?token=<EMAILBISON_WEBHOOK_SECRET>`, as the
//     Instantly registration always did, or every delivery would be 401;
//   - "ours" is matched on the path, not the whole URL, so rotating the
//     secret replaces the old registration instead of leaving it behind.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const verdict = verifySharedSecret(request, env.WEBHOOK_REGISTER_SECRET, {
    header: "x-register-token",
    varName: "MASTER_INBOX_WEBHOOK_REGISTER_SECRET",
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.error }, { status: verdict.status });
  }

  const receiverSecret = env.EMAILBISON_WEBHOOK_SECRET;
  if (!receiverSecret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "MASTER_INBOX_EMAILBISON_WEBHOOK_SECRET is not set — the receiver would reject every delivery, so nothing was registered",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { base_url?: string };
  const base = normalizeBase(body.base_url ?? OS_PUBLIC_URL);
  const ebUrl = receiverUrl(base, WEBHOOK_PATHS.emailbison, receiverSecret);

  const emailbisonResults: Array<{
    workspace_id: number;
    workspace_name: string;
    ok: boolean;
    webhook_id?: number;
    error?: string;
  }> = [];

  try {
    const eb = createEmailBisonClient();
    const workspaces = await eb.listWorkspaces();
    for (const ws of workspaces.data ?? []) {
      try {
        await eb.switchWorkspace(ws.id);
        const existing = await eb.listWebhooks();
        for (const hook of existing.data ?? []) {
          if (pointsAtReceiver(hook.url, base, WEBHOOK_PATHS.emailbison)) {
            await eb.deleteWebhook(hook.id).catch(() => undefined);
          }
        }
        const created = await eb.createWebhook({
          name: "BrokerStaffer Master Inbox",
          url: ebUrl,
          events: RELEVANT_EVENTS,
        });
        emailbisonResults.push({
          workspace_id: ws.id,
          workspace_name: ws.name,
          ok: true,
          webhook_id: created.data?.id,
        });
      } catch (err) {
        emailbisonResults.push({
          workspace_id: ws.id,
          workspace_name: ws.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    emailbisonResults.push({
      workspace_id: 0,
      workspace_name: "<listWorkspaces failed>",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const okCount = emailbisonResults.filter((r) => r.ok).length;
  return NextResponse.json(
    {
      ok: true,
      summary: {
        emailbison_workspaces_registered: okCount,
        emailbison_workspaces_total: emailbisonResults.length,
      },
      // The secret is part of the registered URL; it is not echoed back.
      target_urls: { emailbison: `${base}${WEBHOOK_PATHS.emailbison}` },
      emailbison: emailbisonResults,
    },
    { status: 200 },
  );
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    note: "POST here with ?token=<MASTER_INBOX_WEBHOOK_REGISTER_SECRET> to register webhook URLs in every EmailBison workspace.",
    target_urls: {
      emailbison: `${OS_PUBLIC_URL}${WEBHOOK_PATHS.emailbison}`,
    },
  });
}
