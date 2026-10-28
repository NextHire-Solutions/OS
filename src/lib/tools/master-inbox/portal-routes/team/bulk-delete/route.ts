import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { notifyPortalTeamChange } from "@/lib/tools/master-inbox/webhooks/slack-portal";

// POST /api/portal/[token]/team/bulk-delete
// Body: { ids: string[] }
//
// Removes multiple team members from the intro-notification roster
// in one request. Mirrors the Agents bulk-delete shape so the UI
// chunking logic is identical (300 ids per request, sequential).
// Each id is scoped to the portal's client_id — sending an id that
// belongs to a different client is a no-op (the row simply isn't
// matched).

export const dynamic = "force-dynamic";

const schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const admin = createAdminSupabase();
  // Read names BEFORE the delete so the Slack message can name names
  // when there are five or fewer. Cap at 6 rows so a 300-id sweep
  // doesn't waste a roundtrip; we only care about the cardinal case.
  const { data: preRows } = await admin
    .from("client_team_members")
    .select("name, email")
    .eq("client_id", client.id)
    .in("id", parsed.data.ids)
    .limit(6);

  const { error, count } = await admin
    .from("client_team_members")
    .delete({ count: "exact" })
    .eq("client_id", client.id)
    .in("id", parsed.data.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const deleted = count ?? 0;
  if (deleted > 0) {
    const clientId = client.id;
    if (deleted <= 5 && preRows && preRows.length === deleted) {
      // Small batch — one Slack message per member so the channel
      // shows who specifically was removed.
      const rows = preRows.slice(0, deleted);
      after(async () => {
        for (const row of rows) {
          await notifyPortalTeamChange({
            clientId,
            name: (row.name as string | null) ?? null,
            email: (row.email as string | null) ?? null,
            op: "removed",
          });
        }
      });
    } else {
      // Large batch — single summary line.
      after(() =>
        notifyPortalTeamChange({
          clientId,
          name: null,
          email: null,
          op: "removed",
          count: deleted,
        }),
      );
    }
  }

  return NextResponse.json({ ok: true, deleted });
}
