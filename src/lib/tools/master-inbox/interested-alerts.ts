import "server-only";

import { env } from "@/lib/env";

import { findLeadPhone, stripQuoted } from "./ai/lead-phone.ts";
import { alertText, isExcludedClient, isInterestedLabel, snippetOf, sweepSince } from "./interested-alert.ts";
import { getMasterInboxSupabase, workspaceId } from "./supabase";

/*
 * Posting "a lead is Interested" to Slack (14 Oct) — the rules and wording
 * are in interested-alert.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY A SWEEP, NOT A HOOK
 *
 * Interested is applied in three places: by the AI when a reply arrives (that
 * happens in the STANDALONE Master Inbox, where the EmailBison webhooks land),
 * and by a person in either app. Hooking each would mean the same alert code
 * in two codebases, kept in step forever. Instead the OS looks at the one
 * table every one of them writes — label_assignments — once a minute, and
 * posts for anything new. A change in either app is caught without touching
 * it.
 *
 * ---------------------------------------------------------------------------
 * ONCE PER CONVERSATION, ENFORCED BY THE DATABASE
 *
 * Before posting, a row is claimed in side_effect_outbox (kind
 * 'slack_interested', subject = the thread). Its UNIQUE (workspace, kind,
 * subject) means the claim succeeds for exactly one sweep, ever, for that
 * conversation — re-labelled, labelled by both apps, or seen by two sweeps at
 * once, it posts once. A failed post stays in the outbox and is retried by the
 * outbox's own drain (outbox.ts), up to five times.
 *
 * Until migration 0033 runs, the claim is refused by the table's check on
 * `kind`, and NOTHING is posted — an alert we cannot de-duplicate is not sent.
 */

const KIND = "slack_interested";
/** Assignments looked at per sweep — far more than a minute ever produces. */
const BATCH = 200;
const SLACK_API = "https://slack.com/api/chat.postMessage";
const OS_URL = (process.env.OS_PUBLIC_URL ?? "https://os.brokerstaffer.com").replace(/\/+$/, "");

type Supabase = ReturnType<typeof getMasterInboxSupabase>;
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface SlackResult {
  ok: boolean;
  error?: string;
}

/** chat.postMessage, returning Slack's own error ("not_in_channel", …) rather than a bare false. */
export async function postToSlack(channel: string, text: string): Promise<SlackResult> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "MASTER_INBOX_SLACK_BOT_TOKEN is not set" };
  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    return body?.ok ? { ok: true } : { ok: false, error: body?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type DeliverOutcome = "posted" | "excluded" | "no_longer_interested" | "thread_gone";

/*
 * Builds and posts the alert for one conversation. Throws when Slack refuses,
 * so the outbox records the failure and retries it. Returns normally — and so
 * marks the job done — when there is deliberately nothing to post.
 */
export async function deliverInterestedAlert(
  threadId: string,
  deps: { sb?: Supabase; post?: typeof postToSlack; channel?: string | undefined } = {},
): Promise<DeliverOutcome> {
  const sb = deps.sb ?? getMasterInboxSupabase();
  const post = deps.post ?? postToSlack;
  const channel = deps.channel ?? env.SLACK_CHANNEL_INTERESTED;
  if (!channel) throw new Error("MASTER_INBOX_SLACK_CHANNEL_INTERESTED is not set");

  const { data: thread, error: tErr } = await sb
    .from("threads")
    .select("id, workspace_id, client_id, lead_id, campaign_name")
    .eq("id", threadId)
    .maybeSingle();
  if (tErr) throw new Error(`threads: ${tErr.message}`);
  if (!thread) return "thread_gone";
  const t = thread as Row;

  // Still Interested? A label removed or changed before we got here is not announced.
  const { data: labelRows, error: lErr } = await sb
    .from("label_assignments")
    .select("label_id")
    .eq("target_type", "thread")
    .eq("target_id", threadId);
  if (lErr) throw new Error(`label_assignments: ${lErr.message}`);
  const labelIds = ((labelRows ?? []) as Row[]).map((r) => String(r.label_id));
  if (!labelIds.length) return "no_longer_interested";
  const { data: named, error: nErr } = await sb.from("labels").select("name").in("id", labelIds);
  if (nErr) throw new Error(`labels: ${nErr.message}`);
  if (!((named ?? []) as Row[]).some((l) => isInterestedLabel(str(l.name)))) return "no_longer_interested";

  let clientName: string | null = null;
  if (str(t.client_id)) {
    const { data: client } = await sb.from("clients").select("name").eq("id", String(t.client_id)).maybeSingle();
    clientName = str((client as Row | null)?.name);
  }
  if (isExcludedClient(clientName)) return "excluded";

  let lead: Row | null = null;
  if (str(t.lead_id)) {
    const { data } = await sb.from("leads").select("full_name, email, company, custom_fields").eq("id", String(t.lead_id)).maybeSingle();
    lead = (data as Row | null) ?? null;
  }
  const cf = (lead?.custom_fields ?? null) as Row | null;

  // The conversation, oldest first: the phone the lead gave, and what they last wrote.
  const { data: msgs } = await sb
    .from("messages")
    .select("direction, body_text, sent_at")
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });
  const turns = ((msgs ?? []) as Row[]).map((m) => ({
    direction: (m.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound",
    sentAt: str(m.sent_at),
    body: String(m.body_text ?? ""),
  }));
  const recordPhone = str(cf?.phone) ?? str(cf?.Phone) ?? str(cf?.["phone number"]) ?? str(cf?.phone_number) ?? str(cf?.mobile);
  const phone = findLeadPhone(turns, recordPhone)?.phone ?? null;
  const lastInbound = [...turns].reverse().find((m) => m.direction === "inbound");

  const text = alertText({
    clientName,
    leadName: str(lead?.full_name),
    leadEmail: str(lead?.email),
    leadPhone: phone,
    brokerage: str(lead?.company) ?? str(cf?.company) ?? str(cf?.Company),
    campaign: str(t.campaign_name),
    snippet: snippetOf(lastInbound ? stripQuoted(lastInbound.body) : null),
    threadUrl: `${OS_URL}/inbox/all-email/${threadId}`,
  });
  const res = await post(channel, text);
  if (!res.ok) throw new Error(`Slack refused the alert: ${res.error ?? "unknown error"}`);
  return "posted";
}

export interface SweepResult {
  /** Interested assignments seen in the window. */
  seen: number;
  /** Conversations claimed this sweep (new). */
  claimed: number;
  posted: number;
  skipped: number;
  failed: number;
  /** Why the sweep did nothing at all, when it did nothing at all. */
  off: string | null;
  errors: string[];
}

/*
 * One sweep: every conversation newly labelled Interested since `sweepSince`,
 * claimed once in the outbox, then delivered. Never throws.
 */
export async function sweepInterestedAlerts(
  now: Date = new Date(),
  deps: { sb?: Supabase; post?: typeof postToSlack; channel?: string | undefined; ws?: string } = {},
): Promise<SweepResult> {
  const result: SweepResult = { seen: 0, claimed: 0, posted: 0, skipped: 0, failed: 0, off: null, errors: [] };
  const channel = deps.channel ?? env.SLACK_CHANNEL_INTERESTED;
  if (!channel) return { ...result, off: "MASTER_INBOX_SLACK_CHANNEL_INTERESTED is not set" };
  if (!deps.post && !env.SLACK_BOT_TOKEN) return { ...result, off: "MASTER_INBOX_SLACK_BOT_TOKEN is not set" };

  try {
    const sb = deps.sb ?? getMasterInboxSupabase();
    const ws = deps.ws ?? (await workspaceId());

    const { data: labels, error: labErr } = await sb.from("labels").select("id, name").eq("workspace_id", ws);
    if (labErr) throw new Error(`labels: ${labErr.message}`);
    const ids = ((labels ?? []) as Row[]).filter((l) => isInterestedLabel(str(l.name))).map((l) => String(l.id));
    if (!ids.length) return { ...result, off: "no label named Interested" };

    const { data: rows, error: aErr } = await sb
      .from("label_assignments")
      .select("target_id, assigned_at")
      .eq("workspace_id", ws)
      .eq("target_type", "thread")
      .in("label_id", ids)
      .gte("assigned_at", sweepSince(now))
      .order("assigned_at", { ascending: true })
      .limit(BATCH);
    if (aErr) throw new Error(`label_assignments: ${aErr.message}`);
    const threads = [...new Set(((rows ?? []) as Row[]).map((r) => String(r.target_id)))];
    result.seen = threads.length;

    for (const threadId of threads) {
      // The claim. Only the sweep whose insert creates the row goes on to post.
      const { data: claimed, error: cErr } = await sb
        .from("side_effect_outbox")
        .upsert(
          { workspace_id: ws, kind: KIND, subject_id: threadId, payload: { thread_id: threadId, source: "interested_label" }, status: "pending", claimed_at: now.toISOString() },
          { onConflict: "workspace_id,kind,subject_id", ignoreDuplicates: true },
        )
        .select("id");
      if (cErr) {
        // Before migration 0033 the table refuses the kind: post nothing at all.
        return { ...result, off: /check constraint|kind_check|violates/i.test(cErr.message) ? "migration 0033 has not been run" : `outbox: ${cErr.message}`, errors: [...result.errors, cErr.message] };
      }
      if (!((claimed ?? []) as Row[]).length) continue; // announced already, by this or another sweep
      result.claimed++;

      try {
        const outcome = await deliverInterestedAlert(threadId, { sb, post: deps.post, channel });
        if (outcome === "posted") result.posted++;
        else result.skipped++;
        await sb
          .from("side_effect_outbox")
          .update({ status: "done", completed_at: new Date().toISOString(), last_error: outcome === "posted" ? null : outcome })
          .eq("workspace_id", ws).eq("kind", KIND).eq("subject_id", threadId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.failed++;
        result.errors.push(message);
        // Left pending, unclaimed, with the reason: the outbox drain retries it.
        await sb
          .from("side_effect_outbox")
          .update({ attempts: 1, last_error: message.slice(0, 500), claimed_at: null })
          .eq("workspace_id", ws).eq("kind", KIND).eq("subject_id", threadId);
      }
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}
