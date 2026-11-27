import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { getMasterInboxSupabase, workspaceId } from "@/lib/tools/master-inbox/supabase";
import { isInterestedLabel } from "@/lib/tools/master-inbox/inbox/interest";
import { rosterRowForPortal } from "@/lib/tools/master-inbox/clients/roster-for-portal";
import { directHandoffReason } from "@/lib/tools/master-inbox/relay/settings";
import { setThreadLabel } from "@/lib/tools/master-inbox/inbox/set-label";
import { snoozeThread, unsnoozeThread } from "@/lib/tools/master-inbox/inbox/snooze";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";
import { labelPolicy } from "./label-policy.ts";

/*
 * Inbox actions through Claude (25 Nov): change a reply's label; snooze or un-snooze a conversation. Exactly what the
 * Master Inbox does on a click — the same functions (inbox/set-label.ts, inbox/snooze.ts) — for the people who hold the
 * Master Inbox switch. Labels are limited to those that change nothing outside the OS (label-policy.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needsOf = (path: string): ToolId[] => (grantsForRequest(path, "POST") ?? []) as ToolId[];
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export interface ThreadSummary {
  id: string;
  lead: string;
  subject: string | null;
  client: string | null;
  label: string | null;
  status: string | null;
  lastMessageAt: string | null;
  snoozedUntil: string | null;
  /** Ever marked Interested or Meetings Booked (label_history): its label then decides hand-offs and per-lead billing. */
  everPositive: boolean;
}

export async function threadSummary(id: string): Promise<ThreadSummary | null> {
  const mi = getMasterInboxSupabase();
  const { data: t } = await mi
    .from("threads")
    .select("id, subject, status, last_message_at, leads:lead_id(full_name, email), clients:client_id(name)")
    .eq("id", id)
    .maybeSingle();
  if (!t) return null;
  const row = t as Record<string, unknown>;
  const lead = one(row.leads as { full_name?: string | null; email?: string | null } | null);
  const client = one(row.clients as { name?: string | null } | null);
  const { data: la } = await mi.from("label_assignments").select("labels:label_id(name)").eq("target_type", "thread").eq("target_id", id);
  const labels = ((la ?? []) as Array<{ labels: unknown }>).map((r) => one(r.labels as { name?: string | null } | null)?.name ?? null).filter(Boolean) as string[];
  const { data: rem } = await mi.from("reminders").select("remind_at").eq("thread_id", id).eq("status", "pending").order("remind_at", { ascending: false }).limit(1);
  const pending = ((rem ?? []) as Array<{ remind_at: string }>)[0]?.remind_at ?? null;
  const { data: hist, error: histError } = await mi.from("label_history").select("label_name").eq("thread_id", id).in("label_name", ["Interested", "Meetings Booked"]).limit(1);
  // Unreadable history: treat it as ever-positive, so a label that might move money is refused rather than guessed.
  const everPositive = !!histError || ((hist ?? []) as unknown[]).length > 0;
  return {
    id,
    lead: [lead?.full_name, lead?.email ? `<${lead.email}>` : null].filter(Boolean).join(" ") || "(unknown lead)",
    subject: (row.subject as string | null) ?? null,
    client: client?.name ?? null,
    label: labels[0] ?? null,
    status: (row.status as string | null) ?? null,
    lastMessageAt: (row.last_message_at as string | null) ?? null,
    snoozedUntil: pending,
    everPositive,
  };
}

/** "<client> gets interested replies by direct hand-off" when it does, else null. */
async function handoffFor(threadId: string, clientName: string | null): Promise<string | null> {
  if (!clientName) return null;
  const { data } = await getMasterInboxSupabase().from("threads").select("client_id").eq("id", threadId).maybeSingle();
  const clientId = (data as { client_id?: string | null } | null)?.client_id;
  if (!clientId) return null;
  const found = await rosterRowForPortal(clientId, clientName, "pipeline_entry, relay_settings");
  return found.row ? directHandoffReason(found.row, clientName) : null;
}

const describe = (t: ThreadSummary) =>
  `${t.lead}${t.client ? ` (${t.client})` : ""}, "${t.subject ?? "no subject"}", last message ${t.lastMessageAt?.slice(0, 10) ?? "?"}, label now: ${t.label ?? "none"}`;

// ---------------------------------------------------------------------------------------------------------------------
// inbox_set_label
// ---------------------------------------------------------------------------------------------------------------------

type LabelArgs = { thread_id: string; label: string };
type LabelBind = { current: string | null; labelId: string };

export const inboxSetLabel: ActionSpec<LabelArgs, LabelBind> = {
  name: "inbox_set_label",
  title: "Change a reply's label",
  description:
    "Change the label of one Master Inbox conversation (its reply), as the inbox's label menu does — one label per " +
    "conversation, so it replaces the current one. thread_id comes from positive_replies, recent_replies or " +
    "search_conversations. The preview lists every effect: Interested / Meetings Booked start the Slack alert, the " +
    "hand-off to direct-hand-off clients and per-lead billing; stop labels stop the person in every campaign; on a lead " +
    "that was Interested, a correction label (Not Interested, Not Qualified, …) can take it off a per-lead bill. For " +
    "Introduction use inbox_introduce; a conversation that is an Introduction is relabelled in the inbox.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The conversation's thread_id." },
      label: { type: "string", description: "The label's name as the inbox shows it, e.g. Not Interested, Keep Warm, OOO." },
    },
    required: ["thread_id", "label"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  needs: needsOf("/api/tools/master-inbox/threads/labels"),
  parse(a) {
    const thread_id = String(a.thread_id ?? "").trim();
    const label = String(a.label ?? "").trim();
    if (!UUID.test(thread_id)) return { error: "thread_id must be a conversation's id (from recent_replies or search_conversations)." };
    if (!label) return { error: "Which label? Give its name as the inbox shows it." };
    return { thread_id, label };
  },
  async preview(a) {
    const t = await threadSummary(a.thread_id);
    if (!t) return { ok: false, refusal: "No conversation with that thread_id." };
    const { data } = await getMasterInboxSupabase().from("labels").select("id, name").eq("workspace_id", await workspaceId());
    const found = ((data ?? []) as Array<{ id: string; name: string }>).find((l) => l.name.trim().toLowerCase() === a.label.toLowerCase());
    if (!found) {
      const names = ((data ?? []) as Array<{ name: string }>).map((l) => l.name).filter((n) => labelPolicy(t.label, n, t.everPositive).ok).sort();
      return { ok: false, refusal: `There is no label called "${a.label}".${names.length ? ` Labels you can use here: ${names.join(", ")}.` : " This conversation's label can't be changed through Claude."}` };
    }
    const policy = labelPolicy(t.label, found.name, t.everPositive);
    if (!policy.ok) return { ok: false, refusal: policy.reason };
    const notes = [...policy.effects];
    if (isInterestedLabel(found.name) || /^meetings booked$/i.test(found.name.trim())) {
      // Say plainly when THIS client gets the reply by hand-off.
      const handoff = await handoffFor(a.thread_id, t.client);
      if (handoff) notes.unshift(`${handoff}: this reply is emailed to the client within a minute.`);
    }
    return {
      ok: true,
      preview: `Change the label of ${describe(t)} → ${found.name}.${notes.length ? ` ${notes.join(" ")}` : ""}`,
      details: { thread: t, newLabel: found.name },
      // The effects it showed are part of what was confirmed: if they change meanwhile (the lead turns once-Interested,
      // the client's hand-off is switched on), nothing is done and the new preview says so.
      bind: { current: t.label, labelId: found.id, effects: notes },
    };
  },
  async execute(a, v, bind) {
    const r = await setThreadLabel(a.thread_id, bind.labelId);
    if (!r.ok) throw new Error(r.error);
    console.info(`[mcp-action] ${v.email} via Claude: label ${a.thread_id} ${bind.current ?? "none"} → ${a.label}`);
    return { thread_id: a.thread_id, label: a.label };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// inbox_snooze
// ---------------------------------------------------------------------------------------------------------------------

type SnoozeArgs = { thread_id: string; until: string | null; note: string | null; cancel: boolean };
type SnoozeBind = { status: string | null; snoozedUntil: string | null };

export const inboxSnooze: ActionSpec<SnoozeArgs, SnoozeBind> = {
  name: "inbox_snooze",
  title: "Snooze a conversation",
  description:
    "Snooze one Master Inbox conversation until a date and time (it leaves the inbox and comes back as a reminder), " +
    "optionally with a note for the team; or cancel its snooze (cancel: true) to put it back now. As the inbox's " +
    "Snooze does. Nothing leaves the OS.",
  inputSchema: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The conversation's thread_id." },
      until: { type: "string", description: "When it should come back: an ISO date-time with its time zone, e.g. 2026-12-01T09:00:00-05:00." },
      note: { type: "string", description: "Optional note shown with the reminder (500 characters at most)." },
      cancel: { type: "boolean", description: "True to cancel the snooze instead." },
    },
    required: ["thread_id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  needs: needsOf("/api/tools/master-inbox/threads/snooze"),
  parse(a) {
    const thread_id = String(a.thread_id ?? "").trim();
    if (!UUID.test(thread_id)) return { error: "thread_id must be a conversation's id (from recent_replies or search_conversations)." };
    const cancel = a.cancel === true;
    const note = typeof a.note === "string" && a.note.trim() ? a.note.trim() : null;
    if (note && note.length > 500) return { error: "The note can be 500 characters at most." };
    if (cancel) return { thread_id, until: null, note: null, cancel };
    const raw = String(a.until ?? "").trim();
    const at = Date.parse(raw);
    if (!raw || Number.isNaN(at) || !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) return { error: "until must be a date-time with its time zone, e.g. 2026-12-01T09:00:00-05:00." };
    if (at <= Date.now() + 60_000) return { error: "until must be in the future." };
    if (at > Date.now() + 366 * 86_400_000) return { error: "Snooze for at most a year." };
    return { thread_id, until: new Date(at).toISOString(), note, cancel };
  },
  async preview(a) {
    const t = await threadSummary(a.thread_id);
    if (!t) return { ok: false, refusal: "No conversation with that thread_id." };
    if (a.cancel) {
      if (!t.snoozedUntil && t.status !== "reminder") return { ok: false, refusal: "That conversation isn't snoozed." };
      return { ok: true, preview: `Cancel the snooze on ${describe(t)}${t.snoozedUntil ? ` (snoozed until ${t.snoozedUntil})` : ""}; it goes back into the inbox now.`, details: { thread: t }, bind: { status: t.status, snoozedUntil: t.snoozedUntil } };
    }
    const et = new Date(a.until!).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    return {
      ok: true,
      preview:
        `Snooze ${describe(t)} until ${et} Eastern (${a.until})${a.note ? `, with the note "${a.note}"` : ""}. It leaves the ` +
        "inbox and comes back once that time has passed and someone opens Master Inbox › Reminders (as with the inbox's own Snooze)." +
        `${t.snoozedUntil ? ` It is already snoozed until ${t.snoozedUntil}; that is replaced.` : ""}`,
      details: { thread: t },
      bind: { status: t.status, snoozedUntil: t.snoozedUntil },
    };
  },
  async execute(a, v) {
    const r = a.cancel ? await unsnoozeThread(a.thread_id) : await snoozeThread(a.thread_id, a.until!, a.note);
    if (!r.ok) throw new Error(r.error);
    console.info(`[mcp-action] ${v.email} via Claude: ${a.cancel ? "unsnooze" : `snooze until ${a.until}`} ${a.thread_id}`);
    return a.cancel ? { thread_id: a.thread_id, snoozed: false } : { thread_id: a.thread_id, snoozedUntil: a.until };
  },
};
