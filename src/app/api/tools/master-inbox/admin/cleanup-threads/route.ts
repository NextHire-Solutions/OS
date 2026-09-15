import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSuperAdmin } from "@/lib/auth/super-admin";

// Wipes EmailBison-sourced threads + messages + leads so the new sync logic
// can repopulate cleanly. Does NOT touch workspaces, channels, labels,
// custom_views, members.
//
// Auth: super admin session OR ?token=<service-role>.

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

  const admin = createAdminSupabase();

  /*
   * Scoped to the workspace, on top of the tool's own EmailBison filters.
   *
   * The tool is single-tenant, so this changes nothing about what gets
   * deleted — every row already belongs to the one workspace. It exists
   * because the OS enforces a rule the tool never had: no .delete() without a
   * row scope (src/lib/guards/blast-radius.test.ts). A filter on a nullable
   * mirror column is a filter, but not a scope; a workspace id is.
   */
  const { data: ws, error: wsErr } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  if (wsErr || !ws?.id) {
    return NextResponse.json({ ok: false, step: "workspace", error: wsErr?.message ?? "no workspace" }, { status: 500 });
  }
  const workspaceId = ws.id as string;

  // Delete messages first (FK), then threads, then leads — only those tied to
  // EmailBison. Match via the emailbison_thread_id / emailbison_lead_id mirror
  // columns. We also catch the early test rows where external IDs were just
  // raw message ids without our new prefix.
  const { error: msgErr, count: msgDeleted } = await admin
    .from("messages")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId)
    .or("emailbison_reply_id.not.is.null,external_message_id.like.eb:*");
  if (msgErr) {
    return NextResponse.json({ ok: false, step: "messages", error: msgErr.message }, { status: 500 });
  }

  const { error: thrErr, count: thrDeleted } = await admin
    .from("threads")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId)
    .not("emailbison_thread_id", "is", null);
  if (thrErr) {
    return NextResponse.json({ ok: false, step: "threads", error: thrErr.message }, { status: 500 });
  }

  const { error: leadErr, count: leadDeleted } = await admin
    .from("leads")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId)
    .not("emailbison_lead_id", "is", null);
  if (leadErr) {
    return NextResponse.json({ ok: false, step: "leads", error: leadErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      messages: msgDeleted ?? 0,
      threads: thrDeleted ?? 0,
      leads: leadDeleted ?? 0,
    },
  });
}
