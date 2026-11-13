import "server-only";

import { ttlCache } from "@/lib/cache/ttl";
import { fetchAllRows } from "@/lib/tools/analytics/supabase";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import {
  POSITIVE_LABELS,
  conversationsOf,
  earliestByThread,
  type Conversation,
  type MessageFacts,
  type ThreadFacts,
} from "./inbox-positives.ts";

/*
 * Master Inbox's replies and positive replies, for the Inboxes page (14 Nov).
 * The rules are in inbox-positives.ts; this only reads, and never writes.
 *
 * What it reads (measured 14 Nov): every conversation (~14,400) and the labels
 * each carries now, the conversations ever marked positive (~2,000), the
 * address of every reply (~17,300 inbound messages, three columns), and the
 * first email we sent on the positive ones — about 50 small requests.
 *
 * PAGED BY ID. PostgREST stops at 1,000 rows and says nothing, so every read
 * is paged; and by id rather than by offset, so no page scans the ones before
 * it, and a label changed mid-read (a delete and an insert) cannot shift a row
 * into a second page or out of both.
 *
 * KEPT. Fresh for five minutes; after that the last answer is served at once
 * while a new read runs behind it, for up to a day — the page shows when it was
 * read. So a person waits only on a cold read: the first after a deploy (warmed
 * at boot, instrumentation.ts) or after a day nobody opened the page.
 */

export interface RepliesAnswer {
  conversations: Conversation[];
  /** When Master Inbox was read. */
  asOf: string;
}

const PAGE = 1000;
/** Ids per `.in()`: 150 UUIDs keep the URL far under the 16 KB header cap. */
const GROUP = 150;
const AT_ONCE = 4;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : ((error as { message?: string } | null)?.message ?? String(error));

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Every row, a page at a time, each page starting after the last row's id. */
async function everyRow<T extends { id: string | number }>(page: (after: string | number | null) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let after: string | number | null = null; ; ) {
    const { data, error } = await page(after);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = rows[rows.length - 1].id;
  }
}

/** Runs `work` on each group of ids, a few groups at a time, and joins the answers. */
async function inGroups<R>(ids: readonly string[], work: (part: string[]) => Promise<R[]>): Promise<R[]> {
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += GROUP) parts.push(ids.slice(i, i + GROUP));
  const answers: R[][] = new Array(parts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, parts.length) }, async () => {
      while (next < parts.length) {
        const i = next++;
        answers[i] = await work(parts[i]);
      }
    }),
  );
  return answers.flat();
}

async function read(): Promise<RepliesAnswer> {
  const mi = getMasterInboxSupabase();
  const asOf = new Date().toISOString();
  const named = (what: string) => (error: unknown): never => {
    throw new Error(`Master Inbox ${what}: ${messageOf(error)}`);
  };
  // Each read: ascending ids, a page at a time, after the last one seen.
  const after = <Q extends { gt: (c: string, v: string | number) => Q }>(q: Q, id: string | number | null) => (id === null ? q : q.gt("id", id));

  const [ever, threads, labels, assigned, inbound] = await Promise.all([
    everyRow<{ id: number; thread_id: string }>((id) =>
      after(mi.from("label_history").select("id, thread_id").in("label_name", [...POSITIVE_LABELS]).order("id", { ascending: true }).limit(PAGE), id),
    ).catch(named("label history")),
    everyRow<ThreadFacts>((id) =>
      after(mi.from("threads").select("id, status, source_provider, outbound_sender_email").order("id", { ascending: true }).limit(PAGE), id),
    ).catch(named("conversations")),
    fetchAllRows<{ id: string; name: string | null }>((from, to) =>
      mi.from("labels").select("id, name").order("id", { ascending: true }).range(from, to),
    ).catch(named("labels")),
    everyRow<{ id: string; target_id: string; label_id: string }>((id) =>
      after(mi.from("label_assignments").select("id, target_id, label_id").eq("target_type", "thread").order("id", { ascending: true }).limit(PAGE), id),
    ).catch(named("labels now")),
    everyRow<MessageFacts & { id: string }>((id) =>
      after(mi.from("messages").select("id, thread_id, recipients, sent_at").eq("direction", "inbound").order("id", { ascending: true }).limit(PAGE), id),
    ).catch(named("replies")),
  ]);

  const everPositive = new Set(ever.map((r) => r.thread_id).filter(Boolean));
  const name = new Map(labels.map((l) => [l.id, l.name]));
  const labelsNow = new Map<string, string[]>();
  for (const a of assigned) {
    const n = name.get(a.label_id);
    if (!n) continue;
    const list = labelsNow.get(a.target_id) ?? [];
    if (!list.includes(n)) list.push(n);
    labelsNow.set(a.target_id, list);
  }

  // Our first email, on the positive conversations only: their fallback when the first reply names no inbox of ours.
  const positiveIds = [...new Set(threads.filter((t) => everPositive.has(t.id) && t.status !== "trash").map((t) => t.id))];
  const sent = await inGroups(positiveIds, (part) =>
    fetchAllRows<MessageFacts>((from, to) =>
      mi.from("messages").select("thread_id, sender, sent_at").eq("direction", "outbound").in("thread_id", part).order("id", { ascending: true }).range(from, to),
    ).catch(named("sent emails")),
  );

  return {
    conversations: conversationsOf(threads, labelsNow, everPositive, earliestByThread(inbound), earliestByThread(sent)),
    asOf,
  };
}

export const loadReplies = ttlCache(read, {
  ttlMs: 5 * 60_000,
  staleMs: 24 * 60 * 60_000,
  // A read takes seconds; this only clears one that hung. Clearing early would drop the kept answer too.
  inflightTimeoutMs: 180_000,
  shared: "analytics-inbox-replies",
});
