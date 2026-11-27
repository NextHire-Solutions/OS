import "server-only";

import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { CORRECTION_LABELS, POSITIVE_LABELS } from "@/lib/tools/analytics/inbox-positives";

/*
 * positive_replies (27 Nov) — Eddy's first use case for Claude: "Positive replies (masterinbox)".
 *
 * The OS's own rule (analytics/inbox-positives.ts, the Inboxes page; the same as per-lead billing): a reply is POSITIVE
 * when its conversation was ever labelled Interested or Introduction, unless its label NOW is a correction (Not
 * Interested, Not Qualified, Do Not Contact, Unsubscribe, Broker/Owner). Counted in the period when the conversation
 * FIRST became positive, per client portal, with each one's thread_id (for the connector's inbox actions). Read only.
 */

export interface PositiveRow { thread_id: string; client: string | null; lead: string; subject: string | null; labelNow: string | null; firstPositiveAt: string }

/** Pure: which conversations count, given each one's first positive time and its labels now. */
export function positivesOf(
  firstPositive: ReadonlyMap<string, string>,
  labelsNow: ReadonlyMap<string, readonly string[]>,
  threads: ReadonlyMap<string, { client: string | null; lead: string; subject: string | null; status: string | null }>,
  sinceMs: number,
): PositiveRow[] {
  const out: PositiveRow[] = [];
  for (const [id, first] of firstPositive) {
    if (Date.parse(first) < sinceMs) continue;
    const t = threads.get(id);
    if (!t || t.status === "trash") continue;
    const now = labelsNow.get(id) ?? [];
    if (now.some((l) => CORRECTION_LABELS.has(l))) continue;
    out.push({ thread_id: id, client: t.client, lead: t.lead, subject: t.subject, labelNow: now[0] ?? null, firstPositiveAt: first });
  }
  return out.sort((a, b) => b.firstPositiveAt.localeCompare(a.firstPositiveAt));
}

const GROUP = 150;
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function chunks<T>(ids: string[], read: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += GROUP) {
    const { data, error } = await read(ids.slice(i, i + GROUP));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function positiveRepliesTool(o: { days?: number; client?: string; limit?: number }) {
  const days = Math.min(90, Math.max(1, Math.round(o.days ?? 7)));
  const limit = Math.min(50, Math.max(1, Math.round(o.limit ?? 20)));
  const sinceMs = Date.now() - days * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  const mi = getMasterInboxSupabase();

  // Conversations given a positive label in the period (paged by id: PostgREST stops at 1,000 rows).
  const recent: Array<{ id: number; thread_id: string }> = [];
  for (let after = 0; ; ) {
    const { data, error } = await mi.from("label_history").select("id, thread_id").in("label_name", [...POSITIVE_LABELS]).gte("assigned_at", since).gt("id", after).order("id").limit(1000);
    if (error) return { error: `Master Inbox could not be read: ${error.message}` };
    const rows = (data ?? []) as Array<{ id: number; thread_id: string }>;
    recent.push(...rows);
    if (rows.length < 1000) break;
    after = rows[rows.length - 1].id;
  }
  const ids = [...new Set(recent.map((r) => r.thread_id).filter(Boolean))];
  if (!ids.length) return { periodDays: days, since, total: 0, byClient: [], replies: [], definition: DEFINITION };

  // When each FIRST became positive (ever), its labels now, and the conversation.
  const hist = await chunks<{ thread_id: string; assigned_at: string }>(ids, (p) => mi.from("label_history").select("thread_id, assigned_at").in("label_name", [...POSITIVE_LABELS]).in("thread_id", p).order("assigned_at"));
  const first = new Map<string, string>();
  for (const h of hist) if (!first.has(h.thread_id)) first.set(h.thread_id, h.assigned_at);
  const la = await chunks<{ target_id: string; labels: unknown }>(ids, (p) => mi.from("label_assignments").select("target_id, labels:label_id(name)").eq("target_type", "thread").in("target_id", p));
  const labelsNow = new Map<string, string[]>();
  for (const r of la) { const n = one(r.labels as { name?: string } | null)?.name; if (n) labelsNow.set(r.target_id, [...(labelsNow.get(r.target_id) ?? []), n]); }
  const th = await chunks<Record<string, unknown>>(ids, (p) => mi.from("threads").select("id, subject, status, leads:lead_id(full_name, email), clients:client_id(name)").in("id", p));
  const threads = new Map(th.map((t) => {
    const lead = one(t.leads as { full_name?: string | null; email?: string | null } | null);
    return [String(t.id), {
      client: one(t.clients as { name?: string | null } | null)?.name ?? null,
      lead: [lead?.full_name, lead?.email ? `<${lead.email}>` : null].filter(Boolean).join(" ") || "(unknown lead)",
      subject: (t.subject as string | null) ?? null,
      status: (t.status as string | null) ?? null,
    }];
  }));

  let rows = positivesOf(first, labelsNow, threads, sinceMs);
  if (o.client) {
    const n = norm(o.client);
    rows = rows.filter((r) => r.client && norm(r.client).includes(n));
  }
  const byClient = Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r.client ?? "(no client)"] = (a[r.client ?? "(no client)"] ?? 0) + 1), a), {}))
    .map(([client, positive]) => ({ client, positive }))
    .sort((a, b) => b.positive - a.positive);
  return { periodDays: days, since, client: o.client ?? null, total: rows.length, byClient, replies: rows.slice(0, limit), shown: Math.min(limit, rows.length), definition: DEFINITION };
}

const DEFINITION =
  "Positive = the conversation was marked Interested or Introduction (counted when it FIRST became positive), unless its " +
  "label now is a correction (Not Interested, Not Qualified, Do Not Contact, Unsubscribe, Broker/Owner) — the Inboxes " +
  "page's and per-lead billing's rule. Clients are the conversation's portal.";
