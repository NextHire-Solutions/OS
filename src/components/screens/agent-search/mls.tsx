"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  diffAccount, indexScan, loadStoredBaseline, saveStoredBaseline,
  type BaselineIndex, type ScannedAccount, type StoredBaseline,
} from "@/lib/tools/agent-search/baseline";
import type { CourtedState } from "@/lib/tools/agent-search/courted-state";
import { mlsDisplayName } from "@/lib/tools/agent-search/format";
import { Actions, AgentSearchHeader, Card, Msg, ago, useStatus } from "./shared";

/*
 * MLS monitor — which MLSs each Courted account can see, and what changed.
 *
 * ---------------------------------------------------------------------------
 * TWO BASELINES, AND WHY BOTH ARE HERE
 *
 * The tool has two, does not know it, and shows the weaker one.
 *
 *   BROWSER   app.js keeps `mlsBaseline_v1` in localStorage. You scan, click
 *             "Save as baseline", scan again later, and it diffs. It is empty
 *             on a new machine, disagrees between machines, and dies with the
 *             site data.
 *   SERVER    mls-monitor.js writes `mls_monitor_state` every 24 hours and
 *             Slacks on any change. It is authoritative, it is current, and
 *             the tool's UI never reads it.
 *
 * Both are offered here, switchable. The server one is the default because it
 * is the one that is actually true, and it means this screen answers "what has
 * changed?" on a machine that has never run a scan — which the tool cannot do.
 * The browser baseline keeps the tool's exact key and shape, so nothing is
 * lost for anyone who relies on it.
 */

interface ScanState {
  status: string;
  message: string;
  total: number;
  done: number;
  accounts: ScannedAccount[];
}

export function AgentSearchMlsScreen() {
  const status = useStatus();
  const [server, setServer] = useState<CourtedState | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);
  const [stored, setStored] = useState<StoredBaseline | null>(null);
  const [compareTo, setCompareTo] = useState<"server" | "browser">("server");
  const [monitorRunning, setMonitorRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadServer = useCallback(() => {
    fetch("/api/tools/agent-search/courted-state", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s: CourtedState) => setServer(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadServer();
    setStored(loadStoredBaseline());
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [loadServer]);

  const say = (t: string, e = false) => { setMsg(t); setIsError(e); };

  /* --------------------------------------------------------------- scanning */

  async function startScan() {
    setRunning(true);
    setScan(null);
    say("Starting scan — this logs into every saved account, ~1–3 min…");
    try {
      const res = await fetch("/api/tools/agent-search/courted/mls-scan", {
        method: "POST", credentials: "same-origin",
      });
      const d = (await res.json()) as { scanId?: string; error?: string };
      if (!res.ok || d.error || !d.scanId) throw new Error(d.error ?? "could not start");
      setScanId(d.scanId);
      poll(d.scanId);
    } catch (e) {
      say("Scan failed to start: " + (e instanceof Error ? e.message : "unknown"), true);
      setRunning(false);
    }
  }

  function poll(id: string) {
    fetch(`/api/tools/agent-search/courted/mls-scan/${encodeURIComponent(id)}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: ScanState & { error?: string }) => {
        if (d.error) throw new Error(d.error);
        setScan(d);
        if (d.status === "running") { timer.current = setTimeout(() => poll(id), 2000); return; }
        setRunning(false);
        say(`${d.message} ${baselineFor() ? "Changes vs the baseline are marked below." : "No baseline yet."}`);
        loadServer();
      })
      .catch((e) => {
        say("Scan error: " + (e instanceof Error ? e.message : "unknown"), true);
        setRunning(false);
      });
  }

  function stopScan() {
    if (!scanId) return;
    void fetch(`/api/tools/agent-search/courted/mls-scan/${encodeURIComponent(scanId)}/stop`, {
      method: "POST", credentials: "same-origin",
    }).catch(() => {});
    say("Stopping…");
  }

  /*
   * Run the AUTOMATIC monitor now — the same code the 24-hourly scheduler
   * runs, not the read-only scan above. It diffs every account against the
   * SERVER baseline, Slacks on any add/remove or login failure, and then saves
   * the fresh baseline — but only for accounts that scanned cleanly, so a
   * stale password can never wipe an account's history.
   *
   * This is the tool's POST /api/courted/mls-monitor/run, which its own UI
   * never exposes: there, the only way to run it was to wait 24 hours or curl
   * the endpoint by hand.
   */
  async function runMonitorNow() {
    setMonitorRunning(true);
    say("Running the monitor — logging into every account and diffing against the server baseline…");
    try {
      const res = await fetch("/api/tools/agent-search/courted/mls-monitor", {
        method: "POST", credentials: "same-origin",
      });
      const d = (await res.json()) as {
        error?: string; ok?: boolean; scanned?: number; changes?: number;
        failures?: number; alerted?: boolean; message?: string;
      };
      if (!res.ok || d.error) throw new Error(d.error ?? d.message ?? "monitor failed");
      say(`Monitor finished — ${d.scanned ?? 0} account(s) scanned, ${d.changes ?? 0} changed, ` +
          `${d.failures ?? 0} failed to log in.` +
          (d.alerted ? " Slack alerted." : d.changes || d.failures ? " Slack not configured — the alert was logged." : "") +
          " The server baseline is now up to date.");
      loadServer();
    } catch (e) {
      say("Monitor failed: " + (e instanceof Error ? e.message : "unknown"), true);
    } finally {
      setMonitorRunning(false);
    }
  }

  /* -------------------------------------------------------------- baselines */

  const serverBaseline: BaselineIndex | null = server
    ? indexScan(server.accounts.map((a) => ({
        email: a.email, total: a.total ?? 0,
        mls: a.mls.map((m) => ({ code: m.code, name: m.name, count: m.count ?? 0 })),
      })))
    : null;

  function baselineFor(): BaselineIndex | null {
    return compareTo === "server" ? serverBaseline : (stored?.accounts ?? null);
  }

  function saveBrowserBaseline() {
    if (!scan?.accounts?.length) return;
    const ok = saveStoredBaseline(scan.accounts);
    setStored(loadStoredBaseline());
    say(ok
      ? "Baseline saved in this browser ✓ — re-scan later to see what changed."
      : "This browser refused to store the baseline (private mode?). The server baseline is unaffected.", !ok);
  }

  /*
   * What to show: a fresh scan if there is one, otherwise the server's own
   * last scan. The second case is the point — the screen is useful before you
   * have done anything.
   */
  const showing: ScannedAccount[] = scan?.accounts?.length
    ? scan.accounts
    : (server?.accounts ?? []).map((a) => ({
        email: a.email, total: a.total ?? 0,
        mls: a.mls.map((m) => ({ code: m.code, name: m.name, count: m.count ?? 0 })),
      }));
  const live = Boolean(scan?.accounts?.length);
  const baseline = baselineFor();

  return (
    <div className="as">
      <AgentSearchHeader
        title="MLS monitor"
        sub="Which MLSs each Courted account can reach — and what it gained or lost"
        status={status}
      />

      <Card
        title="🛰️ MLS monitor"
        small="added / removed"
        sub="Scan every saved Courted account to see which MLSs it can access, then compare against a baseline to flag any MLS added or removed. Read-only — nothing is imported and no agent data is touched."
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: 500 }}>Compare against</span>
          <button
            type="button" className={`as-tog${compareTo === "server" ? " on" : ""}`}
            onClick={() => setCompareTo("server")} aria-pressed={compareTo === "server"}
          >
            Server baseline
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>
              {server?.lastScanAt ? ago(server.lastScanAt) : "—"}
            </span>
          </button>
          <button
            type="button" className={`as-tog${compareTo === "browser" ? " on" : ""}`}
            onClick={() => setCompareTo("browser")} aria-pressed={compareTo === "browser"}
          >
            This browser
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>
              {stored ? new Date(stored.savedAt).toLocaleDateString() : "none saved"}
            </span>
          </button>
        </div>

        <Actions>
          <button className="as-btn" onClick={() => void startScan()} disabled={running}
            style={running ? { opacity: 0.55, cursor: "wait" } : undefined}>
            {running ? "Scanning…" : "Scan all accounts"}
          </button>
          {running ? (
            <button className="as-btn ghost" style={{ color: "var(--red)" }} onClick={stopScan}>■ Stop</button>
          ) : null}
          <button className="as-btn ghost" onClick={() => void runMonitorNow()} disabled={monitorRunning || running}
            style={monitorRunning || running ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            title="Diff every account against the server baseline, alert Slack on any change, and save the new baseline">
            {monitorRunning ? "Running monitor…" : "Run monitor now"}
          </button>
          <button className="as-btn ghost" onClick={saveBrowserBaseline}
            disabled={!scan?.accounts?.length}
            style={!scan?.accounts?.length ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
            Save as baseline
          </button>
          {scan ? (
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {scan.done}/{scan.total} account(s) scanned{scan.status === "running" ? " — scanning…" : ""}
            </span>
          ) : null}
        </Actions>
        <Msg text={msg} tone={isError ? "error" : undefined} />
      </Card>

      {server?.error ? (
        <Card title="Server baseline">
          <Msg text={`Could not read the server baseline: ${server.error}`} tone="error" />
        </Card>
      ) : null}

      <Card
        title={live ? "Live scan" : "Last scheduled scan"}
        small={live ? undefined : server?.lastScanAt ? ago(server.lastScanAt) : undefined}
        sub={live
          ? "Results from the scan you just ran."
          : "The 24-hourly scheduler's own most recent scan, read from Agent Search's database. Run a scan above to check for changes right now."}
      >
        {showing.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>No accounts to show yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {showing.map((a) => (
              <AccountBlock key={a.email} account={a} baseline={baseline} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function AccountBlock(
  { account, baseline }: { account: ScannedAccount; baseline: BaselineIndex | null },
) {
  if (account.error) {
    return (
      <div style={{ border: "1px solid var(--red-border)", background: "var(--red-bg)", borderRadius: 12, padding: 14 }}>
        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{account.email}</div>
        {/* A login failure is NOT "lost every MLS" — the tool is careful never
            to baseline a failed account, and the wording has to agree. */}
        <div style={{ fontSize: 12.5, color: "var(--red)", marginTop: 4 }}>
          could not log in / scan: {account.error} — baseline left unchanged
        </div>
      </div>
    );
  }

  const base = baseline?.[account.email]?.codes ?? null;
  const d = diffAccount(base, account.mls ?? []);
  const removed = d.hadBaseline ? d.removed : [];
  const added = d.hadBaseline ? d.added : [];

  return (
    <div style={{
      border: `1px solid ${d.changed ? "var(--amber)" : "var(--line)"}`,
      background: d.changed ? "var(--amber-pale)" : "var(--inset)",
      borderRadius: 12, padding: 14,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>{account.email}</span>
        <span className="tnum" style={{ fontSize: 12.5, color: "var(--muted)" }}>
          {(account.total ?? 0).toLocaleString("en-US")} agents · {(account.mls ?? []).length} MLS
          {(account.mls ?? []).length === 1 ? "" : "s"}
        </span>
        {d.changed ? (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--amber)" }}>CHANGED</span>
        ) : d.hadBaseline ? (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>no change</span>
        ) : (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>no baseline</span>
        )}
      </div>

      <div style={{ display: "grid", gap: 5, marginTop: 10 }}>
        {(account.mls ?? []).map((m) => (
          <div key={m.code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            {added.includes(m.code) ? <Badge tone="add">+ added</Badge> : null}
            <b style={{ color: "var(--ink)", fontWeight: 500 }}>{mlsDisplayName({ code: m.code, name: m.name })}</b>
            <span className="tnum" style={{ color: "var(--muted)", fontSize: 12.5 }}>
              {m.code} · {(m.count ?? 0).toLocaleString("en-US")}
            </span>
          </div>
        ))}
        {removed.map((code) => (
          <div key={code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.75 }}>
            <Badge tone="rem">− removed</Badge>
            <b style={{ color: "var(--ink)", fontWeight: 500, textDecoration: "line-through" }}>
              {mlsDisplayName({ code, name: base?.[code]?.name })}
            </b>
            <span style={{ color: "var(--muted)", fontSize: 12.5 }}>{code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "add" | "rem"; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 6,
      color: tone === "add" ? "var(--green)" : "var(--red)",
      background: tone === "add" ? "var(--green-pale)" : "var(--red-pale)",
    }}>
      {children}
    </span>
  );
}
