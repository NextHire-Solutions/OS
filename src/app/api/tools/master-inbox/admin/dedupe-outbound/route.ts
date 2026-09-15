import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// One-off cleanup for ANY duplicate messages in the active workspace.
//
// Catches three patterns from the various external_message_id schemes:
//   - "eb:reply:rmid:<msg>" twin of "eb:reply:<id>" (old vs new scheme)
//   - "eb-out:*" placeholder twin of "eb:reply:<id>" (send-time vs backfill)
//   - any other rows sharing the same emailbison_reply_id
//
// Strategy: group every message by (workspace_id, emailbison_reply_id)
// when reply_id is not null. In each group keep ONE canonical row:
//   1) prefer external_message_id = "eb:reply:<id>"
//   2) else prefer external_message_id starting with "eb:reply:"
//   3) else any row
// Delete the rest. Same logic applied for raw_message_id-keyed groups
// as a fallback for rows missing emailbison_reply_id.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const session = await requireSession();
  const admin = createAdminSupabase();
  const wsId = session.activeWorkspace.id;

  const { data: rows, error } = await admin
    .from("messages")
    .select(
      "id, direction, sent_at, external_message_id, emailbison_reply_id, raw_payload",
    )
    .eq("workspace_id", wsId)
    .order("sent_at", { ascending: true })
    .limit(10000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by emailbison_reply_id first.
  const byReplyId = new Map<string, typeof rows>();
  const byRawMsgId = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    if (r.emailbison_reply_id) {
      const list = byReplyId.get(r.emailbison_reply_id) ?? [];
      list.push(r);
      byReplyId.set(r.emailbison_reply_id, list);
    } else {
      // Use raw_message_id from raw_payload for placeholder-only rows.
      const p = (r.raw_payload ?? {}) as Record<string, unknown>;
      const data = (p.data as Record<string, unknown> | undefined) ?? p;
      const reply = (data?.reply as Record<string, unknown> | undefined) ?? data;
      const rmid = typeof reply?.raw_message_id === "string"
        ? (reply.raw_message_id as string)
        : null;
      if (rmid) {
        const list = byRawMsgId.get(rmid) ?? [];
        list.push(r);
        byRawMsgId.set(rmid, list);
      }
    }
  }

  // For each emailbison_reply_id group, also catch any orphaned placeholder
  // rows (eb-out:*) that share a sent_at within 5min and same direction —
  // they're the same outbound that didn't get a reply_id captured.
  type Msg = NonNullable<typeof rows>[number];
  function pickCanonical(list: Msg[]): Msg {
    const sorted = [...list].sort((a, b) => {
      const ax = (a.external_message_id ?? "");
      const bx = (b.external_message_id ?? "");
      const aRank =
        ax.startsWith("eb:reply:rmid:") ? 1 :
        ax.startsWith("eb:reply:") ? 0 :
        ax.startsWith("eb:sched:") ? 2 :
        ax.startsWith("eb-out:") ? 3 : 4;
      const bRank =
        bx.startsWith("eb:reply:rmid:") ? 1 :
        bx.startsWith("eb:reply:") ? 0 :
        bx.startsWith("eb:sched:") ? 2 :
        bx.startsWith("eb-out:") ? 3 : 4;
      if (aRank !== bRank) return aRank - bRank;
      return (a.sent_at ?? "").localeCompare(b.sent_at ?? "");
    });
    return sorted[0];
  }

  let deleted = 0;
  const samples: Array<{ kept: string; dropped: string; key: string }> = [];

  for (const [key, list] of byReplyId.entries()) {
    if (list.length < 2) continue;
    const keep = pickCanonical(list);
    for (const r of list) {
      if (r.id === keep.id) continue;
      const { error: delErr } = await admin.from("messages").delete().eq("id", r.id);
      if (!delErr) {
        deleted++;
        if (samples.length < 10) {
          samples.push({ kept: keep.id, dropped: r.id, key: `reply:${key}` });
        }
      }
    }
  }

  for (const [key, list] of byRawMsgId.entries()) {
    if (list.length < 2) continue;
    const keep = pickCanonical(list);
    for (const r of list) {
      if (r.id === keep.id) continue;
      const { error: delErr } = await admin.from("messages").delete().eq("id", r.id);
      if (!delErr) {
        deleted++;
        if (samples.length < 10) {
          samples.push({ kept: keep.id, dropped: r.id, key: `rmid:${key}` });
        }
      }
    }
  }

  // Finally, catch eb-out:* placeholders that have a sibling eb:reply:* on
  // the same thread within 5min (means the placeholder is a dupe but its
  // raw_payload was empty so we didn't catch it above).
  const placeholders = (rows ?? []).filter(
    (r) => (r.external_message_id ?? "").startsWith("eb-out:") && !r.emailbison_reply_id,
  );
  for (const p of placeholders) {
    if (!p.sent_at) continue;
    const sentAt = new Date(p.sent_at).getTime();
    const twin = (rows ?? []).find(
      (r) =>
        r.id !== p.id &&
        r.direction === p.direction &&
        r.emailbison_reply_id &&
        Math.abs(new Date(r.sent_at ?? 0).getTime() - sentAt) < 5 * 60_000,
    );
    if (!twin) continue;
    const { error: delErr } = await admin.from("messages").delete().eq("id", p.id);
    if (!delErr) {
      deleted++;
      if (samples.length < 10) {
        samples.push({ kept: twin.id, dropped: p.id, key: "placeholder-sibling" });
      }
    }
  }

  return NextResponse.json({
    scanned: rows?.length ?? 0,
    deleted,
    samples,
  });
}
