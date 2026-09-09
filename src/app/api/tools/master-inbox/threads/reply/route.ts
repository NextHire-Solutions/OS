import { NextResponse } from "next/server";
import { z } from "zod";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { createEmailBisonClient } from "@/lib/tools/master-inbox/emailbison/client";
import { createInstantlyClient, InstantlyError } from "@/lib/tools/master-inbox/instantly/client";

/*
 * Master Inbox — sending a reply. The tool's own route, copied.
 *
 * Copied rather than rewritten because it SENDS REAL EMAIL to real agents, and
 * a divergence here does not throw: it mails the wrong person from the wrong
 * address. Every branch below is theirs. Three things differ, all of them
 * about who is asking rather than what is sent:
 *
 *   the workspace's proxy has already verified the session, so the
 *   auth.getUser() gate is gone — there is no Supabase Auth user here;
 *
 *   both Supabase clients become one service-role client. Master Inbox's own
 *   client portals already resolve this way;
 *
 *   the thread lookup is scoped by workspace explicitly, because RLS is no
 *   longer doing it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE FOR CALLERS
 *
 * There is NO send idempotency. `external_message_id` (eb:reply:<id> /
 * in:email:<id>) makes the stored ROW converge with the webhook echo, behind a
 * unique index — but the send itself has no key. A retry calls the provider
 * again and the agent receives a SECOND EMAIL.
 *
 * So: never retry this automatically, and never let the composer submit twice.
 *
 * Relatedly, the `messages` insert below is deliberately unchecked. That looks
 * like a bug and is not: failing the request after the provider has accepted
 * the send would invite exactly the retry that double-sends. The row is
 * recreated by the webhook echo anyway.
 */

/** Every query here is scoped to this workspace by hand — RLS is not. */
const WORKSPACE_ID = process.env.MASTER_INBOX_WORKSPACE_ID ?? "";

// Sends an outbound reply for the given thread via EmailBison's
// POST /api/replies/{id}/reply endpoint.
//
// Two transport modes:
//   - JSON body (no attachments)            → application/json
//   - multipart/form-data (with attachments) → see below
//
// Multipart form fields (used by the composer when files are picked):
//   body, content_type, subject              — scalars
//   to, cc, bcc                              — JSON-stringified arrays
//   reply_all, inject_previous_email_body    — "0" | "1"
//   attachments                              — repeated File fields

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_FILE_MAX = 25 * 1024 * 1024; // 25 MB
const COMBINED_MAX = 50 * 1024 * 1024; // 50 MB

// Workspace-wide auto-CC. The composer pre-fills the workspace
// CC address (lib/inbox/auto-cc.ts) so operators always see Nicole
// looped in by default and can leave her checked.
//
// IMPORTANT (2026-06-23): The server-side merge that used to
// re-add Nicole here was removed at Stephanie's request. The
// composer is the canonical source — when an operator
// deliberately removes Nicole from the CC field for a sensitive
// client, that intent now reaches EmailBison/Instantly verbatim
// instead of getting silently overridden by a server safety net.
// If we ever need to support direct API callers that bypass the
// composer, they're responsible for setting CC explicitly.

type Recipient = { name?: string | null; email_address: string };

const recipientSchema = z.object({
  name: z.string().nullable().optional(),
  email_address: z.string().email(),
});

const schema = z.object({
  body: z.string().min(1, "Reply body is required"),
  subject: z.string().optional(),
  content_type: z.enum(["html", "text"]).default("html"),
  to: z.array(recipientSchema).optional(),
  cc: z.array(recipientSchema).optional(),
  bcc: z.array(recipientSchema).optional(),
  reply_all: z.boolean().default(false),
  inject_previous_email_body: z.boolean().default(true),
  // messages.id of the specific message the user clicked Reply on. When
  // omitted (the bottom floating Reply button) we fall back to the latest
  // inbound. When set, we use THAT message's provider id (Instantly
  // email_id / EmailBison reply_id) as the reply target so the outbound's
  // In-Reply-To header points at the right ancestor for Gmail threading.
  source_message_id: z.string().uuid().optional(),
  // Override the sender mailbox for THIS send. When set, we look up the
  // channels row and use its provider-specific identifier (Instantly
  // eaccount / EmailBison sender_email_id) instead of the default
  // resolution from the thread's outbound_sender_email. Required for
  // the "From" dropdown in the composer.
  sender_channel_id: z.string().uuid().optional(),
  // True when the operator deliberately edited the Subject in the
  // composer (vs. accepting the auto-derived "Re: <source>" value).
  // EmailBison's /api/replies/{id}/reply silently drops `subject`,
  // so we route subject-changed sends through /api/replies/new
  // instead. Instantly always honours subject in-body, so the flag
  // doesn't affect that path. Optional + defaulted to false so older
  // clients (and any unknown direct API caller) keep current behaviour.
  subject_changed: z.boolean().optional(),
});

type ParsedInput = z.infer<typeof schema>;

export async function POST(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  // The workspace proxy verified the session before this handler ran; there
  // is no Supabase Auth user in this process by design.
  const userClient = getMasterInboxSupabase();

  // Parse either JSON or multipart based on the inbound content-type.
  let payload: ParsedInput;
  let attachments: Array<{ name: string; blob: Blob }> = [];
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("multipart/")) {
      const form = await request.formData();
      const fields: Record<string, unknown> = {};
      const files: File[] = [];
      for (const [key, value] of form.entries()) {
        if (key === "attachments" || key === "attachments[]") {
          if (value instanceof File) files.push(value);
        } else if (key === "to" || key === "cc" || key === "bcc") {
          // Recipients arrive JSON-stringified from the client.
          try {
            fields[key] = JSON.parse(String(value));
          } catch {
            fields[key] = undefined;
          }
        } else if (
          key === "reply_all" ||
          key === "inject_previous_email_body" ||
          key === "subject_changed"
        ) {
          fields[key] = value === "1" || value === "true";
        } else {
          fields[key] = String(value);
        }
      }

      // Enforce attachment caps server-side too — never trust the client.
      let combined = 0;
      for (const f of files) {
        if (f.size > PER_FILE_MAX) {
          return NextResponse.json(
            { error: `"${f.name}" exceeds the 25MB per-file limit.` },
            { status: 413 },
          );
        }
        combined += f.size;
      }
      if (combined > COMBINED_MAX) {
        return NextResponse.json(
          { error: "Combined attachments exceed the 50MB limit." },
          { status: 413 },
        );
      }
      attachments = files.map((f) => ({ name: f.name, blob: f }));
      const parsed = schema.safeParse(fields);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid input" },
          { status: 400 },
        );
      }
      payload = parsed.data;
    } else {
      const json = await request.json().catch(() => null);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid input" },
          { status: 400 },
        );
      }
      payload = parsed.data;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bad request" },
      { status: 400 },
    );
  }

  // Server-side auto-CC injection was removed 2026-06-23 — see the
  // import block at the top of this file. payload.cc is now sent
  // verbatim downstream (EmailBison send, Instantly send, the
  // outbound `messages` snapshot). The composer remains the
  // canonical pre-fill source for the always-CC address.

  // Membership check via user-scoped RLS — only members of the workspace
  // owning this thread can see/reply to it.
  const { data: thread } = await userClient
    .from("threads")
    .select("id, workspace_id, lead_id, channel_id, outbound_sender_email, source_provider, instantly_thread_id")
    .eq("id", threadId)
    // Explicit, because RLS is no longer scoping this for us.
    .eq("workspace_id", WORKSPACE_ID)
    .maybeSingle();
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const admin = getMasterInboxSupabase();

  // Resolve the sender override (if supplied) into provider-specific
  // identifiers. The composer's From-dropdown sends sender_channel_id;
  // we look it up here so the downstream send calls don't have to know
  // about the channel layer.
  let senderOverride:
    | {
        emailbisonSenderEmailId: number | null;
        instantlyEaccount: string | null;
        emailbisonTeamId: number | null;
      }
    | null = null;
  if (payload.sender_channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select(
        "id, workspace_id, provider, display_name, emailbison_sender_email_id, instantly_account_id, emailbison_team_id",
      )
      .eq("id", payload.sender_channel_id)
      .eq("workspace_id", thread.workspace_id)
      .maybeSingle();
    if (!ch) {
      return NextResponse.json(
        { error: "Selected sender channel not found in this workspace." },
        { status: 400 },
      );
    }
    const ebId = ch.emailbison_sender_email_id as string | null;
    senderOverride = {
      emailbisonSenderEmailId: ebId ? Number(ebId) : null,
      instantlyEaccount:
        (ch.instantly_account_id as string | null) ??
        (ch.display_name as string | null),
      emailbisonTeamId: (ch.emailbison_team_id as number | null) ?? null,
    };
  }

  // Instantly threads use a completely different send API. Dispatch early so
  // the rest of this handler can stay EmailBison-specific.
  if (thread.source_provider === "instantly") {
    return sendInstantlyReply({
      admin,
      threadId,
      workspaceId: thread.workspace_id,
      outboundSenderEmail:
        senderOverride?.instantlyEaccount ?? thread.outbound_sender_email,
      payload,
      attachments,
    });
  }

  // EmailBison team_id is pinned on the channel (one per sender_email)
  // — workspaces don't carry a team_id anymore in single-tenant BrokerStaffer
  // because brokerstaffer.com has multiple teams feeding one workspace.
  // When the user picks a sender override, use its team instead of the
  // thread's original channel team.
  let ebTeamId: number | null = senderOverride?.emailbisonTeamId ?? null;
  if (ebTeamId === null && thread.channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select("emailbison_team_id")
      .eq("id", thread.channel_id)
      .maybeSingle();
    ebTeamId = (ch?.emailbison_team_id as number | null) ?? null;
  }
  if (ebTeamId === null) {
    return NextResponse.json(
      {
        error:
          "This thread's channel isn't linked to an EmailBison team yet. Wait for the next inbound reply on this sender, or re-register the webhook.",
      },
      { status: 400 },
    );
  }

  // Pick the EmailBison reply to hang our response off of. Same logic as
  // the Instantly path: prefer the user-clicked source message (so the
  // outbound's In-Reply-To header points at the right ancestor for Gmail
  // threading), fall back to the latest inbound for the bottom Reply
  // button which doesn't carry a source_message_id.
  let lastInbound: { id: string; emailbison_reply_id: string | null; raw_payload: unknown } | null = null;
  if (payload.source_message_id) {
    const { data } = await admin
      .from("messages")
      .select("id, emailbison_reply_id, raw_payload")
      .eq("id", payload.source_message_id)
      .eq("thread_id", threadId)
      .maybeSingle();
    lastInbound = data ?? null;
  }
  if (!lastInbound?.emailbison_reply_id) {
    const { data } = await admin
      .from("messages")
      .select("id, emailbison_reply_id, raw_payload")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .not("emailbison_reply_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastInbound = data ?? null;
  }
  if (!lastInbound?.emailbison_reply_id) {
    return NextResponse.json(
      { error: "No inbound EmailBison reply found to reply to." },
      { status: 400 },
    );
  }

  // EmailBison requires sender_email_id when reply_all=false. Pulled from
  // the canonical location in the webhook envelope:
  //   raw_payload.data.sender_email.id
  // This is always present on LEAD_REPLIED — it's OUR connected account
  // that received the reply.
  const inboundPayload = (lastInbound.raw_payload ?? {}) as Record<string, unknown>;
  const dataBlock = inboundPayload.data as Record<string, unknown> | undefined;
  const senderEmailId =
    (dataBlock?.sender_email as { id?: number } | undefined)?.id ?? null;
  if (!senderEmailId) {
    return NextResponse.json(
      { error: "sender_email.id missing from inbound payload — cannot reply." },
      { status: 500 },
    );
  }

  // Default `to` to the lead when none supplied + reply_all is false.
  let toEmails = payload.to;
  if (!payload.reply_all && (!toEmails || toEmails.length === 0)) {
    const { data: lead } = await admin
      .from("leads")
      .select("email, full_name")
      .eq("id", thread.lead_id)
      .maybeSingle();
    if (lead?.email) {
      toEmails = [{ name: lead.full_name ?? null, email_address: lead.email }];
    }
  }

  // Send via EmailBison.
  //
  // When the operator changes the Subject in the composer
  // (payload.subject_changed === true), route through
  // /api/replies/new instead of /api/replies/{id}/reply because the
  // reply endpoint silently drops the subject. /replies/new starts
  // a fresh thread on EmailBison's side — recipient still receives
  // the new subject, which is the whole point. The unchanged-subject
  // case keeps using /reply so EmailBison-side threading is
  // preserved for the common path.
  //
  // The new endpoint requires a non-null sender_email_id. Reply-all
  // sends with a changed subject still need one (the reply endpoint
  // could pass null because EmailBison inferred the sender from
  // the parent reply; /replies/new has no parent to infer from), so
  // we fall back to senderEmailId from the inbound webhook envelope.
  const eb = createEmailBisonClient();
  let newReplyId: number | null = null;
  const effectiveSenderEmailId =
    senderOverride?.emailbisonSenderEmailId ?? senderEmailId;
  const subjectChanged = payload.subject_changed === true;
  try {
    await eb.switchWorkspace(ebTeamId);
    if (subjectChanged) {
      // /api/replies/new — subject-honouring path. Requires a subject
      // (zod-checked above via the optional schema; we coerce empty to
      // the original thread subject as a safety net) and a sender_email_id.
      const subjectForNew =
        (payload.subject ?? "").trim() || "(no subject)";
      if (attachments.length > 0) {
        const res = await eb.composeNewEmailMultipart({
          subject: subjectForNew,
          message: payload.body,
          sender_email_id: effectiveSenderEmailId,
          content_type: payload.content_type,
          to_emails: toEmails,
          cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
          bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
          attachments,
        });
        newReplyId = res?.data?.reply?.id ?? null;
      } else {
        const res = await eb.composeNewEmail({
          subject: subjectForNew,
          message: payload.body,
          sender_email_id: effectiveSenderEmailId,
          content_type: payload.content_type,
          to_emails: toEmails,
          cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
          bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        });
        newReplyId = res?.data?.reply?.id ?? null;
      }
    } else if (attachments.length > 0) {
      const res = await eb.sendReplyMultipart(Number(lastInbound.emailbison_reply_id), {
        message: payload.body,
        content_type: payload.content_type,
        to_emails: toEmails,
        cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
        bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        reply_all: payload.reply_all,
        inject_previous_email_body: payload.inject_previous_email_body,
        sender_email_id: payload.reply_all ? null : effectiveSenderEmailId,
        attachments,
      });
      // Response shape: { data: { success, reply: { id } } }
      newReplyId = res?.data?.reply?.id ?? null;
    } else {
      const res = await eb.sendReply(Number(lastInbound.emailbison_reply_id), {
        message: payload.body,
        content_type: payload.content_type,
        to_emails: toEmails,
        cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
        bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        reply_all: payload.reply_all,
        inject_previous_email_body: payload.inject_previous_email_body,
        sender_email_id: payload.reply_all ? null : effectiveSenderEmailId,
      });
      // Response shape: { data: { success, reply: { id } } }
      newReplyId = res?.data?.reply?.id ?? null;
    }
  } catch (err) {
    // EmailBisonError carries the response body. Surface it so the UI shows
    // what EmailBison actually rejected (422 etc) rather than a vague 502.
    type EBError = { message?: string; status?: number; body?: unknown };
    const e = err as EBError;
    const eBody = e?.body;
    console.error("[reply] EmailBison error:", {
      status: e?.status,
      message: e?.message,
      body: eBody,
    });
    const detail =
      typeof eBody === "string"
        ? eBody.slice(0, 500)
        : eBody
          ? JSON.stringify(eBody).slice(0, 500)
          : undefined;
    return NextResponse.json(
      {
        error: e?.message ?? "EmailBison send failed",
        status: e?.status ?? null,
        detail,
      },
      { status: 502 },
    );
  }

  // Record the outbound message immediately so the UI updates without
  // waiting for the webhook echo. external_message_id MUST match the id
  // the conversation-thread backfill will compute later, otherwise we end
  // up with a duplicate row. We use the new reply id returned from
  // EmailBison's send response — the backfill uses the same `eb:reply:<id>`
  // scheme so the second write becomes an idempotent update.
  const outboundId = newReplyId
    ? `eb:reply:${newReplyId}`
    : `eb-out:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const recipientsPayload = {
    to: toEmails?.map((r) => r.email_address) ?? [],
    cc: payload.cc?.map((r) => r.email_address) ?? [],
    bcc: payload.bcc?.map((r) => r.email_address) ?? [],
  };
  // Compute once so the stored message and the thread's list-preview
  // agree exactly. The thread list shows last_message_preview /
  // last_message_at as the conversation's most-recent activity — so
  // an outbound send must advance them too, otherwise the list keeps
  // showing the lead's last inbound message even after we reply.
  const ebSentAt = new Date().toISOString();
  const ebOutboundText =
    payload.content_type === "text"
      ? payload.body
      : payload.body.replace(/<[^>]+>/g, "");
  await admin.from("messages").insert({
    workspace_id: thread.workspace_id,
    thread_id: threadId,
    direction: "outbound",
    // Sender is the EmailBison sender account that actually sent the
    // message — NOT the logged-in user. They differ when a teammate hits
    // Send on a workspace where someone else owns the sender account.
    sender: thread.outbound_sender_email,
    recipients: recipientsPayload,
    subject: payload.subject ?? null,
    body_html: payload.content_type === "html" ? payload.body : null,
    body_text: ebOutboundText,
    sent_at: ebSentAt,
    external_message_id: outboundId,
    emailbison_reply_id: newReplyId ? String(newReplyId) : null,
  });
  await admin
    .from("threads")
    .update({
      needs_reply: false,
      seen: true,
      last_message_at: ebSentAt,
      last_message_preview: ebOutboundText.slice(0, 200),
    })
    .eq("id", threadId);

  // Mark any pending drafts on this thread as sent — the user has acted on
  // the conversation and we don't want stale "review me" drafts hanging
  // around in the composer.
  await admin
    .from("reply_drafts")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("status", "pending");

  // Delete any composer auto-save on this thread — the operator
  // just sent, so the typed body is no longer "in progress".
  // Best-effort: a failure here MUST NOT fail the user-visible
  // send, the row will simply linger until the next save / discard.
  try {
    await admin
      .from("composer_drafts")
      .delete()
      .eq("workspace_id", thread.workspace_id)
      .eq("thread_id", threadId);
  } catch (err) {
    console.error("[reply] composer_drafts cleanup failed", err);
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Instantly send dispatch.
// Instantly's POST /emails/reply takes the inbound email's UUID as
// `reply_to_uuid` and a single `eaccount` (the mailbox to send from).
// Attachments aren't documented on this endpoint, so we reject them
// explicitly and ask the user to send unattached for now.
// ---------------------------------------------------------------------------
async function sendInstantlyReply(args: {
  admin: ReturnType<typeof getMasterInboxSupabase>;
  threadId: string;
  workspaceId: string;
  outboundSenderEmail: string | null;
  payload: ParsedInput;
  attachments: Array<{ name: string; blob: Blob }>;
}): Promise<NextResponse> {
  const { admin, threadId, workspaceId, outboundSenderEmail, payload, attachments } = args;

  if (attachments.length > 0) {
    return NextResponse.json(
      { error: "Attachments are not supported on Instantly threads yet." },
      { status: 400 },
    );
  }

  // Pick the message Instantly should reply to. Preference order:
  //   1. The specific source message the user clicked Reply on
  //      (payload.source_message_id) — required for correct Gmail threading
  //      when the user replies to an older message in the conversation.
  //   2. Latest inbound on the thread — used by the bottom floating Reply
  //      button (source_message_id will be undefined).
  let replyTarget: { id: string; instantly_email_id: string | null; sender: string | null } | null = null;
  if (payload.source_message_id) {
    const { data } = await admin
      .from("messages")
      .select("id, instantly_email_id, sender")
      .eq("id", payload.source_message_id)
      .eq("thread_id", threadId)
      .maybeSingle();
    replyTarget = data ?? null;
  }
  if (!replyTarget?.instantly_email_id) {
    const { data: lastInbound } = await admin
      .from("messages")
      .select("id, instantly_email_id, sender")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .not("instantly_email_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    replyTarget = lastInbound ?? null;
  }
  if (!replyTarget?.instantly_email_id) {
    return NextResponse.json(
      { error: "No inbound Instantly reply found to reply to." },
      { status: 400 },
    );
  }

  const recipientsCsv = (rows?: Array<{ email_address: string }>): string | undefined => {
    if (!rows || rows.length === 0) return undefined;
    return rows.map((r) => r.email_address).join(",");
  };

  // Forward detection: TO is set AND none of its addresses match the
  // original sender of the inbound being "replied" to. Instantly's
  // /emails/reply silently ignores TO (always returns to the original
  // sender), so for forwards we route through /emails/forward which
  // accepts an arbitrary to_address_email_list while still threading
  // off the source email via reply_to_uuid.
  const originalSenderLower = replyTarget.sender?.toLowerCase() ?? "";
  const toCsv = recipientsCsv(payload.to);
  const isForward =
    Boolean(toCsv) &&
    payload.to !== undefined &&
    payload.to.length > 0 &&
    !payload.to.some(
      (r) => r.email_address.toLowerCase() === originalSenderLower,
    );

  let newEmailId: string | null = null;
  try {
    const instantly = createInstantlyClient();
    if (isForward) {
      if (!outboundSenderEmail) {
        return NextResponse.json(
          {
            error:
              "Forwarding from this Instantly thread needs a sender mailbox; none on file.",
          },
          { status: 400 },
        );
      }
      const res = await instantly.forwardEmail({
        eaccount: outboundSenderEmail,
        reply_to_uuid: replyTarget.instantly_email_id,
        to_address_email_list: toCsv!,
        subject: payload.subject ?? "(forward)",
        body:
          payload.content_type === "html"
            ? { html: payload.body }
            : { text: payload.body },
        cc_address_email_list: recipientsCsv(payload.cc),
        bcc_address_email_list: recipientsCsv(payload.bcc),
        include_original_body: payload.inject_previous_email_body,
      });
      newEmailId = res?.id ?? null;
    } else {
      const res = await instantly.sendReply({
        reply_to_uuid: replyTarget.instantly_email_id,
        subject: payload.subject,
        body:
          payload.content_type === "html"
            ? { html: payload.body }
            : { text: payload.body },
        eaccount: outboundSenderEmail ?? undefined,
        cc_address_email_list: recipientsCsv(payload.cc),
        bcc_address_email_list: recipientsCsv(payload.bcc),
        include_original_body: payload.inject_previous_email_body,
      });
      newEmailId = res?.id ?? null;
    }
  } catch (err) {
    if (err instanceof InstantlyError) {
      console.error("[reply] Instantly error:", {
        status: err.status,
        message: err.message,
        body: err.body,
      });
      const detail =
        typeof err.body === "string"
          ? err.body.slice(0, 500)
          : err.body
            ? JSON.stringify(err.body).slice(0, 500)
            : undefined;
      return NextResponse.json(
        { error: err.message, status: err.status, detail },
        { status: 502 },
      );
    }
    console.error("[reply] Instantly send failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Instantly send failed" },
      { status: 502 },
    );
  }

  // Record the outbound message immediately so the UI updates without
  // waiting for the webhook echo. The eventual `email_sent` webhook (if
  // subscribed) — or the thread backfill on the next inbound — will
  // converge on this row via the matching external_message_id.
  const outboundId = newEmailId
    ? `in:email:${newEmailId}`
    : `in-out:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const recipientsPayload = {
    to: payload.to?.map((r) => r.email_address) ?? [],
    cc: payload.cc?.map((r) => r.email_address) ?? [],
    bcc: payload.bcc?.map((r) => r.email_address) ?? [],
  };
  // Compute once so the stored message and the thread's list-preview
  // agree — an outbound send advances last_message_at / preview so the
  // list reflects our reply as the most-recent activity (mirrors the
  // EmailBison path above).
  const instSentAt = new Date().toISOString();
  const instOutboundText =
    payload.content_type === "text"
      ? payload.body
      : payload.body.replace(/<[^>]+>/g, "");
  await admin.from("messages").insert({
    workspace_id: workspaceId,
    thread_id: threadId,
    direction: "outbound",
    source_provider: "instantly",
    sender: outboundSenderEmail,
    recipients: recipientsPayload,
    subject: payload.subject ?? null,
    body_html: payload.content_type === "html" ? payload.body : null,
    body_text: instOutboundText,
    sent_at: instSentAt,
    external_message_id: outboundId,
    instantly_email_id: newEmailId,
  });
  await admin
    .from("threads")
    .update({
      needs_reply: false,
      seen: true,
      last_message_at: instSentAt,
      last_message_preview: instOutboundText.slice(0, 200),
    })
    .eq("id", threadId);
  await admin
    .from("reply_drafts")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("status", "pending");

  // Same cleanup as the EmailBison path — delete the composer
  // auto-save row best-effort. See the corresponding block above
  // for the rationale.
  try {
    await admin
      .from("composer_drafts")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("thread_id", threadId);
  } catch (err) {
    console.error("[reply] composer_drafts cleanup failed", err);
  }

  return NextResponse.json({ ok: true });
}
