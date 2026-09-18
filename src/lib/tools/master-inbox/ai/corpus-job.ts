import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { osTable } from "@/lib/clients/os-db";
import { buildReplyCorpus, type BuildReport } from "./corpus";
import { loadAgents, loadAgentWithKey } from "./agent";
import { invalidatePool } from "./retrieval";

/*
 * Rebuilding the corpus, as a job rather than a request.
 *
 * Reading 36,000 messages and embedding twelve hundred of them takes minutes —
 * far longer than a browser should hold a connection open. So the route starts
 * this and returns immediately; the screen polls `corpusStatus()`.
 *
 * The API key is the one the reply agent already holds, decrypted server-side.
 * That is also why this cannot run from a laptop: the encryption key lives only
 * on the server, which is where it should stay.
 */

interface JobState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  note: string;
  error: string | null;
  report: BuildReport | null;
}

/*
 * One job per process, on the global, so a hot reload in development cannot
 * start a second one on top of the first. Same guard the schedulers use.
 */
const KEY = Symbol.for("brokerstaffer.ai.corpus.job");
type Holder = { [KEY]?: JobState };

function state(): JobState {
  const g = globalThis as unknown as Holder;
  if (!g[KEY]) {
    g[KEY] = { running: false, startedAt: null, finishedAt: null, note: "", error: null, report: null };
  }
  return g[KEY]!;
}

export interface CorpusStatus extends JobState {
  /*
   * False when os_reply_examples does not exist — i.e. migrations/0006 has not
   * been run. Not inferable from `examples`, which is 0 in both cases: see the
   * note beside the probe below.
   */
  available: boolean;
  /** What is actually in the table right now, job or no job. */
  examples: number;
  embedded: number;
  lastBuiltAt: string | null;
  byLabel: Array<{ label: string; count: number }>;
}

export async function corpusStatus(): Promise<CorpusStatus> {
  const s = state();
  const base = { ...s, available: false, examples: 0, embedded: 0, lastBuiltAt: null as string | null, byLabel: [] as Array<{ label: string; count: number }> };

  /*
   * A ROW READ, NOT A COUNT, to find out whether the table is there.
   *
   * A counting query against a table PostgREST has never heard of returns 204
   * with `count: null` and no error — so every number below would read as a
   * confident zero for a corpus that cannot exist yet. That is precisely what
   * happened on the first live rebuild: the job ran for fifty seconds, paired
   * 2,627 replies, embedded 1,261 of them and then failed on the write with
   * "Could not find the table 'public.os_reply_examples' in the schema cache" —
   * while this endpoint cheerfully reported examples=0, error=null.
   */
  const { error: probe } = await osTable("os_reply_examples").select("id").limit(1);
  if (probe) return base;
  base.available = true;

  const { count } = await osTable("os_reply_examples").select("*", { count: "exact", head: true });
  base.examples = count ?? 0;

  const { count: embedded } = await osTable("os_reply_examples")
    .select("*", { count: "exact", head: true })
    .not("embedding", "is", null);
  base.embedded = embedded ?? 0;

  const { data: latest } = await osTable("os_reply_examples")
    .select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  base.lastBuiltAt = (latest?.updated_at as string | null) ?? null;

  // A per-situation breakdown, so the screen can show what it knows about.
  /*
   * PAGED, because `.limit(5000)` does not mean what it looks like.
   *
   * PostgREST caps a response at its own max-rows, which is 1,000 here, and
   * says nothing about having truncated. The breakdown on screen therefore
   * summed to exactly 1,000 against a corpus of 1,261, and dropped the whole
   * "Objection" situation — 146 examples — off the list. A number that is
   * quietly capped is worse than one that is missing, because it looks fine.
   *
   * 1,261 rows of one short column is nothing to read; the loop simply keeps
   * asking until a page comes back short.
   */
  const tally = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data: page, error } = await osTable("os_reply_examples")
      .select("label")
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (page ?? []) as Array<{ label: string | null }>;
    for (const r of rows) {
      const k = r.label ?? "unlabelled";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  base.byLabel = [...tally.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return base;
}

export type StartResult =
  | { started: true }
  | { started: false; reason: "already-running" | "no-agent-key" | "no-workspace" | "no-table" };

export async function startCorpusRebuild(): Promise<StartResult> {
  const s = state();
  if (s.running) return { started: false, reason: "already-running" };

  const admin = createAdminSupabase();
  const { data: ws } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  const workspaceId = (ws?.id as string | undefined) ?? null;
  if (!workspaceId) return { started: false, reason: "no-workspace" };

  /*
   * Refuse early if the table is not there.
   *
   * Without this the job reads 37,000 messages, spends real money embedding
   * 1,261 of them and only then discovers it has nowhere to put them — which is
   * exactly what the first live run did. Fifty seconds and a few cents to learn
   * something one query answers instantly.
   */
  const { error: probe } = await osTable("os_reply_examples").select("id").limit(1);
  if (probe) return { started: false, reason: "no-table" };

  const agents = await loadAgents(workspaceId);
  const candidate = agents.find((a) => a.active && a.has_api_key) ?? agents.find((a) => a.has_api_key);
  if (!candidate) return { started: false, reason: "no-agent-key" };
  const withKey = await loadAgentWithKey(candidate.id);
  if (!withKey?.api_key) return { started: false, reason: "no-agent-key" };

  s.running = true;
  s.startedAt = new Date().toISOString();
  s.finishedAt = null;
  s.error = null;
  s.report = null;
  s.note = "starting";

  // Fire and forget: the caller has already been answered.
  void (async () => {
    try {
      const report = await buildReplyCorpus({
        workspaceId,
        embed: true,
        apiKey: withKey.api_key!,
        onProgress: (note) => {
          s.note = note;
          console.log("[ai:corpus]", note);
        },
      });
      s.report = report;
      /*
       * Retrieval keeps the embedded corpus in process memory for ten minutes.
       * Without this, a rebuild finishes and the next ten minutes of drafts are
       * still written against the OLD corpus — which looks exactly like the
       * rebuild having done nothing.
       */
      invalidatePool(workspaceId);
      s.note = `done — ${report.written} examples, ${report.embedded} embedded`;
      console.log("[ai:corpus]", s.note, JSON.stringify(report.rejected));
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
      s.note = "failed";
      console.error("[ai:corpus] rebuild failed", err);
    } finally {
      s.running = false;
      s.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}
