/*
 * The pure half of the EmailBison sync: envelope → row.
 *
 * Lifted verbatim from the tool's lib/sync/emailbison.ts so that
 * `node --test` can exercise the mapping without a database. Nothing here
 * touches Supabase or the network; sync/emailbison.ts imports these and does
 * the writes.
 */

import type {
  EmailBisonWebhookEnvelope,
  EmailBisonLead,
  EmailBisonReply,
  EmailBisonEventBlock,
  EmailBisonDataBlock,
} from "../emailbison/types.ts";

// Normalise an EmailBison recipient field (to / cc / bcc) to a flat
// string[] of email addresses. Matches the canonical shape Instantly
// stores (`{to: [], cc: [], bcc: []}`) so the thread-view UI's
// recipientField helper renders the row correctly. EmailBison ships these
// in several runtime shapes depending on event source — and the two
// TypeScript declarations for the field (EmailBisonReply in
// emailbison/types.ts vs ConvReply in emailbison/client.ts) disagree on
// the element shape — so we accept `unknown` and decide at runtime:
//   • Array<{name?: string, address?: string}>  — webhook envelope + REST API
//   • Array<string>                              — already-normalised paths
//   • string (comma- or semicolon-joined)        — some legacy paths
//   • null / undefined                           — no recipients
export function normalizeRecipientList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const r of raw) {
      if (typeof r === "string") {
        if (r.includes("@")) out.push(r.trim());
        continue;
      }
      if (r && typeof r === "object") {
        const rec = r as { address?: unknown; email?: unknown };
        const addr =
          typeof rec.address === "string"
            ? rec.address
            : typeof rec.email === "string"
              ? rec.email
              : null;
        if (addr && addr.includes("@")) out.push(addr.trim());
      }
    }
    return out;
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
  }
  return [];
}

// EmailBison's real webhook deliveries are UNWRAPPED — `{ event, data }` at
// the top level. The OpenAPI test-event sample shows a wrapped shape
// `{ data: { event, data } }`. Accept both so tests + real deliveries work.
export function unwrapEnvelope(envelope: EmailBisonWebhookEnvelope): {
  eventBlock: EmailBisonEventBlock | undefined;
  payload: EmailBisonDataBlock;
  eventType: string | undefined;
} {
  const eventBlock = envelope?.event ?? (envelope?.data as { event?: EmailBisonEventBlock })?.event;
  const dataBlock =
    envelope?.event && envelope.data
      ? (envelope.data as EmailBisonDataBlock)
      : ((envelope?.data as { data?: EmailBisonDataBlock })?.data ?? {});
  return {
    eventBlock,
    payload: dataBlock ?? {},
    eventType: eventBlock?.type?.toLowerCase(),
  };
}

export function leadFields(lead: EmailBisonLead) {
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null;
  const customFields = lead.custom_variables
    ? Object.fromEntries(lead.custom_variables.map((v) => [v.name, v.value]))
    : {};
  return {
    full_name: fullName,
    email: lead.email,
    company: lead.company ?? null,
    title: lead.title ?? null,
    custom_fields: customFields,
  };
}

export function threadExternalId(ebLeadId: number, ebCampaignId: number | undefined): string {
  const campaign = ebCampaignId ? String(ebCampaignId) : "none";
  return `eb:lead:${ebLeadId}:campaign:${campaign}`;
}

// Use the reply id directly — single canonical scheme across send-time
// inserts and conversation-thread backfill so dedupe is reliable.
export function replyExternalId(replyId: number): string {
  return `eb:reply:${replyId}`;
}

/** Outbound scheduled sends, from /leads/{id}/sent-emails. */
export function scheduledExternalId(scheduledId: number): string {
  return `eb:sched:${scheduledId}`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function inboundFromReply(reply: EmailBisonReply, leadEmail: string | null = null) {
  const externalMessageId = replyExternalId(reply.id);
  // TO precedence: structured reply.to[] first (preserves multiple
  // recipients when the lead sent to multiple addresses, e.g. when
  // they CC'd both us and a colleague back), with the
  // primary_to_email_address as the fallback for shapes where only
  // that scalar field is set.
  const toFromArray = normalizeRecipientList(reply.to);
  const to = toFromArray.length > 0
    ? toFromArray
    : reply.primary_to_email_address
      ? [reply.primary_to_email_address]
      : [];
  // EmailBison ships from_name on most reply payloads — store it so
  // the thread view doesn't have to fall back to titlecasing the
  // local-part of the From address.
  const senderName =
    typeof reply.from_name === "string" && reply.from_name.trim().length > 0
      ? reply.from_name.trim().slice(0, 200)
      : null;
  return {
    direction: "inbound" as const,
    externalMessageId,
    // Inbound = sent by the lead. The webhook always carries the lead's
    // address in payload.lead.email; reply.from_email_address may be a
    // different envelope (autoresponder, alias) — prefer the canonical
    // lead.email so we never end up with a null sender.
    sender: reply.from_email_address ?? leadEmail ?? reply.from_name ?? null,
    sender_name: senderName,
    recipients: {
      to,
      cc: normalizeRecipientList(reply.cc),
      bcc: normalizeRecipientList(reply.bcc),
    },
    subject: reply.email_subject ?? null,
    body_html: reply.html_body ?? null,
    body_text: reply.text_body ?? null,
    sent_at: reply.date_received ?? new Date().toISOString(),
    emailbison_reply_id: String(reply.id),
  };
}
