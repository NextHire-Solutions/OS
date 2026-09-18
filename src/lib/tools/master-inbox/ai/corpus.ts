import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { osTable } from "@/lib/clients/os-db";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import {
  dedupe,
  pairTurns,
  qualityScore,
  rejectExample,
  type RawTurn,
  type RejectReason,
} from "./corpus-pure";
import { embedBatch } from "./embeddings";

/*
 * Building the corpus: every inbound message paired with the reply we sent.
 *
 * ---------------------------------------------------------------------------
 * HOW IT READS 36,000 MESSAGES WITHOUT FALLING OVER
 *
 * Pairing needs a thread's messages together and in order, and there are
 * 10,367 threads — one query each would be 10,367 round trips. Instead this
 * walks `messages` once, ordered by (thread_id, sent_at), buffering a thread
 * and flushing it the moment the thread_id changes. Memory holds one thread.
 *
 * Only `os_reply_examples` is written. `messages`, `threads`, `labels` and
 * `label_assignments` belong to Master Inbox, which is live — they are read
 * and never touched.
 */

export interface BuildOptions {
  workspaceId: string;
  /** Only messages sent at or after this date. Defaults to everything. */
  since?: string;
  /** Stop after this many examples. Useful for a first look. */
  limit?: number;
  /** Embed as we go. Off makes a dry run instant. */
  embed?: boolean;
  /** An OpenAI key for embeddings. Required when `embed` is true. */
  apiKey?: string;
  /** Read and judge everything, write nothing. What the preview uses. */
  dryRun?: boolean;
  onProgress?: (note: string) => void;
}

export interface BuildReport {
  threadsSeen: number;
  /** Corrections left alone: replies a person wrote over the agent's draft. */
  correctionsKept?: number;
  pairsFound: number;
  kept: number;
  written: number;
  embedded: number;
  rejected: Record<string, number>;
  /** A few of what was kept, so a person can judge the corpus before it is used. */
  samples: Array<{ label: string | null; quality: number; inbound: string; reply: string }>;
}

const PAGE = 1000;

export async function buildReplyCorpus(opts: BuildOptions): Promise<BuildReport> {
  const admin = createAdminSupabase();
  const note = opts.onProgress ?? (() => {});

  const report: BuildReport = {
    threadsSeen: 0, pairsFound: 0, kept: 0, written: 0, embedded: 0,
    rejected: {}, samples: [],
  };
  const reject = (r: RejectReason) => { report.rejected[r] = (report.rejected[r] ?? 0) + 1; };

  /* ---------------------------------------------- labels, once, as a map */
  note("reading labels");
  const labelRows = await fetchAllRows<{ id: string; name: string }>(({ from, to }) =>
    admin.from("labels").select("id, name").eq("workspace_id", opts.workspaceId).range(from, to),
  );
  const labelName = new Map(labelRows.map((l) => [l.id, l.name]));

  const threadLabels = new Map<string, string[]>();
  const assignments = await fetchAllRows<{ label_id: string; target_id: string }>(({ from, to }) =>
    admin
      .from("label_assignments")
      .select("label_id, target_id")
      .eq("workspace_id", opts.workspaceId)
      .eq("target_type", "thread")
      .range(from, to),
  );
  for (const a of assignments) {
    const name = labelName.get(a.label_id);
    if (!name) continue;
    const list = threadLabels.get(a.target_id) ?? [];
    list.push(name);
    threadLabels.set(a.target_id, list);
  }
  note(`${labelRows.length} labels, ${threadLabels.size} labelled threads`);

  /* ------------------------------------------- clients, for the context */
  const clientName = new Map<string, string>();
  const clients = await fetchAllRows<{ id: string; name: string }>(({ from, to }) =>
    admin.from("clients").select("id, name").range(from, to),
  );
  for (const c of clients) clientName.set(c.id, c.name);

  const threadClient = new Map<string, string | null>();
  const threads = await fetchAllRows<{ id: string; client_id: string | null }>(({ from, to }) =>
    admin.from("threads").select("id, client_id").eq("workspace_id", opts.workspaceId).range(from, to),
  );
  for (const t of threads) threadClient.set(t.id, t.client_id);
  note(`${threads.length} threads`);

  /* -------------------------------------------- one pass over messages */
  type Row = {
    id: string; thread_id: string; direction: "inbound" | "outbound";
    body_text: string | null; body_html: string | null; sent_at: string | null;
  };

  const staged: Array<{
    workspace_id: string; thread_id: string;
    inbound_message_id: string; outbound_message_id: string;
    label: string | null; client_name: string | null;
    inbound_text: string; reply_text: string; sent_at: string | null;
    quality: number; source: "history";
  }> = [];

  let buffer: RawTurn[] = [];
  let bufferThread: string | null = null;

  const flush = () => {
    if (!bufferThread || buffer.length === 0) return;
    report.threadsSeen++;
    const labels = threadLabels.get(bufferThread) ?? [];
    // The first label is the situation; the rest are outcome signal.
    const label = labels[0] ?? null;
    const cid = threadClient.get(bufferThread) ?? null;

    for (const pair of pairTurns(buffer)) {
      report.pairsFound++;
      const why = rejectExample({ ...pair, label });
      if (why) { reject(why); continue; }
      const quality = qualityScore({
        sentAt: pair.sentAt, label, threadLabels: labels,
        source: "history", replyText: pair.replyText,
      });
      staged.push({
        workspace_id: opts.workspaceId,
        thread_id: bufferThread,
        inbound_message_id: pair.inboundMessageId,
        outbound_message_id: pair.outboundMessageId,
        label,
        client_name: cid ? (clientName.get(cid) ?? null) : null,
        inbound_text: pair.inboundText.slice(0, 4000),
        reply_text: pair.replyText.slice(0, 4000),
        sent_at: pair.sentAt,
        quality,
        source: "history",
      });
      report.kept++;
    }
    buffer = [];
  };

  let offset = 0;
  for (;;) {
    let q = admin
      .from("messages")
      .select("id, thread_id, direction, body_text, body_html, sent_at")
      .eq("workspace_id", opts.workspaceId)
      .order("thread_id", { ascending: true })
      .order("sent_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (opts.since) q = q.gte("sent_at", opts.since);

    const { data, error } = await q;
    if (error) throw new Error(`messages read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) break;

    for (const r of rows) {
      if (r.thread_id !== bufferThread) {
        flush();
        bufferThread = r.thread_id;
      }
      buffer.push({
        id: r.id, direction: r.direction,
        bodyText: r.body_text, bodyHtml: r.body_html, sentAt: r.sent_at,
      });
    }

    offset += rows.length;
    if (offset % 5000 === 0) note(`${offset} messages read, ${report.kept} examples so far`);
    if (rows.length < PAGE) break;
    if (opts.limit && report.kept >= opts.limit) break;
  }
  flush();
  note(`paired ${report.pairsFound}, kept ${report.kept}`);

  /* ------------------------------------------------------------ de-dupe */
  const deduped = dedupe(
    staged.map((s) => ({ ...s, replyText: s.reply_text })),
    3,
  ).map(({ replyText: _drop, ...rest }) => rest);
  note(`${staged.length} → ${deduped.length} after collapsing repeated templates`);

  let finalRows = opts.limit ? deduped.slice(0, opts.limit) : deduped;

  /* ------------------------------------------------------------- embed */
  if (opts.embed) {
    if (!opts.apiKey) throw new Error("embed requested without an API key");
    const BATCH = 100;
    for (let i = 0; i < finalRows.length; i += BATCH) {
      const slice = finalRows.slice(i, i + BATCH);
      const vectors = await embedBatch(opts.apiKey, slice.map((r) => r.inbound_text));
      slice.forEach((r, j) => {
        (r as Record<string, unknown>).embedding = vectors[j] ?? null;
        (r as Record<string, unknown>).embedding_model = "text-embedding-3-small";
      });
      report.embedded += vectors.filter(Boolean).length;
      note(`embedded ${report.embedded}/${finalRows.length}`);
    }
  }

  /* ------------------------------------------------------------- write */
  const WRITE = 200;
  if (opts.dryRun) note("dry run — nothing written");

  if (!opts.dryRun) {
    /*
     * CORRECTIONS ARE NOT OVERWRITTEN.
     *
     * A reply somebody wrote over the agent's draft is stored here with
     * `source = 'correction'` and the outbound message's id — because it IS an
     * outbound message, this pass would pair it again, find nothing special
     * about it, and upsert it back to `source = 'history'` at a lower quality.
     * The most instructive examples we have would quietly decay into ordinary
     * ones on every rebuild.
     *
     * One query, and the ids it returns are dropped from this write.
     */
    const keep = new Set<string>();
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error } = await osTable("os_reply_examples")
        .select("outbound_message_id")
        .eq("workspace_id", opts.workspaceId)
        .eq("source", "correction")
        .not("outbound_message_id", "is", null)
        .range(from, from + 999);
      if (error) throw new Error(`could not read existing corrections: ${error.message}`);
      const rows = (data ?? []) as Array<{ outbound_message_id: string | null }>;
      for (const r of rows) if (r.outbound_message_id) keep.add(r.outbound_message_id);
      if (rows.length < 1000) break;
    }
    if (keep.size > 0) {
      const kept = finalRows.length;
      finalRows = finalRows.filter((r) => !keep.has(r.outbound_message_id));
      report.correctionsKept = kept - finalRows.length;
      note(`left ${report.correctionsKept} corrections untouched`);
    }
  }

  for (let i = 0; opts.dryRun ? false : i < finalRows.length; i += WRITE) {
    const slice = finalRows.slice(i, i + WRITE).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await osTable("os_reply_examples").upsert(slice, { onConflict: "outbound_message_id" });
    if (error) throw new Error(`corpus write failed: ${error.message}`);
    report.written += slice.length;
  }

  /*
   * ------------------------------------------------------- catch-up embeds
   *
   * Corrections are filed on send WITHOUT an embedding, on purpose: embedding
   * there would mean decrypting a key and calling OpenAI while somebody waits
   * for their email to go. An example with no vector is invisible to retrieval,
   * so the rebuild finishes the job — a few rows, a fraction of a cent.
   */
  if (!opts.dryRun && opts.embed && opts.apiKey) {
    const { data: missing } = await osTable("os_reply_examples")
      .select("id, inbound_text")
      .eq("workspace_id", opts.workspaceId)
      .is("embedding", null)
      .limit(500);
    const rows = (missing ?? []) as Array<{ id: string; inbound_text: string }>;
    for (let i = 0; i < rows.length; i += 100) {
      const slice = rows.slice(i, i + 100);
      const vectors = await embedBatch(opts.apiKey, slice.map((r) => r.inbound_text));
      for (let j = 0; j < slice.length; j++) {
        const v = vectors[j];
        if (!v) continue;
        await osTable("os_reply_examples")
          .update({ embedding: v, embedding_model: "text-embedding-3-small" })
          .eq("id", slice[j].id);
        report.embedded++;
      }
    }
    if (rows.length > 0) note(`embedded ${rows.length} rows that had no vector`);
  }

  report.samples = finalRows
    .slice()
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5)
    .map((r) => ({
      label: r.label,
      quality: r.quality,
      inbound: r.inbound_text.slice(0, 180),
      reply: r.reply_text.slice(0, 220),
    }));

  return report;
}
