import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient } from "@/lib/tools/master-inbox/emailbison/client";

// One-off cleanup: walks every message in the active workspace that has an
// emailbison_reply_id and flips its direction based on whether the sender is
// one of our connected sender_emails. Fixes historical rows that were
// classified by the older (lead-email-match) heuristic and ended up on the
// wrong side of the thread view.
//
// Safe to re-run.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const session = await requireSession();
  const admin = createAdminSupabase();

  // Look up the workspace's EmailBison team id so we can switch context.
  const { data: ws } = await admin
    .from("workspaces")
    .select("emailbison_team_id")
    .eq("id", session.activeWorkspace.id)
    .maybeSingle();
  if (!ws?.emailbison_team_id) {
    return NextResponse.json(
      { error: "Workspace not linked to an EmailBison team" },
      { status: 400 },
    );
  }

  // Pull the full sender_emails list once so we can identify our addresses.
  const eb = createEmailBisonClient();
  try {
    await eb.switchWorkspace(ws.emailbison_team_id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "switchWorkspace failed" },
      { status: 502 },
    );
  }

  const senderEmails = new Set<string>();
  try {
    const res = await eb.listSenderEmails();
    for (const s of res.data ?? []) {
      if (s.email) senderEmails.add(s.email.toLowerCase());
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "listSenderEmails failed" },
      { status: 502 },
    );
  }

  // Page through messages — only ones with a sender address; we can't classify
  // ones without. Scope to this workspace via the admin client.
  const { data: messages } = await admin
    .from("messages")
    .select("id, direction, sender")
    .eq("workspace_id", session.activeWorkspace.id)
    .not("sender", "is", null)
    .limit(10000);

  let flipped = 0;
  for (const m of messages ?? []) {
    const sender = (m.sender as string | null)?.toLowerCase() ?? null;
    if (!sender) continue;
    const isOurs = senderEmails.has(sender);
    const expected: "inbound" | "outbound" = isOurs ? "outbound" : "inbound";
    if (m.direction === expected) continue;
    await admin.from("messages").update({ direction: expected }).eq("id", m.id);
    flipped++;
  }

  return NextResponse.json({
    scanned: messages?.length ?? 0,
    flipped,
    our_sender_count: senderEmails.size,
  });
}
