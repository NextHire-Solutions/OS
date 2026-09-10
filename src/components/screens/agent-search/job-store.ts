"use client";

import { SOURCES, type SourceId } from "@/lib/tools/agent-search/columns";

/*
 * One scrape job, shared by every Agent Search screen.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE STORE AND NOT REACT CONTEXT
 *
 * In the live tool all of this is ONE page, so "Add account & start sweep" on
 * the accounts card and the live Courted rows below it are trivially the same
 * job. The workspace splits that page into five rail destinations, and they
 * are mounted as siblings by a shell this port must not edit — so there is
 * nowhere to hang a provider that covers all five.
 *
 * A module-level store solves it without touching the shell: the screens
 * subscribe through useSyncExternalStore, and a sweep started on Courted
 * accounts streams into the panels on Search, which is exactly the tool's
 * behaviour. It also survives a screen being unmounted, which matters because
 * a sweep runs for hours and navigating away must not orphan the poll.
 *
 * ---------------------------------------------------------------------------
 * POLLING, NOT SSE
 *
 * The tool has an SSE endpoint and abandoned it: "Poll for results (robust —
 * SSE/EventSource was dropping the realtor record burst after long fetches)"
 * (app.js:139). Same interval (1500ms), same offset-per-source protocol, same
 * retry-on-error-at-2000ms.
 */

export type JobStatus = "idle" | "queued" | "running" | "done" | "error" | "stopped";

export interface SourceState {
  status: JobStatus;
  message: string;
  /** Matched total the source reports, when it knows one. */
  total: number | null;
  /** Rows the SERVER has fetched — a full sweep streams to the DB, not here. */
  serverCount: number;
  rows: Record<string, unknown>[];
  /** Was this source part of the current run? Inactive panels are dimmed. */
  active: boolean;
}

export interface JobState {
  jobId: string | null;
  running: boolean;
  /** Where the run was started, so the right screen shows the right message. */
  origin: "search" | "sweep" | null;
  sweepEmail: string | null;
  sources: Record<SourceId, SourceState>;
  error: string | null;
}

const emptySource = (active: boolean): SourceState => ({
  status: active ? "queued" : "idle",
  message: "",
  total: null,
  serverCount: 0,
  rows: [],
  active,
});

function blank(active: SourceId[] = []): JobState {
  return {
    jobId: null,
    running: false,
    origin: null,
    sweepEmail: null,
    sources: {
      courted: emptySource(active.includes("courted")),
      zillow: emptySource(active.includes("zillow")),
      realtor: emptySource(active.includes("realtor")),
    },
    error: null,
  };
}

let state: JobState = blank();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function set(next: Partial<JobState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function setSource(id: SourceId, patch: Partial<SourceState>) {
  state = { ...state, sources: { ...state.sources, [id]: { ...state.sources[id], ...patch } } };
  for (const l of listeners) l();
}

export const jobStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot(): JobState {
    return state;
  },
  /** The server render has no job — same object every time, or React loops. */
  getServerSnapshot(): JobState {
    return SERVER_SNAPSHOT;
  },

  /**
   * Start a run. `active` is which panels light up; the tool dims the rest to
   * 0.4 rather than hiding them, so the layout does not jump.
   */
  async start(
    body: Record<string, unknown>,
    opts: { active: SourceId[]; origin: "search" | "sweep"; sweepEmail?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    stopPolling();
    state = { ...blank(opts.active), running: true, origin: opts.origin, sweepEmail: opts.sweepEmail ?? null };
    for (const l of listeners) l();

    try {
      const res = await fetch("/api/tools/agent-search/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || data.error || !data.jobId) {
        const error = data.error ?? `Could not start the search (${res.status})`;
        set({ running: false, error });
        return { ok: false, error };
      }
      set({ jobId: data.jobId });
      poll(data.jobId);
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : "Could not start the search";
      set({ running: false, error });
      return { ok: false, error };
    }
  },

  /**
   * Stop the run.
   *
   * Mirrors app.js `stopSearch`: tell the server, stop polling, and mark any
   * source still reading "running"/"queued" as stopped. Rows already captured
   * stay — the tool's abort is cooperative and everything flushed to the
   * database is already there.
   */
  stop() {
    const id = state.jobId;
    if (id) {
      void fetch(`/api/tools/agent-search/search/${encodeURIComponent(id)}/stop`, {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
    }
    stopPolling();
    const sources = { ...state.sources };
    for (const s of SOURCES) {
      if (sources[s].status === "running" || sources[s].status === "queued") {
        sources[s] = { ...sources[s], status: "stopped", message: "stopped" };
      }
    }
    state = { ...state, running: false, sources };
    for (const l of listeners) l();
  },

  /** Has this job produced anything the master builder could work on? */
  hasRows(): boolean {
    return SOURCES.some((s) => state.sources[s].rows.length > 0);
  },
};

const SERVER_SNAPSHOT = blank();

function stopPolling() {
  if (timer) { clearTimeout(timer); timer = null; }
}

function poll(jobId: string) {
  const query = SOURCES.map((s) => `${s}=${state.sources[s].rows.length}`).join("&");
  fetch(`/api/tools/agent-search/search/${encodeURIComponent(jobId)}/results?${query}`, {
    credentials: "same-origin",
  })
    .then((r) => r.json())
    .then((d: {
      status?: string;
      error?: string;
      sources?: Record<string, { status?: string; message?: string; total?: number | null; count?: number; newRows?: Record<string, unknown>[] }>;
    }) => {
      // A job id the server has forgotten (container restarted mid-run) comes
      // back as an error. Finish rather than poll a ghost forever.
      if (d.error) { finish(); return; }

      for (const s of SOURCES) {
        const sc = d.sources?.[s];
        if (!sc) continue;
        const cur = state.sources[s];
        const patch: Partial<SourceState> = {};
        if (sc.total != null) patch.total = sc.total;
        if (sc.count != null) patch.serverCount = sc.count;
        if (sc.newRows?.length) patch.rows = [...cur.rows, ...sc.newRows];
        // "pending" is the tool's not-started-yet marker; leave the pill alone.
        if (sc.status && sc.status !== "pending") {
          patch.status = sc.status as JobStatus;
          patch.message = sc.message ?? "";
        }
        if (Object.keys(patch).length) setSource(s, patch);
      }

      if (d.status !== "running") { finish(); return; }
      if (state.running) timer = setTimeout(() => poll(jobId), 1500);
    })
    .catch(() => {
      // A dropped request during an hours-long sweep is normal. Back off
      // slightly and keep going rather than declaring the job dead.
      if (state.running) timer = setTimeout(() => poll(jobId), 2000);
    });
}

function finish() {
  stopPolling();
  set({ running: false });
}
