import { createServerSupabase } from "@/lib/supabase/server";

export interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  // Display name from the From header, captured at sync time —
  // e.g. "Howe Realty Growth" for growth@howerealtygroup.com. Null
  // when the provider didn't surface it; the render falls back to
  // body parsing and then to a titlecased local-part.
  sender_name: string | null;
  recipients: Record<string, unknown>;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string | null;
}

export interface PendingDraft {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  generated_body: string | null;
  created_at: string;
}

// User-typed draft auto-saved from the composer (separate from
// PendingDraft, which is AI-generated). Workspace-scoped via the
// composer_drafts table's unique (workspace_id, thread_id).
export interface ComposerDraft {
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  selected_channel_id: string | null;
  add_signature: boolean;
  updated_at: string;
}

export interface ThreadDetail {
  id: string;
  workspace_id: string;
  subject: string | null;
  status: "open" | "archived" | "spam" | "trash" | "reminder";
  outbound_sender_email: string | null;
  // HTML signature from EmailBison for the sender account on this thread.
  // Extracted from any inbound message's raw_payload.data.sender_email.email_signature.
  // Used by the composer when the "Add signature" checkbox is on.
  outbound_sender_signature: string | null;
  source_provider: "emailbison" | "instantly" | null;
  campaign_id: string | null;
  campaign_name: string | null;
  client_id: string | null;
  client_name: string | null;
  pending_draft: PendingDraft | null;
  composer_draft: ComposerDraft | null;
  lead: {
    id: string | null;
    full_name: string | null;
    email: string | null;
    company: string | null;
    title: string | null;
    linkedin_url: string | null;
    custom_fields: Record<string, unknown>;
  };
  channel: { provider: "emailbison" | "instantly" | null; display_name: string | null };
  messages: MessageRow[];
  labels: Array<{ id: string; name: string; color: string; sentiment: string }>;
}

export async function loadThreadDetail(
  workspaceId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const supabase = await createServerSupabase();

  // All five queries below depend only on threadId + workspaceId — fan them
  // out in parallel instead of awaiting each one sequentially. Before this,
  // a thread open took 5 × ~100ms Supabase round-trips in series (~500ms).
  // With Promise.all it's bounded by the slowest single query (~100-150ms).
  const [
    { data: thread, error },
    { data: messages },
    { data: signatureRow },
    { data: labelAssignments },
    { data: drafts },
    composerDraftResult,
  ] = await Promise.all([
    supabase
      .from("threads")
      .select(
        `id, workspace_id, subject, status, outbound_sender_email, source_provider, campaign_id, campaign_name,
       leads:lead_id(id, full_name, email, company, title, linkedin_url, custom_fields),
       channels:channel_id(provider, display_name),
       clients:client_id(id, name)`,
      )
      .eq("id", threadId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    supabase
      .from("messages")
      .select("id, direction, sender, sender_name, recipients, subject, body_html, body_text, sent_at")
      .eq("thread_id", threadId)
      .order("sent_at", { ascending: true }),
    // Pull the most recent inbound's raw_payload (signature lives there).
    supabase
      .from("messages")
      .select("raw_payload")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("label_assignments")
      .select("labels:label_id(id, name, color, sentiment)")
      .eq("target_type", "thread")
      .eq("target_id", threadId),
    // Most recent pending draft (if any).
    supabase
      .from("reply_drafts")
      .select(
        "id, agent_id, generated_body, created_at, reply_agents:agent_id(name)",
      )
      .eq("thread_id", threadId)
      .eq("status", "pending")
      .not("generated_body", "is", null)
      .order("created_at", { ascending: false })
      .limit(1),
    // Composer auto-save (table from migration 0055). Defensively
    // catches any error — if the column / table is somehow missing
    // (deploy lands before migration in a rebuild, etc.) we fall
    // back to null instead of breaking the entire thread view.
    supabase
      .from("composer_drafts")
      .select(
        "subject, body_html, body_text, to_addresses, cc_addresses, bcc_addresses, selected_channel_id, add_signature, updated_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("thread_id", threadId)
      .maybeSingle()
      .then(
        (r) => r,
        () => ({ data: null, error: null }) as const,
      ),
  ]);
  if (error || !thread) return null;

  let outboundSignature: string | null = null;
  if (signatureRow?.raw_payload) {
    const p = signatureRow.raw_payload as Record<string, unknown>;
    const data = (p.data as Record<string, unknown> | undefined) ?? p;
    const se = data?.sender_email as { email_signature?: string } | undefined;
    if (typeof se?.email_signature === "string" && se.email_signature.trim().length > 0) {
      outboundSignature = se.email_signature;
    }
  }

  const draftRow = drafts?.[0];
  const draftAgent = draftRow
    ? Array.isArray(draftRow.reply_agents)
      ? draftRow.reply_agents[0]
      : draftRow.reply_agents
    : null;

  const lead = Array.isArray(thread.leads) ? thread.leads[0] : thread.leads;
  const channel = Array.isArray(thread.channels) ? thread.channels[0] : thread.channels;
  const client = Array.isArray(thread.clients) ? thread.clients[0] : thread.clients;
  const labels = (labelAssignments ?? [])
    .map((row) => (Array.isArray(row.labels) ? row.labels[0] : row.labels))
    .filter(Boolean) as ThreadDetail["labels"];

  return {
    id: thread.id,
    workspace_id: thread.workspace_id,
    subject: thread.subject,
    status: (thread.status as ThreadDetail["status"]) ?? "open",
    outbound_sender_email: (thread.outbound_sender_email as string | null) ?? null,
    outbound_sender_signature: outboundSignature,
    source_provider: (thread.source_provider as ThreadDetail["source_provider"]) ?? null,
    campaign_id: (thread.campaign_id as string | null) ?? null,
    campaign_name: (thread.campaign_name as string | null) ?? null,
    client_id: (client?.id as string | null) ?? null,
    client_name: (client?.name as string | null) ?? null,
    pending_draft: draftRow
      ? {
          id: draftRow.id as string,
          agent_id: (draftRow.agent_id as string | null) ?? null,
          agent_name: (draftAgent?.name as string | undefined) ?? null,
          generated_body: (draftRow.generated_body as string | null) ?? null,
          created_at: draftRow.created_at as string,
        }
      : null,
    composer_draft: composerDraftResult?.data
      ? {
          subject: (composerDraftResult.data.subject as string | null) ?? null,
          body_html: (composerDraftResult.data.body_html as string | null) ?? null,
          body_text: (composerDraftResult.data.body_text as string | null) ?? null,
          to_addresses: (composerDraftResult.data.to_addresses as string | null) ?? null,
          cc_addresses: (composerDraftResult.data.cc_addresses as string | null) ?? null,
          bcc_addresses: (composerDraftResult.data.bcc_addresses as string | null) ?? null,
          selected_channel_id:
            (composerDraftResult.data.selected_channel_id as string | null) ?? null,
          add_signature:
            (composerDraftResult.data.add_signature as boolean | null) ?? true,
          updated_at: composerDraftResult.data.updated_at as string,
        }
      : null,
    lead: {
      id: lead?.id ?? null,
      full_name: lead?.full_name ?? null,
      email: lead?.email ?? null,
      company: lead?.company ?? null,
      title: lead?.title ?? null,
      linkedin_url: (lead?.linkedin_url as string | null) ?? null,
      custom_fields: (lead?.custom_fields as Record<string, unknown>) ?? {},
    },
    channel: {
      provider: (channel?.provider ?? null) as ThreadDetail["channel"]["provider"],
      display_name: channel?.display_name ?? null,
    },
    messages: (messages ?? []) as MessageRow[],
    labels,
  };
}
