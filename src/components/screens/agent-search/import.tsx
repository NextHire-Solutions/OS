"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { IMPORT_COLUMNS } from "@/lib/tools/agent-search/columns";
import { importNote } from "@/lib/tools/agent-search/format";
import { buildEnrichPayload } from "@/lib/tools/agent-search/payload";
import { Actions, AgentSearchHeader, Card, Check, Field, Msg, StatusPill, useStatus } from "./shared";

/*
 * Import Profile URLs — the F1 enrichment flow.
 *
 * Paste a shared Google Sheet or a CSV of Zillow / Realtor profile URLs; each
 * agent is scraped, cross-checked against the `agents` table by identity, and
 * only genuinely-new agents are written. Existing rows are never modified —
 * the write path is insert-only, which is why the reconcile pass is so
 * cautious about what counts as a match.
 *
 * The two-step shape is deliberate and is the tool's: Detect first, Start
 * second. Detect is free and tells you how many URLs and roughly what it will
 * cost; Start spends it. Never collapse them.
 */

interface EnrichRow {
  status?: string;
  source?: string;
  url?: string;
  message?: string;
  row?: Record<string, unknown>;
}

interface EnrichState {
  status: string;
  message?: string;
  total: number;
  done: number;
  counts?: Record<string, number>;
  estCostUsd?: number;
  newRows?: EnrichRow[];
}

export function AgentSearchImportScreen() {
  const status = useStatus();
  const [sheetUrl, setSheetUrl] = useState("");
  const [csv, setCsv] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [scheduled, setScheduled] = useState(false);

  const [resolving, setResolving] = useState(false);
  const [canStart, setCanStart] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<EnrichState | null>(null);
  const [rows, setRows] = useState<EnrichRow[]>([]);
  const rendered = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const say = (t: string, e = false) => { setMsg(t); setIsError(e); };

  /* ---------------------------------------------------------------- detect */

  const resolve = useCallback(async () => {
    const built = buildEnrichPayload(sheetUrl, csv, concurrency);
    if (!built.ok) { say(built.error, true); return; }
    setResolving(true);
    say("Detecting profile URLs…");
    try {
      const res = await fetch("/api/tools/agent-search/enrich/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ sheetUrl: built.payload.sheetUrl, csv: built.payload.csv }),
      });
      const d = (await res.json()) as {
        error?: string; total?: number; zillow?: number; realtor?: number;
        withIdentity?: number; estCostUsd?: number;
      };
      if (!res.ok || d.error) throw new Error(d.error ?? "request failed");
      if (!d.total) {
        setCanStart(false);
        say("No Zillow or Realtor profile URLs found in that input.", true);
        return;
      }
      setCanStart(true);
      say(`Found ${d.total.toLocaleString("en-US")} profile URLs — ` +
          `${(d.zillow ?? 0).toLocaleString("en-US")} Zillow · ${(d.realtor ?? 0).toLocaleString("en-US")} Realtor` +
          `${d.withIdentity ? ` · ${d.withIdentity.toLocaleString("en-US")} carry an email or phone to pre-match on` : ""}` +
          ` · est. cost ~$${d.estCostUsd}. Click Start enrichment.`);
    } catch (e) {
      say("Detect failed: " + (e instanceof Error ? e.message : "unknown error"), true);
    } finally {
      setResolving(false);
    }
  }, [sheetUrl, csv, concurrency]);

  /* ----------------------------------------------------------------- start */

  async function start() {
    const built = buildEnrichPayload(sheetUrl, csv, concurrency);
    if (!built.ok) { say(built.error, true); return; }

    setRows([]);
    rendered.current = 0;
    setJob(null);
    setRunning(true);
    try {
      const res = await fetch("/api/tools/agent-search/enrich", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify(built.payload),
      });
      const d = (await res.json()) as {
        error?: string; enrichId?: string; total?: number;
        detected?: { zillow: number; realtor: number }; estCostUsd?: number;
      };
      if (!res.ok || d.error || !d.enrichId) throw new Error(d.error ?? "request failed");
      setJobId(d.enrichId);
      say(`Enriching ${(d.total ?? 0).toLocaleString("en-US")} profiles ` +
          `(${d.detected?.zillow ?? 0} Zillow · ${d.detected?.realtor ?? 0} Realtor) — est ~$${d.estCostUsd}.` +
          // The tool says the same thing, because the checkbox is not wired up
          // there either. See the parity checklist, item 5.5.
          (scheduled ? " Scheduled auto-runs will activate once the database connection is wired." : ""));
      poll(d.enrichId, 0);
    } catch (e) {
      say("Start failed: " + (e instanceof Error ? e.message : "unknown error"), true);
      setRunning(false);
    }
  }

  function poll(id: string, offset: number) {
    fetch(`/api/tools/agent-search/enrich/${encodeURIComponent(id)}?offset=${offset}`, {
      credentials: "same-origin",
    })
      .then((r) => r.json())
      .then((d: EnrichState & { error?: string }) => {
        if (d.error) { finish("error"); return; }
        const fresh = d.newRows ?? [];
        if (fresh.length) setRows((prev) => [...prev, ...fresh]);
        rendered.current += fresh.length;
        setJob(d);
        if (d.status !== "running") { finish(d.status); return; }
        timer.current = setTimeout(() => poll(id, rendered.current), 1500);
      })
      .catch(() => { timer.current = setTimeout(() => poll(id, rendered.current), 2500); });
  }

  function finish(state?: string) {
    setRunning(false);
    if (timer.current) clearTimeout(timer.current);
    if (state === "error") say("Enrichment stopped with an error — partial results are shown below.", true);
    else if (state === "stopped") say("Stopped. Everything processed so far is shown below.");
    else say("Enrichment complete.");
  }

  function stop() {
    if (!jobId) return;
    void fetch(`/api/tools/agent-search/enrich/${encodeURIComponent(jobId)}/stop`, {
      method: "POST", credentials: "same-origin",
    }).catch(() => {});
    say("Stopping…");
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? "")); say(`Loaded ${file.name} — click Detect URLs.`); };
    reader.onerror = () => say("Could not read that file.", true);
    reader.readAsText(file);
  }

  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  const c = job?.counts ?? {};

  return (
    <div className="as as-screen">
      <AgentSearchHeader
        title="Import Profile URLs"
        sub="Scrape a list of Zillow / Realtor.com profiles and add only the agents you don't already have"
        status={status}
      />

      <Card
        title="📥 Import Profile URLs"
        small="enrichment"
        sub="Paste a shared Google Sheet link (Anyone with the link) or a CSV of Zillow / Realtor.com profile URLs. Each agent is scraped, cross-checked against the database by identity, and only new agents are written — the URLs already scraped are skipped. Existing rows are never modified."
      >
        {/*
          The two inputs are alternatives, so they sit beside each other with
          the "or" between — as the design has them. Left on the bare
          `.as-grid` (which declares no columns) this collapsed to a single
          column: a full-width link box, a stranded "or", and a full-width
          textarea underneath, reading as three sequential steps rather than a
          choice of two. See `.as-io` in tool-agent-search.css.
        */}
        <div className="as-grid as-io">
          <Field label="Google Sheet link" hint="(shared: Anyone with the link)">
            <input className="as-i" type="text" value={sheetUrl} autoComplete="off"
              placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
              onChange={(e) => { setSheetUrl(e.target.value); setCanStart(false); }} />
          </Field>
          <div className="as-or">or</div>
          <Field label="Upload / paste CSV of URLs">
            <textarea className="as-ta" rows={3} value={csv}
              placeholder={"Pick a .csv file below, or paste rows / URLs here\nhttps://www.zillow.com/profile/…\nhttps://www.realtor.com/realestateagents/…"}
              onChange={(e) => { setCsv(e.target.value); setCanStart(false); }} />
            <input className="as-file" type="file" accept=".csv,text/csv,text/plain"
              aria-label="Upload a CSV of profile URLs" onChange={onFile} />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end", marginTop: 16 }}>
          <div style={{ maxWidth: 190 }}>
            <Field label="Concurrency" hint="(4 safe)">
              <input className="as-i tnum" type="number" min={1} max={8} value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)} />
            </Field>
          </div>
          <div style={{ paddingBottom: 11 }}>
            <Check checked={scheduled} onChange={setScheduled}
              label="Run on a schedule" hint="(auto re-check — not yet implemented in the tool)" />
          </div>
        </div>

        <Actions>
          <button className="as-btn ghost" onClick={() => void resolve()} disabled={resolving || running}>
            {resolving ? "Detecting…" : "Detect URLs"}
          </button>
          <button className="as-btn" onClick={() => void start()} disabled={!canStart || running}
            title={canStart ? "Scrape these profiles" : "Run Detect URLs first"}>
            Start enrichment
          </button>
          {running ? (
            <button className="as-btn ghost" style={{ color: "var(--red)" }} onClick={stop}>■ Stop</button>
          ) : null}
        </Actions>

        {job ? (
          <div style={{ marginTop: 18 }}>
            <div style={{ height: 8, borderRadius: 5, background: "var(--inset-2)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: "var(--blue)", transition: "width .3s" }} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 11, fontSize: 12.5 }}>
              <b className="tnum" style={{ color: "var(--ink)" }}>{job.done.toLocaleString("en-US")}</b>
              <span style={{ color: "var(--muted)" }}>/ {job.total.toLocaleString("en-US")} processed</span>
              <Tag label="scraped" n={c.alive} tone="ok" />
              {c.new ? <Tag label="new" n={c.new} tone="new" /> : null}
              {c.enriched ? <Tag label="enriched" n={c.enriched} tone="new" /> : null}
              {c.skipped ? <Tag label="skipped" n={c.skipped} /> : null}
              <Tag label="dead" n={c.dead} />
              <Tag label="blocked/err" n={(c.blocked ?? 0) + (c.error ?? 0)} tone="bad" />
              <span className="tnum" style={{ color: "var(--muted)" }}>~${job.estCostUsd}</span>
            </div>
          </div>
        ) : null}

        <Msg text={msg} tone={isError ? "error" : undefined} />
      </Card>

      {rows.length > 0 ? (
        <div className="as-res b">
          <div className="as-res-h">
            <h3>Imported agents</h3>
            <StatusPill status={running ? "running" : "done"} />
            <span className="as-cnt tnum">{rows.length.toLocaleString("en-US")}</span>
          </div>
          <div className="tbl-scroll">
            <table className="atbl" style={{ minWidth: 1100 }}>
              <thead>
                <tr>{IMPORT_COLUMNS.map((c2) => <th key={c2}>{c2}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => <ImportRow key={i} r={r} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One result row, in the tool's own eight columns. */
function ImportRow({ r }: { r: EnrichRow }) {
  const row = r.row ?? {};
  const url = (r.source === "zillow" ? row["Zillow Profile URL"] : row["Realtor Profile URL"]) ?? r.url ?? "";
  const tone: Record<string, string> = {
    new: "var(--green)", enriched: "var(--green)", skipped: "var(--muted)",
    dead: "var(--muted)", blocked: "var(--amber)", error: "var(--red)",
  };
  const text = (v: unknown) => (v == null ? "" : String(v));
  return (
    <tr>
      <td style={{ color: tone[r.status ?? ""] ?? "var(--ink-2)", fontWeight: 600 }}>{r.status ?? ""}</td>
      <td>{r.source ?? ""}</td>
      <td>{text(row["Name"])}</td>
      <td>{text(row["Phone"] || row["Mobile Phone"])}</td>
      <td>{text(row["Email"])}</td>
      <td>{text(row["License Number"])}</td>
      <td>
        {url ? <a href={String(url)} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>link</a> : null}
      </td>
      <td style={{ color: "var(--muted)", fontSize: 12.5, maxWidth: 320 }}>{importNote(r)}</td>
    </tr>
  );
}

function Tag({ label, n, tone }: { label: string; n?: number; tone?: "ok" | "new" | "bad" }) {
  const bg = tone === "new" ? "var(--green-pale)" : tone === "bad" ? "var(--red-pale)" : "var(--inset-2)";
  const fg = tone === "new" ? "var(--green)" : tone === "bad" ? "var(--red)" : "var(--muted)";
  return (
    <span style={{ background: bg, color: fg, borderRadius: 7, padding: "3px 8px", fontWeight: 500 }}>
      {label}: <b className="tnum">{(n ?? 0).toLocaleString("en-US")}</b>
    </span>
  );
}
