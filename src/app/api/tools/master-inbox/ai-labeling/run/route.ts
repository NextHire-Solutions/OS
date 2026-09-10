import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { backfillLabelsForWorkspace } from "@/lib/tools/master-inbox/ai/run";
import { env } from "@/lib/env";

// Streams AI-labeling progress as newline-delimited JSON so the UI can
// render a live progress bar / counters instead of staring at a spinner
// for several minutes.
//
// Wire protocol:
//   {"type":"progress","scanned":36,"total":500,"labeled":24,...}\n
//   ...
//   {"type":"done","scanned":500,"labeled":412,"sample_labels":[...],...}\n
//
// On a fatal error before the loop starts we still write one final line:
//   {"type":"error","error":"..."}\n
//
// Auth: normal user session OR `x-admin-token: <SUPABASE_SERVICE_ROLE_KEY>`
// (matches the same pattern as /api/clients/intros). The admin-token path
// requires `?workspace=<uuid>` because there's no session to resolve it
// from; without it we'd default to WORKSPACE_ID.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const adminToken = request.headers.get("x-admin-token") ?? url.searchParams.get("token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  let workspaceId: string;
  if (adminToken && serviceKey && adminToken === serviceKey) {
    workspaceId = url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace param required when using service-role token" },
        { status: 400 },
      );
    }
  } else {
    const session = await requireSession();
    workspaceId = session.activeWorkspace.id;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: object) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        } catch {
          // Client disconnected — let the await finish naturally; the
          // backfill keeps running but its output goes nowhere.
        }
      };
      try {
        const result = await backfillLabelsForWorkspace(workspaceId, (p) =>
          write({ type: "progress", ...p }),
        );
        write({ type: "done", ...result });
      } catch (err) {
        write({
          type: "error",
          error: err instanceof Error ? err.message : "Backfill failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
