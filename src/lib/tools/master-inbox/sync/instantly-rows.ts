/*
 * The pure half of the Instantly sync: envelope → row.
 *
 * Lifted verbatim from the tool's lib/sync/instantly.ts so that
 * `node --test` can exercise the mapping without a database. Nothing here
 * touches Supabase or the network; sync/instantly.ts imports these and does
 * the writes.
 */

import type { InstantlyEmail, InstantlyWebhookEnvelope } from "../instantly/types.ts";

// Build the lead.custom_fields jsonb from every field on the envelope that
// isn't part of the canonical message/metadata set. Instantly enriches leads
// with phone, jobTitle, license number, GCI, etc. — we want all
// of that preserved on the lead row.
export function deriveCustomFields(envelope: InstantlyWebhookEnvelope): Record<string, unknown> {
  const RESERVED = new Set([
    "event_type", "timestamp", "workspace", "unibox_url",
    "email_id", "reply_subject", "reply_text", "reply_text_snippet", "reply_html",
    "email_account", "campaign_id", "campaign_name", "is_first", "step", "variant",
    "lead_email", "email", "firstName", "lastName", "companyName",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (RESERVED.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

/** The lead's address; Instantly ships it under either key. */
export function leadEmailOf(envelope: InstantlyWebhookEnvelope): string | null {
  return envelope.lead_email ?? envelope.email ?? null;
}

export function leadFullName(envelope: InstantlyWebhookEnvelope): string | null {
  return [envelope.firstName, envelope.lastName].filter(Boolean).join(" ") || null;
}

export function threadExternalId(leadEmail: string, campaignId: string | null | undefined): string {
  // Mirror of EmailBison's `eb:lead:X:campaign:Y` scheme so threading
  // behaves identically across providers.
  return `in:lead:${leadEmail}:campaign:${campaignId ?? "none"}`;
}

/** Per-message idempotency key — the same for the webhook and the /emails backfill. */
export function messageExternalId(emailId: string): string {
  return `in:email:${emailId}`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Body: prefer reply_text (already plain text), fall back to stripped HTML,
// then to the snippet Instantly provides for previews.
export function bodyTextOf(envelope: InstantlyWebhookEnvelope): string | null {
  return (
    envelope.reply_text ??
    (envelope.reply_html ? stripHtml(envelope.reply_html) : null) ??
    envelope.reply_text_snippet ??
    null
  );
}

/** The `messages` row for the triggering reply, minus raw_payload (first write only). */
export function inboundMessageRow(args: {
  workspaceId: string;
  channelId: string | null;
  threadId: string;
  emailId: string;
  envelope: InstantlyWebhookEnvelope;
  bodyText: string | null;
}) {
  const { workspaceId, channelId, threadId, emailId, envelope, bodyText } = args;
  return {
    workspace_id: workspaceId,
    thread_id: threadId,
    channel_id: channelId,
    source_provider: "instantly" as const,
    direction: "inbound" as const,
    sender: leadEmailOf(envelope),
    recipients: envelope.email_account ? { to: [envelope.email_account] } : {},
    subject: envelope.reply_subject ?? null,
    body_html: envelope.reply_html ?? null,
    body_text: bodyText,
    sent_at: envelope.timestamp ?? new Date().toISOString(),
    external_message_id: messageExternalId(emailId),
    instantly_email_id: emailId,
  };
}

// Parse Instantly's recipient fields into our normalised JSONB shape. The
// API ships two parallel representations — `to_address_email_list` (CSV)
// and `to_address_json` (typed array). Prefer the JSON form when present.
export function parseRecipients(email: InstantlyEmail): Record<string, unknown> {
  const split = (csv: string | null | undefined): string[] =>
    csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const json = (rows: { address?: string }[] | undefined): string[] =>
    rows ? rows.map((r) => r.address ?? "").filter(Boolean) : [];
  return {
    to: email.to_address_json ? json(email.to_address_json) : split(email.to_address_email_list),
    cc: email.cc_address_json ? json(email.cc_address_json) : split(email.cc_address_email_list),
    bcc: email.bcc_address_json ? json(email.bcc_address_json) : split(email.bcc_address_email_list),
  };
}

// Direction by mailbox identity, NOT ue_type. Live shows Instantly's
// ue_type takes at least three values: 1 = sent (initial), 3 = sent
// (reply/manual?), 2 = received. Treating only 1 as outbound misroutes
// ue_type=3 rows into inbound. The from-address vs eaccount comparison
// catches every case and degrades cleanly when ue_type is missing.
export function directionForEmail(email: InstantlyEmail): "inbound" | "outbound" {
  const from = email.from_address_email?.toLowerCase();
  const mailbox = email.eaccount?.toLowerCase();
  if (from && mailbox && from === mailbox) return "outbound";
  if (email.ue_type === 1 || email.ue_type === 3) return "outbound";
  if (email.ue_type === 2) return "inbound";
  return "inbound";
}

/** The `messages` row for one /emails record, minus raw_payload (first write only). */
export function historicalEmailRow(args: {
  workspaceId: string;
  channelId: string | null;
  threadId: string;
  email: InstantlyEmail;
}) {
  const { workspaceId, channelId, threadId, email } = args;
  const html = email.body?.html ?? null;
  const text = email.body?.text ?? (html ? stripHtml(html) : null);

  // `from_address_json` is the structured From header from
  // /emails/{id} — first entry's `name` is the display name we want
  // ("Howe Realty Growth" for growth@howerealtygroup.com, etc.).
  // Trim + length-cap so a wild header doesn't blow up the column.
  const fromJsonName = email.from_address_json?.[0]?.name;
  const senderName =
    typeof fromJsonName === "string" && fromJsonName.trim().length > 0
      ? fromJsonName.trim().slice(0, 200)
      : null;
  return {
    workspace_id: workspaceId,
    thread_id: threadId,
    channel_id: channelId,
    source_provider: "instantly" as const,
    direction: directionForEmail(email),
    sender: email.from_address_email ?? null,
    sender_name: senderName,
    recipients: parseRecipients(email),
    subject: email.subject ?? null,
    body_html: html,
    body_text: text,
    sent_at: email.timestamp_email ?? email.timestamp_created ?? new Date().toISOString(),
    external_message_id: messageExternalId(email.id),
    instantly_email_id: email.id,
  };
}
