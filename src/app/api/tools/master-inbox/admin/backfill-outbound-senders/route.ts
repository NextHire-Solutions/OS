import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient } from "@/lib/tools/master-inbox/emailbison/client";

// One-off cleanup: for every outbound message in the active workspace whose
// `sender` is null, look at the stored raw_payload (sent-emails row or
// conversation-thread reply row), resolve the address via the workspace's
// full sender_emails list, and write it back.
//
// Run via:
//   fetch('/api/tools/master-inbox/admin/backfill-outbound-senders', { method: 'POST' })
//     .then(r => r.json()).then(console.log)

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const session = await requireSession();
  const admin = createAdminSupabase();

  // Find the EmailBison team for this workspace.
  const { data: ws } = await admin
    .from("workspaces")
    .select("emailbison_team_id")
    .eq("id", session.activeWorkspace.id)
    .maybeSingle();
  if (!ws?.emailbison_team_id) {
    return NextResponse.json(
      { error: "Workspace isn't linked to an EmailBison team" },
      { status: 400 },
    );
  }

  // Fetch every page of sender-emails so we have a complete id -> address map.
  const eb = createEmailBisonClient();
  try {
    await eb.switchWorkspace(ws.emailbison_team_id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "switchWorkspace failed" },
      { status: 502 },
    );
  }

  const senderEmailMap = new Map<number, string>();
  let page = 1;
  while (page <= 50) {
    try {
      const res = await eb.listSenderEmails(page);
      const rows = res.data ?? [];
      if (rows.length === 0) break;
      for (const s of rows) {
        if (s.id && s.email) senderEmailMap.set(s.id, s.email.toLowerCase());
      }
      page++;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "listSenderEmails failed", page },
        { status: 502 },
      );
    }
  }

  // Build per-thread channel -> sender_email_id map. Channels store the
  // workspace's EmailBison sender_email_id; combined with senderEmailMap
  // that gives us OUR address for any thread, even ones with no inbound
  // messages yet.
  const threadChannelOurAddr = new Map<string, string>();
  {
    const { data: rows } = await admin
      .from("threads")
      .select("id, channels:channel_id(emailbison_sender_email_id)")
      .eq("workspace_id", session.activeWorkspace.id);
    for (const t of rows ?? []) {
      const channel = Array.isArray(t.channels) ? t.channels[0] : t.channels;
      const idStr = channel?.emailbison_sender_email_id as string | null | undefined;
      if (!idStr) continue;
      const idNum = Number(idStr);
      if (!Number.isFinite(idNum)) continue;
      const addr = senderEmailMap.get(idNum);
      if (addr) threadChannelOurAddr.set(t.id as string, addr);
    }
  }

  // Build per-thread "our address" map by scanning inbound messages.
  // primary_to_email_address on an inbound reply = OUR account that
  // received it. We use this as a fallback when a sibling outbound row
  // has lost its sender_email_id (e.g. raw_payload got overwritten by an
  // earlier backfill bug).
  const threadInboundOurAddr = new Map<string, string>();
  {
    const { data: inboundRows } = await admin
      .from("messages")
      .select("thread_id, raw_payload")
      .eq("workspace_id", session.activeWorkspace.id)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(5000);
    for (const m of inboundRows ?? []) {
      const threadId = m.thread_id as string;
      if (threadInboundOurAddr.has(threadId)) continue;
      const payload = (m.raw_payload ?? {}) as Record<string, unknown>;
      const addr = typeof payload.primary_to_email_address === "string"
        ? (payload.primary_to_email_address as string).toLowerCase()
        : null;
      if (addr && senderEmailMap.size > 0) {
        // Confirm it's actually one of our addresses.
        const ourLower = new Set(
          Array.from(senderEmailMap.values()).map((s) => s.toLowerCase()),
        );
        if (ourLower.has(addr)) {
          threadInboundOurAddr.set(threadId, addr);
        }
      } else if (addr) {
        threadInboundOurAddr.set(threadId, addr);
      }
    }
  }

  let scanned = 0;
  let filled = 0;
  let stillNull = 0;
  let threadsTouched = 0;
  const threadSenderAdded = new Set<string>();
  const examples: Array<{ message_id: string; resolved: string }> = [];
  const reasonsForNull: Record<string, number> = {};

  const BATCH = 200;
  let offset = 0;
  while (true) {
    const { data: messages, error } = await admin
      .from("messages")
      .select("id, thread_id, raw_payload, external_message_id")
      .eq("workspace_id", session.activeWorkspace.id)
      .eq("direction", "outbound")
      .is("sender", null)
      .range(offset, offset + BATCH - 1);
    if (error) {
      return NextResponse.json({ error: error.message, scanned, filled }, { status: 500 });
    }
    if (!messages || messages.length === 0) break;

    for (const m of messages) {
      scanned++;
      const payload = (m.raw_payload ?? {}) as Record<string, unknown>;
      // EmailBison stores the sending account as a NESTED object on
      // scheduled_email rows: { sender_email: { id, email, name, ... } }.
      // On reply rows it's the flat sender_email_id at the top level.
      // Check both.
      const nestedSenderEmail = payload.sender_email as
        | { id?: number; email?: string }
        | undefined;
      const nestedAddr =
        nestedSenderEmail && typeof nestedSenderEmail.email === "string"
          ? nestedSenderEmail.email
          : null;
      const senderEmailId =
        (payload.sender_email_id as number | undefined) ??
        nestedSenderEmail?.id ??
        undefined;
      const fromEmail =
        typeof payload.from_email_address === "string" ? (payload.from_email_address as string) : null;

      let resolved: string | null = null;
      let resolvedVia = "none";
      if (nestedAddr) {
        resolved = nestedAddr;
        resolvedVia = "nested_sender_email";
      } else if (senderEmailId && senderEmailMap.has(senderEmailId)) {
        resolved = senderEmailMap.get(senderEmailId) ?? null;
        resolvedVia = "sender_email_id_lookup";
      } else if (fromEmail) {
        resolved = fromEmail;
        resolvedVia = "from_email_address";
      } else {
        // Fallback 1: extract OUR-address from a sibling inbound message
        // (its primary_to_email_address is OUR account that received it).
        const fromSibling = threadInboundOurAddr.get(m.thread_id as string);
        if (fromSibling) {
          resolved = fromSibling;
          resolvedVia = "sibling_inbound_primary_to";
        } else {
          // Fallback 2: thread.channel.emailbison_sender_email_id mapped
          // through the workspace's sender_emails list. Works for
          // outbound-only threads that never received a reply.
          const fromChannel = threadChannelOurAddr.get(m.thread_id as string);
          if (fromChannel) {
            resolved = fromChannel;
            resolvedVia = "thread_channel_sender";
          }
        }
      }

      if (!resolved) {
        stillNull++;
        const reason = !senderEmailId
          ? "no_payload_no_sibling_no_channel"
          : "id_not_in_sender_emails_list";
        reasonsForNull[reason] = (reasonsForNull[reason] ?? 0) + 1;
        continue;
      }
      void resolvedVia;

      const { error: updErr } = await admin
        .from("messages")
        .update({ sender: resolved })
        .eq("id", m.id);
      if (updErr) {
        stillNull++;
        reasonsForNull["update_failed"] = (reasonsForNull["update_failed"] ?? 0) + 1;
        continue;
      }
      filled++;
      if (examples.length < 5) {
        examples.push({ message_id: m.id, resolved });
      }

      // Pin the resolved address on the thread too — first one wins.
      const threadId = m.thread_id as string;
      if (!threadSenderAdded.has(threadId)) {
        threadSenderAdded.add(threadId);
        const { error: thErr } = await admin
          .from("threads")
          .update({ outbound_sender_email: resolved })
          .eq("id", threadId)
          .is("outbound_sender_email", null);
        if (!thErr) threadsTouched++;
      }
    }

    if (messages.length < BATCH) break;
    offset += BATCH;
  }

  return NextResponse.json({
    sender_emails_in_map: senderEmailMap.size,
    scanned,
    filled,
    still_null: stillNull,
    threads_outbound_sender_set: threadsTouched,
    reasons_for_null: reasonsForNull,
    sample: examples,
  });
}
