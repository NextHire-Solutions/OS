import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Returns thread counts broken down by status. Default: just the active
// workspace. With ?all=1: every workspace the signed-in user is a member of.

export const dynamic = "force-dynamic";

async function countsFor(admin: ReturnType<typeof createAdminSupabase>, wsId: string) {
  const [all, open, archived, spam, trash, reminder, needsReply] = await Promise.all([
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "open"),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "archived"),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "spam"),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "trash"),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "reminder"),
    admin.from("threads").select("id", { count: "exact", head: true }).eq("workspace_id", wsId).eq("status", "open").eq("needs_reply", true),
  ]);
  return {
    all: all.count ?? null,
    open: open.count ?? null,
    archived: archived.count ?? null,
    spam: spam.count ?? null,
    trash: trash.count ?? null,
    reminder: reminder.count ?? null,
    open_needs_reply: needsReply.count ?? null,
  };
}

export async function GET(req: Request) {
  const session = await requireSession();
  const admin = createAdminSupabase();
  const allWorkspaces = new URL(req.url).searchParams.get("all") === "1";

  if (allWorkspaces) {
    const rows = await Promise.all(
      session.workspaces.map(async (w) => ({
        workspace_id: w.id,
        workspace_name: w.name,
        slug: w.slug,
        counts: await countsFor(admin, w.id),
      })),
    );
    return NextResponse.json({ workspaces: rows });
  }

  return NextResponse.json({
    workspace_id: session.activeWorkspace.id,
    workspace_name: session.activeWorkspace.name,
    counts: await countsFor(admin, session.activeWorkspace.id),
  });
}
