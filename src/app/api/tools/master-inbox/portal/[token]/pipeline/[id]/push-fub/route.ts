import { NextResponse } from "next/server";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { pushPipelineEntryToFub } from "@/lib/tools/master-inbox/integrations/push-pipeline-entry";

// POST /api/portal/[token]/pipeline/[id]/push-fub
//
// Manual "Push to Follow Up Boss" button on a pipeline row. The same
// helper powers the inline auto-push hook on stage transitions, so
// behaviour is identical between paths — the only difference is who
// calls it.

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const outcome = await pushPipelineEntryToFub(client.id, id);
  if (!outcome.ok) {
    // Map each failure reason to an HTTP status the UI can branch on.
    // 422 = "the request was understood but the lead can't be pushed";
    // 502 = "Follow Up Boss is the one rejecting it"; the rest are 400.
    const status =
      outcome.reason === "api_error"
        ? 502
        : outcome.reason === "no_contact"
          ? 422
          : 400;
    return NextResponse.json(
      { ok: false, error: outcome.message, reason: outcome.reason },
      { status },
    );
  }
  return NextResponse.json({
    ok: true,
    mode: outcome.mode,
    person_id: outcome.personId,
  });
}
