import { createAdminSupabase } from "@/lib/supabase/admin";
import { createInstantlyClient } from "@/lib/tools/master-inbox/instantly/client";
import { labelInboundMessage } from "@/lib/tools/master-inbox/ai/run";
import { loadAgents, loadAgentWithKey, createDraftForAgent } from "@/lib/tools/master-inbox/ai/agent";
import { deriveClientIdFromCampaign } from "@/lib/tools/master-inbox/clients/derive";
import type { InstantlyEmail, InstantlyWebhookEnvelope } from "@/lib/tools/master-inbox/instantly/types";
import {
  bodyTextOf,
  deriveCustomFields,
  historicalEmailRow,
  inboundMessageRow,
  leadEmailOf,
  leadFullName,
  messageExternalId,
  stripHtml,
  threadExternalId,
} from "./instantly-rows.ts";

// Ported from the tool's lib/sync/instantly.ts. The envelope → row mapping
// lives in ./instantly-rows.ts so it can be tested without a database; the
// writes and the provider calls are here, unchanged in order and shape.
//
// Inbound-only sync for Instantly's `reply_received` event.
//
// Real envelope shape (verified live, NOT what the public docs claim):
// flat fields — `email_id`, `lead_email`, `campaign_id`, `campaign_name`,
// `reply_subject`, `reply_text`, `reply_html`, `email_account`, plus
// arbitrary lead custom variables at the top level (firstName, companyName,
// LicenseNumber, ...). See InstantlyWebhookEnvelope.
//
// Threading: Instantly doesn't put `thread_id` directly on the webhook —
// only in `unibox_url`. We use the same `(lead, campaign)` synthetic key
// as EmailBison's threading model so the inbox UX behaves the same way
// regardless of source: one thread per (lead_email, campaign_id).
//
// Outbound channels are auto-created the first time we see a new
// `email_account` (the OUR-side mailbox). The user never sets these up.

interface SyncContext {
  workspaceId: string;
  channelId: string | null;
}

async function resolveContext(eaccount: string | null | undefined): Promise<SyncContext | null> {
  const supabase = createAdminSupabase();

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!ws) return null;

  let channelId: string | null = null;
  if (eaccount) {
    const { data: existing } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", ws.id)
      .eq("provider", "instantly")
      .eq("instantly_account_id", eaccount)
      .maybeSingle();
    if (existing) {
      channelId = existing.id;
    } else {
      const { data: created } = await supabase
        .from("channels")
        .insert({
          workspace_id: ws.id,
          type: "email",
          provider: "instantly",
          display_name: eaccount,
          instantly_account_id: eaccount,
          status: "connected",
          last_synced_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      channelId = created?.id ?? null;
    }
  }

  return { workspaceId: ws.id, channelId };
}

async function upsertLead(
  ctx: SyncContext,
  envelope: InstantlyWebhookEnvelope,
): Promise<string | null> {
  const leadEmail = leadEmailOf(envelope);
  if (!leadEmail) return null;

  const supabase = createAdminSupabase();
  const now = new Date().toISOString();
  const fullName = leadFullName(envelope);
  const customFields = deriveCustomFields(envelope);

  // Lookup by (workspace, email) — Instantly doesn't ship a stable lead UUID
  // on the webhook payload, so email is the canonical identity. We scope the
  // match to leads that DON'T already belong to EmailBison so that the same
  // address appearing in both providers gets two separate lead rows (one per
  // provider) instead of being merged into a single EB-origin lead.
  const { data: existing } = await supabase
    .from("leads")
    .select("id, custom_fields")
    .eq("workspace_id", ctx.workspaceId)
    .eq("email", leadEmail)
    .is("emailbison_lead_id", null)
    .maybeSingle();

  if (existing) {
    // Merge custom_fields rather than overwrite — different webhooks might
    // carry different subsets of enrichment data.
    const merged = { ...(existing.custom_fields as Record<string, unknown> ?? {}), ...customFields };
    await supabase
      .from("leads")
      .update({
        full_name: fullName ?? undefined,
        company: envelope.companyName ?? undefined,
        title: envelope.jobTitle ?? undefined,
        custom_fields: merged,
        last_activity_at: now,
      })
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("leads")
    .insert({
      workspace_id: ctx.workspaceId,
      email: leadEmail,
      full_name: fullName,
      company: envelope.companyName ?? null,
      title: envelope.jobTitle ?? null,
      custom_fields: customFields,
      source_campaign_id: envelope.campaign_id ?? null,
      first_seen_at: now,
      last_activity_at: now,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[instantly] lead insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

async function upsertThread(
  ctx: SyncContext,
  ourLeadId: string,
  externalThreadId: string,
  defaults: {
    subject?: string | null;
    last_message_at: string;
    last_message_preview?: string | null;
    needs_reply: boolean;
    seen: boolean;
    outbound_sender_email?: string | null;
    client_id?: string | null;
    campaign_id?: string | null;
    campaign_name?: string | null;
  },
): Promise<string | null> {
  const supabase = createAdminSupabase();
  const { data: existing } = await supabase
    .from("threads")
    .select("id, subject, client_id, campaign_name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("instantly_thread_id", externalThreadId)
    .maybeSingle();

  const update: Record<string, unknown> = {
    lead_id: ourLeadId,
    channel_id: ctx.channelId,
    source_provider: "instantly",
    last_message_at: defaults.last_message_at,
    needs_reply: defaults.needs_reply,
    seen: defaults.seen,
  };
  if (defaults.subject) update.subject = defaults.subject;
  if (defaults.last_message_preview !== undefined) {
    update.last_message_preview = defaults.last_message_preview?.slice(0, 200) ?? null;
  }
  if (defaults.outbound_sender_email !== undefined) {
    update.outbound_sender_email = defaults.outbound_sender_email;
  }
  if (defaults.client_id !== undefined) update.client_id = defaults.client_id;
  if (defaults.campaign_id !== undefined) update.campaign_id = defaults.campaign_id;
  if (defaults.campaign_name !== undefined) update.campaign_name = defaults.campaign_name;

  if (existing) {
    if (existing.subject) delete update.subject;
    if (existing.client_id) delete update.client_id;
    if (existing.campaign_name) {
      // First-set wins on campaign_name (and campaign_id together).
      delete update.campaign_name;
      delete update.campaign_id;
    }
    await supabase
      .from("threads")
      .update(update)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("threads")
    .insert({
      workspace_id: ctx.workspaceId,
      ...update,
      instantly_thread_id: externalThreadId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[instantly] thread insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

async function upsertMessage(args: {
  ctx: SyncContext;
  threadId: string;
  emailId: string;
  envelope: InstantlyWebhookEnvelope;
  bodyText: string | null;
}): Promise<void> {
  const supabase = createAdminSupabase();
  const { ctx, threadId, emailId, envelope, bodyText } = args;
  const row = inboundMessageRow({
    workspaceId: ctx.workspaceId,
    channelId: ctx.channelId,
    threadId,
    emailId,
    envelope,
    bodyText,
  });

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("external_message_id", row.external_message_id)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("messages")
      .update(row)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", existing.id);
  } else {
    const { error } = await supabase.from("messages").insert({
      ...row,
      raw_payload: envelope as object,
    });
    if (error) console.error("[instantly] message insert failed", error);
  }
}

// Upserts one historical email row (sent or received) by external_message_id.
// First write wins on raw_payload so we never clobber the original webhook
// envelope with the slimmer /emails listing record.
async function upsertHistoricalEmail(
  ctx: SyncContext,
  threadId: string,
  email: InstantlyEmail,
): Promise<void> {
  const supabase = createAdminSupabase();
  const row = historicalEmailRow({
    workspaceId: ctx.workspaceId,
    channelId: ctx.channelId,
    threadId,
    email,
  });

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("external_message_id", row.external_message_id)
    .maybeSingle();

  if (existing) {
    // Preserve raw_payload (first write wins). Update everything else so
    // body/subject corrections from the canonical /emails row land.
    await supabase
      .from("messages")
      .update(row)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", existing.id);
  } else {
    const { error } = await supabase.from("messages").insert({
      ...row,
      raw_payload: email as object,
    });
    if (error) console.error("[instantly] historical email insert failed", error);
  }
}

// Pulls the full per-(lead, campaign) conversation from Instantly and
// upserts every email. Idempotent via the unique
// (workspace_id, external_message_id) index on messages.
//
// We DO NOT use the `thread_id` filter on /emails — verified live that it
// is broken (ignored; returns the full mailbox). The `lead + campaign_id`
// pair is the correct precision: it returns the exact 3-or-so emails of
// the back-and-forth and shares Instantly's per-conversation thread_id.
async function backfillInstantlyConversation(
  ctx: SyncContext,
  ourThreadId: string,
  leadEmail: string,
  campaignId: string | null | undefined,
): Promise<void> {
  if (!campaignId) return;
  try {
    const client = createInstantlyClient();
    const res = await client.listEmails({
      lead: leadEmail,
      campaign_id: campaignId,
      limit: 100,
    });
    for (const email of res.items ?? []) {
      await upsertHistoricalEmail(ctx, ourThreadId, email);
    }
  } catch (err) {
    console.error("[instantly] backfill conversation failed", err);
  }
}

// All early-return failures in handleInstantlyEvent flow through this
// helper. They were previously silent — only a console.log of the raw
// envelope, no labelled drop event — which made it impossible to grep
// Railway for "what happened to this reply". Now every drop emits a
// single `[instantly drop]` line tagged with reason + identifiers.
function dropReply(
  reason: string,
  envelope: InstantlyWebhookEnvelope,
  extra: Record<string, unknown> = {},
): { ok: false; reason: string } {
  console.warn(
    "[instantly drop]",
    JSON.stringify({
      reason,
      email_id: envelope.email_id ?? null,
      lead: leadEmailOf(envelope),
      campaign_id: envelope.campaign_id ?? null,
      campaign_name: envelope.campaign_name ?? null,
      eaccount: envelope.email_account ?? null,
      timestamp: envelope.timestamp ?? null,
      ...extra,
    }),
  );
  return { ok: false, reason };
}

export async function handleInstantlyEvent(envelope: InstantlyWebhookEnvelope): Promise<{
  ok: boolean;
  reason?: string;
}> {
  // Receipt marker — one line per webhook so we can correlate against
  // Instantly's send log when a reply goes missing.
  console.log(
    "[instantly recv]",
    JSON.stringify({
      email_id: envelope.email_id ?? null,
      lead: leadEmailOf(envelope),
      campaign_id: envelope.campaign_id ?? null,
      event: envelope.event_type ?? null,
      timestamp: envelope.timestamp ?? null,
    }),
  );

  const eventType = envelope.event_type;
  if (!eventType) return dropReply("missing event_type", envelope);
  if (eventType !== "reply_received") {
    return { ok: true, reason: `ignored event type: ${eventType}` };
  }

  const emailId = envelope.email_id;
  const leadEmail = leadEmailOf(envelope);
  if (!emailId || !leadEmail) {
    return dropReply("missing email_id or lead_email", envelope);
  }

  const ctx = await resolveContext(envelope.email_account ?? null);
  if (!ctx) return dropReply("no workspace mapping", envelope);

  const ourLeadId = await upsertLead(ctx, envelope);
  if (!ourLeadId) return dropReply("lead upsert failed", envelope);

  const externalThreadId = threadExternalId(leadEmail, envelope.campaign_id);

  const bodyText = bodyTextOf(envelope);

  // Client tag from campaign name (Instantly conveniently includes the name
  // directly in the envelope — no extra /campaigns/{id} call needed).
  const clientId = await deriveClientIdFromCampaign(envelope.campaign_name ?? null);

  const threadId = await upsertThread(ctx, ourLeadId, externalThreadId, {
    subject: envelope.reply_subject ?? null,
    last_message_at: envelope.timestamp ?? new Date().toISOString(),
    last_message_preview: bodyText,
    needs_reply: true,
    seen: false,
    outbound_sender_email: envelope.email_account ?? null,
    client_id: clientId,
    campaign_id: envelope.campaign_id ?? null,
    campaign_name: envelope.campaign_name ?? null,
  });
  if (!threadId) return dropReply("thread upsert failed", envelope, { lead_id: ourLeadId });

  await upsertMessage({ ctx, threadId, emailId, envelope, bodyText });

  // Background pipeline — the webhook response returns the moment the
  // lead / thread / message rows are committed. Backfill of the full
  // conversation history from Instantly, AI labeling and agent-draft
  // generation all continue asynchronously and write their results
  // when ready. The realtime channel surfaces those writes to any
  // open inbox tab on its own debounce.
  //
  // Previously these steps awaited inline, holding the webhook
  // response on ~1-2 s of Instantly API + OpenAI latency. Concurrent
  // user navigation contended for the same Node worker / DB pool and
  // surfaced as the multi-second UI freeze operators reported.
  void (async () => {
    try {
      await backfillInstantlyConversation(ctx, threadId, leadEmail, envelope.campaign_id);
    } catch (err) {
      console.error("[instantly] async backfill failed", err);
    }
    try {
      await labelInboundMessage({
        workspaceId: ctx.workspaceId,
        threadId,
        messageId: messageExternalId(emailId),
        subject: envelope.reply_subject ?? null,
        bodyText,
        bodyHtml: envelope.reply_html ?? null,
      });
    } catch (err) {
      console.error("[ai] labelInboundMessage (instantly) failed", err);
    }
    try {
      const candidate = (await loadAgents(ctx.workspaceId))
        .filter((a) => a.active)
        .filter((a) => a.channel_filter === "both" || a.channel_filter === "email")
        .filter((a) => {
          if (a.channel_ids.length === 0) return true;
          return ctx.channelId !== null && a.channel_ids.includes(ctx.channelId);
        })
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
      if (candidate) {
        const full = await loadAgentWithKey(candidate.id);
        if (full && full.api_key) {
          const { data: allMessages } = await createAdminSupabase()
            .from("messages")
            .select("direction, sent_at, body_text, body_html")
            .eq("thread_id", threadId)
            .order("sent_at", { ascending: true });
          const conversation = (allMessages ?? []).map((m) => ({
            direction: m.direction as "inbound" | "outbound",
            sentAt: (m.sent_at as string | null) ?? null,
            body:
              (m.body_text as string | null) ??
              stripHtml((m.body_html as string | null) ?? ""),
          }));
          await createDraftForAgent({
            workspaceId: ctx.workspaceId,
            threadId,
            agent: full,
            leadName: leadFullName(envelope),
            leadEmail,
            ourName: null,
            ourEmail: envelope.email_account ?? null,
            subject: envelope.reply_subject ?? null,
            conversation,
          });
        }
      }
    } catch (err) {
      console.error("[agents] instantly draft generation failed", err);
    }
  })();

  return { ok: true };
}
