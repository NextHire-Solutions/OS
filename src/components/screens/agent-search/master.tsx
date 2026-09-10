"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import { SOURCES } from "@/lib/tools/agent-search/columns";
import type { MasterStats, Row } from "@/lib/tools/agent-search/merge";
import { jobStore } from "./job-store";
import { AgentSearchHeader, Card, Cell, Msg, useStatus } from "./shared";

/*
 * Master List — the de-duplicated view across all three sources.
 *
 * The merge itself is `buildMaster`, ported verbatim to
 * lib/tools/agent-search/merge.ts and pinned by 16 tests. It is nonetheless
 * FETCHED from the live service here, and the reason is worth stating: the
 * scraped rows live in that container's memory. On a full sweep they are never
 * sent to the browser at all — they stream straight to the ingest webhook — so
 * there is nothing local to merge. Asking the service is not a shortcut; it is
 * the only place the input exists.
 *
 * What the port buys is that the algorithm is now readable and under test
 * instead of being a black box behind one endpoint.
 */

interface MasterPayload {
  columns?: string[];
  rows?: Row[];
  stats?: MasterStats;
  error?: string;
}

export function AgentSearchMasterScreen() {
  const status = useStatus();
  const job = useSyncExternalStore(jobStore.subscribe, jobStore.getSnapshot, jobStore.getServerSnapshot);

  const [data, setData] = useState<MasterPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const scraped = SOURCES.reduce((n, s) => n + job.sources[s].rows.length, 0);
  const canBuild = Boolean(job.jobId) && scraped > 0;

  const build = useCallback(async () => {
    if (!job.jobId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/tools/agent-search/search/${encodeURIComponent(job.jobId)}/master`, {
        credentials: "same-origin",
      });
      const body = (await res.json()) as MasterPayload;
      if (!res.ok || body.error) throw new Error(body.error ?? `Master build failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Master build failed");
    } finally {
      setBusy(false);
    }
  }, [job.jobId]);

  const stats = data?.stats;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];

  return (
    <div className="as">
      <AgentSearchHeader
        title="Master List"
        sub="One row per agent — the same person on Courted, Zillow and Realtor.com merged"
        status={status}
      />

      <Card
        title="★ Master List"
        small="deduplicated across all sources"
        sub="Agents are merged on strong signals only: a shared phone, a shared email, a licence plus surname, or an identical name in the same city. Every merged row records which signals matched, so the result can be audited."
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="as-btn" onClick={() => void build()} disabled={!canBuild || busy}
            style={!canBuild || busy ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
            {busy ? "Matching…" : data ? "Rebuild master list" : "Build master list"}
          </button>
          <button
            className="as-btn ghost"
            disabled={!job.jobId || rows.length === 0}
            style={!job.jobId || rows.length === 0 ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            onClick={() => {
              if (job.jobId) {
                window.location.href =
                  `/api/tools/agent-search/search/${encodeURIComponent(job.jobId)}/export?source=master`;
              }
            }}
          >
            Export CSV
          </button>
        </div>

        <div style={{ marginTop: 16, fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>
          {busy ? (
            "Analysing & matching agents across platforms…"
          ) : stats ? (
            <>
              <b className="tnum" style={{ color: "var(--ink)" }}>{stats.unique.toLocaleString("en-US")}</b> unique agents
              {" · "}
              <b className="tnum" style={{ color: "var(--ink)" }}>{stats.duplicatesRemoved.toLocaleString("en-US")}</b> duplicates merged
              {" · "}
              <b className="tnum" style={{ color: "var(--ink)" }}>{stats.multiPlatform.toLocaleString("en-US")}</b> found on 2+ platforms
              <br />
              <span style={{ fontSize: 12.5 }}>
                from {stats.totalScraped.toLocaleString("en-US")} scraped — Courted {stats.bySource.courted.toLocaleString("en-US")},
                {" "}Zillow {stats.bySource.zillow.toLocaleString("en-US")},
                {" "}Realtor {stats.bySource.realtor.toLocaleString("en-US")}
              </span>
            </>
          ) : canBuild ? (
            `Ready — ${scraped.toLocaleString("en-US")} rows from the current run.`
          ) : (
            "Run a search, then build a combined unique list — the same agent across Courted / Zillow / Realtor is merged into one row."
          )}
        </div>
        <Msg text={error} tone="error" />
      </Card>

      {rows.length > 0 ? (
        <div className="as-res b">
          <div className="as-res-h">
            <h3>Merged agents</h3>
            <span className="as-cnt tnum">{rows.length.toLocaleString("en-US")}</span>
          </div>
          <div className="tbl-scroll">
            <table className="atbl" style={{ minWidth: Math.max(900, columns.length * 132) }}>
              <thead>
                <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const multi = (Number(row["Platform Count"]) || 1) > 1;
                  return (
                    // Multi-platform rows tinted, as the tool does with tr.multi —
                    // they are the point of the whole screen.
                    <tr key={i} style={multi ? { background: "var(--blue-pale)" } : undefined}>
                      {columns.map((c) => <Cell key={c} col={c} value={row[c]} />)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
