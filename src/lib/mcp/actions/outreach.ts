import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { workspaceId } from "@/lib/tools/master-inbox/supabase";
import { assembleRunInput, handoverVariables } from "@/lib/tools/master-inbox/ai/runtime";
import { planHandover } from "@/lib/tools/master-inbox/ai/qualification";
import { agentBodyHtml, agentSubject } from "@/lib/tools/master-inbox/ai/send-transport";
import { sendOutboundReply } from "@/lib/tools/master-inbox/inbox/send-reply";
import { introSenderFor } from "@/lib/tools/master-inbox/inbox/intro-sender";
import { mergeAlwaysCcString } from "@/lib/tools/master-inbox/inbox/auto-cc";
import { applyLabelToThread } from "@/lib/tools/master-inbox/inbox/apply-label";
import { rosterRowForPortal } from "@/lib/tools/master-inbox/clients/roster-for-portal";
import { directHandoffReason } from "@/lib/tools/master-inbox/relay/settings";
import { isHostileLabel } from "@/lib/tools/master-inbox/inbox/dnc";
import { isStopContactLabel } from "@/lib/tools/master-inbox/portals/stop-person-plan";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";
import { threadSummary } from "./inbox.ts";

/*
 * Positive replies through Claude (27 Nov, the user picked "Positive replies" first): INTRODUCE a lead to its client,
 * and REPLY to a lead. Both send real email, so both preview the whole email and send exactly what was previewed.
 *
 * INTRODUCE = the reply agent's hand-over, which is the Introduce button's email (ai/qualification.ts planHandover:
 * the intro macro, territory people, wording variants, the client's subject), sent the way the hand-over is sent
 * (ai/send-transport.ts dispatch: from the introductions mailbox, as a new email with the intro subject, To the lead,
 * Cc the client's people) plus the always-Cc the button adds — through the composer's own send (sendOutboundReply) —
 * then labelled Introduction through applyLabelToThread, which makes the client's portal entry and runs the SMS /
 * Slack / Follow Up Boss announcements. Checks the button lacks are added: a stop label, already introduced, and
 * clients who get interested replies by direct hand-off (they are never introduced).
 * REPLY = the composer's Send (sendOutboundReply): in the conversation, "Re:" subject, To the lead.
 */

const needs = (path: string): ToolId[] => (grantsForRequest(path, "POST") ?? []) as ToolId[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const isStop = (label: string | null) => isStopContactLabel(label) || isHostileLabel(label);
/* BrokerStaffer stopped using Instantly (last send 8 Sep 2026): nothing is sent through it from Claude (27 Nov). */
const INSTANTLY_REFUSAL = "This conversation came through Instantly, which BrokerStaffer no longer uses, so nothing is sent on it through Claude. If it still needs an answer, do it in the Master Inbox.";

async function latestInboundId(admin: ReturnType<typeof createAdminSupabase>, threadId: string): Promise<string | null> {
  const { data } = await admin.from("messages").select("id").eq("thread_id", threadId).eq("direction", "inbound").order("sent_at", { ascending: false }).limit(1);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

/* The newest email sent on the conversation: a confirm is bound to it, so a second confirm after a send is refused. */
async function latestOutbound(admin: ReturnType<typeof createAdminSupabase>, threadId: string): Promise<Array<{ id: string; subject: string | null; sent_at: string | null }>> {
  const { data } = await admin.from("messages").select("id, subject, sent_at").eq("thread_id", threadId).eq("direction", "outbound").order("sent_at", { ascending: false }).limit(20);
  return (data ?? []) as Array<{ id: string; subject: string | null; sent_at: string | null }>;
}

async function everIntroduced(admin: ReturnType<typeof createAdminSupabase>, threadId: string): Promise<boolean> {
  const { data, error } = await admin.from("label_history").select("id").eq("thread_id", threadId).eq("label_name", "Introduction").limit(1);
  return !!error || ((data ?? []) as unknown[]).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// inbox_introduce
// ---------------------------------------------------------------------------------------------------------------------

type IntroArgs = { thread_id: string };
type IntroBind = { label: string | null; inbound: string | null; outbound: string | null; to: string; toName: string | null; cc: string[]; subject: string; body: string; senderChannelId: string | null };

export const inboxIntroduce: ActionSpec<IntroArgs, IntroBind> = {
  name: "inbox_introduce",
  title: "Introduce a lead to its client",
  description:
    "Introduce the lead in one Master Inbox conversation to the conversation's client, as the inbox's Introduce button " +
    "does: an introduction email from the introductions mailbox To the lead, Cc the client's people, then the " +
    "Introduction label (the client's portal gets the lead; SMS, Slack and Follow Up Boss as set up). The preview shows " +
    "the whole email. Refused for a lead with a stop label, a conversation already introduced, and clients who get " +
    "interested replies by direct hand-off.",
  inputSchema: { type: "object", properties: { thread_id: { type: "string", description: "The conversation's thread_id (positive_replies, recent_replies, search_conversations)." } }, required: ["thread_id"] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  needs: needs("/api/tools/master-inbox/threads/x/reply"),
  parse(a) {
    const thread_id = String(a.thread_id ?? "").trim();
    return UUID.test(thread_id) ? { thread_id } : { error: "thread_id must be a conversation's id." };
  },
  async preview(a) {
    const admin = createAdminSupabase();
    const ws = await workspaceId();
    const t = await threadSummary(a.thread_id);
    if (!t) return { ok: false, refusal: "No conversation with that thread_id." };
    if (isStop(t.label)) return { ok: false, refusal: `This lead is labelled ${t.label}: they are not to be contacted.` };
    if ((t.label ?? "").toLowerCase() === "introduction" || (await everIntroduced(admin, a.thread_id))) {
      return { ok: false, refusal: "This conversation has already been introduced; a second introduction email is not sent through Claude." };
    }
    const input = await assembleRunInput(ws, a.thread_id);
    if (!input) return { ok: false, refusal: "That conversation couldn't be read." };
    if (!input.leadEmail) return { ok: false, refusal: "The lead has no email address on this conversation." };
    if (input.clientId && t.client) {
      const found = await rosterRowForPortal(input.clientId, t.client, "pipeline_entry, relay_settings");
      if (found.readFailed || found.error) return { ok: false, refusal: `${t.client}'s client record couldn't be read, so it isn't known whether it gets introductions. Nothing was sent.` };
      const handoff = found.row ? directHandoffReason(found.row, t.client) : null;
      if (handoff) return { ok: false, refusal: `${handoff} (no introduction email; the hand-off sends it).` };
    }
    const plan = planHandover({ message: "", ccEmails: [] } as never, {
      client: input.introduction.client,
      unavailableReason: input.introduction.unavailableReason,
      variables: handoverVariables(input),
    });
    if (plan.kind === "stop") return { ok: false, refusal: `No introduction can be written: ${plan.detail}.` };
    const provider = (await admin.from("threads").select("source_provider").eq("id", a.thread_id).maybeSingle()).data?.source_provider as string | null;
    if ((provider ?? "").toLowerCase() === "instantly") return { ok: false, refusal: INSTANTLY_REFUSAL };
    // The introduction greets the lead by first name ("Hey {{lead.first_name}},"). With none on record it would open
    // "Hey ," and name nobody; the inbox's Introduce button lets someone fix that in the composer, Claude sends as previewed.
    if (!(input.leadName ?? "").trim() || /^\s*(hey|hi|hello)\s*,/i.test(plan.body)) {
      return { ok: false, refusal: "This lead has no name on record, so the introduction would open \"Hey ,\" and name nobody. Introduce them from the Master Inbox, where the email can be edited before it goes." };
    }
    // An introduction already sent here whose label never landed (the send worked, the labelling failed): never a second.
    const sentBefore = await latestOutbound(admin, a.thread_id);
    const earlier = sentBefore.find((m) => (m.subject ?? "").trim().toLowerCase() === plan.subject.trim().toLowerCase());
    if (earlier) return { ok: false, refusal: `An introduction ("${plan.subject}") was already sent on this conversation${earlier.sent_at ? ` on ${earlier.sent_at.slice(0, 10)}` : ""}, but it isn't labelled Introduction. Label it in the Master Inbox; a second introduction isn't sent through Claude.` };
    const sender = await introSenderFor(admin, ws, provider ?? "emailbison");
    const cc = mergeAlwaysCcString(plan.cc.join(", "), input.leadEmail).split(/,\s*/).filter(Boolean);
    const from = sender.channelId ? `${sender.name ?? ""} <${sender.email}>`.trim() : `the campaign's own mailbox (${sender.problem ?? "no introductions mailbox on this platform"})`;
    return {
      ok: true,
      preview:
        `Introduce ${t.lead} to ${t.client}. Email — From: ${from}. To: ${input.leadName ? `${input.leadName} ` : ""}<${input.leadEmail}>. ` +
        `Cc: ${cc.join(", ")}. Subject: "${plan.subject}". Text:\n${plan.body}\n` +
        `Then it is labelled Introduction: ${t.client}'s portal gets the lead, and the SMS alert, the Slack introduction post ` +
        "and Follow Up Boss run as set up for this client.",
      details: { thread: t, from, to: input.leadEmail, cc, subject: plan.subject, body: plan.body },
      bind: { label: t.label, inbound: await latestInboundId(admin, a.thread_id), outbound: sentBefore[0]?.id ?? null, to: input.leadEmail, toName: input.leadName, cc, subject: plan.subject, body: plan.body, senderChannelId: sender.channelId ?? null },
    };
  },
  async execute(a, v, bind) {
    const admin = createAdminSupabase();
    const ws = await workspaceId();
    const sent = await sendOutboundReply({
      admin, workspaceId: ws, threadId: a.thread_id, senderChannelId: bind.senderChannelId ?? undefined,
      body: { kind: "html", html: agentBodyHtml(bind.body) }, subject: bind.subject, subjectChanged: true,
      to: [{ email_address: bind.to, ...(bind.toName ? { name: bind.toName } : {}) }], cc: bind.cc.map((email_address) => ({ email_address })),
      bcc: undefined, replyAll: false, injectPreviousEmailBody: true, actor: { kind: "user", userId: null },
    } as never);
    if (!sent.ok) throw new Error(`Nothing was sent: ${sent.body.error}${sent.body.detail ? ` (${sent.body.detail})` : ""}`);
    console.info(`[mcp-action] ${v.email} via Claude: introduction sent ${a.thread_id}`);
    const { data: label } = await admin.from("labels").select("id").eq("workspace_id", ws).ilike("name", "Introduction").maybeSingle();
    if (!label?.id) return { sent: true, labelled: false, note: "The email was sent, but the Introduction label doesn't exist; label it in the inbox." };
    const r = await applyLabelToThread({ supabase: admin, workspaceId: ws, threadId: a.thread_id, labelId: label.id as string, actor: { kind: "user", userId: null } } as never);
    if (!r.ok) return { sent: true, labelled: false, note: `The email was sent, but labelling failed (${r.error}); label it Introduction in the inbox.` };
    return { sent: true, labelled: true };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// inbox_reply
// ---------------------------------------------------------------------------------------------------------------------

type ReplyArgs = { thread_id: string; text: string; cc: string[] };
type ReplyBind = { label: string | null; inbound: string | null; outbound: string | null; to: string; cc: string[]; subject: string | null };

export const inboxReply: ActionSpec<ReplyArgs, ReplyBind> = {
  name: "inbox_reply",
  title: "Reply to a lead",
  description:
    "Send a reply to the lead in one Master Inbox conversation, as the inbox's composer does: in the same conversation, " +
    "from its mailbox, \"Re:\" subject, To the lead, optional Cc. Plain text. The preview shows the whole email. " +
    "Refused for a lead with a stop label (Unsubscribe, Do Not Contact, Hostile, Add to Blocklist).",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The conversation's thread_id." },
      text: { type: "string", description: "The reply, plain text, as it should read." },
      cc: { type: "array", items: { type: "string" }, description: "Optional extra addresses to copy in." },
    },
    required: ["thread_id", "text"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  needs: needs("/api/tools/master-inbox/threads/x/reply"),
  parse(a) {
    const thread_id = String(a.thread_id ?? "").trim();
    const text = String(a.text ?? "").trim();
    const cc = Array.isArray(a.cc) ? a.cc.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!UUID.test(thread_id)) return { error: "thread_id must be a conversation's id." };
    if (!text) return { error: "What should the reply say?" };
    if (text.length > 5000) return { error: "Keep the reply under 5,000 characters." };
    const bad = cc.filter((e) => !EMAIL.test(e));
    if (bad.length) return { error: `Not email addresses: ${bad.join(", ")}.` };
    return { thread_id, text, cc };
  },
  async preview(a) {
    const admin = createAdminSupabase();
    const t = await threadSummary(a.thread_id);
    if (!t) return { ok: false, refusal: "No conversation with that thread_id." };
    if (isStop(t.label)) return { ok: false, refusal: `This lead is labelled ${t.label}: they are not to be contacted.` };
    if (t.status === "trash") return { ok: false, refusal: "That conversation is in the trash." };
    const { data: th } = await admin.from("threads").select("subject, outbound_sender_email, source_provider, leads:lead_id(email, full_name)").eq("id", a.thread_id).maybeSingle();
    if (String((th as { source_provider?: unknown } | null)?.source_provider ?? "").toLowerCase() === "instantly") return { ok: false, refusal: INSTANTLY_REFUSAL };
    const lead = Array.isArray(th?.leads) ? th?.leads[0] : th?.leads;
    const to = (lead as { email?: string } | null)?.email ?? null;
    if (!to) return { ok: false, refusal: "The lead has no email address on this conversation." };
    const subject = agentSubject((th?.subject as string | null) ?? null) ?? null;
    // The composer's own Cc: the always-copied address added to whatever was asked (auto-cc.ts), never the lead twice.
    const cc = mergeAlwaysCcString(a.cc.join(", "), to).split(/,\s*/).filter(Boolean);
    return {
      ok: true,
      preview: `Reply in ${t.lead}'s conversation${t.client ? ` (${t.client})` : ""}. From: ${(th?.outbound_sender_email as string | null) ?? "the conversation's mailbox"}. To: ${to}.${cc.length ? ` Cc: ${cc.join(", ")}.` : ""} Subject: "${subject ?? "(the conversation's)"}". Text:\n${a.text}`,
      details: { thread: t, to, cc, subject },
      bind: { label: t.label, inbound: await latestInboundId(admin, a.thread_id), outbound: (await latestOutbound(admin, a.thread_id))[0]?.id ?? null, to, cc, subject },
    };
  },
  async execute(a, v, bind) {
    const admin = createAdminSupabase();
    const sent = await sendOutboundReply({
      admin, workspaceId: await workspaceId(), threadId: a.thread_id,
      body: { kind: "html", html: agentBodyHtml(a.text) }, subject: bind.subject ?? undefined, subjectChanged: false,
      to: [{ email_address: bind.to }], cc: bind.cc.map((email_address) => ({ email_address })),
      bcc: undefined, replyAll: false, injectPreviousEmailBody: true, actor: { kind: "user", userId: null },
    } as never);
    if (!sent.ok) throw new Error(`Nothing was sent: ${sent.body.error}${sent.body.detail ? ` (${sent.body.detail})` : ""}`);
    console.info(`[mcp-action] ${v.email} via Claude: reply sent ${a.thread_id}`);
    return { sent: true, to: bind.to };
  },
};
