"use client";

import { useState, useSyncExternalStore } from "react";

import { SOURCES, type SourceId } from "@/lib/tools/agent-search/columns";
import { buildSearchPayload } from "@/lib/tools/agent-search/payload";
import { jobStore } from "./job-store";
import {
  Actions, AgentSearchHeader, Card, Check, Field, Msg, ResultPanel,
  SOURCE_LABEL, displayColumns, useColumns, useStatus,
} from "./shared";

/*
 * Search — the tool's main card plus its three result panels.
 *
 * Every control here exists in web/public/index.html and every default matches
 * the tool's. Where the tool sends a value the server would default anyway, it
 * is still sent, because the server's default and the input's default are not
 * guaranteed to stay in step and the visible number must be the one that runs.
 */

const TONE_DOT: Record<SourceId, string> = {
  courted: "var(--green)", zillow: "var(--blue)", realtor: "var(--amber)",
};

export function AgentSearchSearchScreen() {
  const status = useStatus();
  const columns = useColumns();
  const job = useSyncExternalStore(jobStore.subscribe, jobStore.getSnapshot, jobStore.getServerSnapshot);

  const [locations, setLocations] = useState("");
  const [on, setOn] = useState<Record<SourceId, boolean>>({ courted: true, zillow: true, realtor: false });
  const [showAll, setShowAll] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [error, setError] = useState("");

  // Courted
  const [courtedMax, setCourtedMax] = useState("0");
  const [minSalesVolume, setMinSalesVolume] = useState("0");
  const [courtedEnrich, setCourtedEnrich] = useState(false);
  const [courtedAllAgents, setCourtedAllAgents] = useState(false);
  // Zillow
  const [zillowMaxPages, setZillowMaxPages] = useState("25");
  const [zillowConcurrency, setZillowConcurrency] = useState("4");
  const [zillowEnrich, setZillowEnrich] = useState(false);
  // Realtor
  const [realtorMax, setRealtorMax] = useState("50");
  const [realtorConcurrency, setRealtorConcurrency] = useState("3");
  const [realtorEnrich, setRealtorEnrich] = useState(false);

  /*
   * Build, then post.
   *
   * The payload is assembled by a pure function so it can be tested WITHOUT
   * being sent — starting a search spends Bright Data traffic, Realtor.com
   * credits and hours of a shared container, so "click it and see" is not an
   * available way to check the request is right. See payload.ts.
   */
  async function start() {
    setError("");
    const built = buildSearchPayload({
      locations, sources: on,
      courtedMax, minSalesVolume, courtedEnrich, courtedAllAgents,
      zillowMaxPages, zillowConcurrency, zillowEnrich,
      realtorMax, realtorConcurrency, realtorEnrich,
    });
    if (!built.ok) { setError(built.error); return; }

    const r = await jobStore.start(
      built.payload as unknown as Record<string, unknown>,
      { active: built.payload.sources, origin: "search" },
    );
    if (!r.ok) setError(r.error ?? "Could not start the search.");
  }

  function exportCsv(source: string) {
    if (!job.jobId) return;
    // A plain navigation, as the tool does it — the response carries the
    // Content-Disposition filename and the BOM, and fetch+Blob would only
    // risk losing both.
    window.location.href =
      `/api/tools/agent-search/search/${encodeURIComponent(job.jobId)}/export?source=${source}`;
  }

  return (
    <div className="as">
      <AgentSearchHeader
        title="Agent Search"
        sub="Courted · Zillow · Realtor.com — unified agent intelligence"
        status={status}
      />

      <Card title="Search">
        <Field label="Locations or ZIP codes">
          <textarea
            className="as-ta" rows={3} value={locations}
            onChange={(e) => setLocations(e.target.value)}
            placeholder={"One location per line\ne.g. Miami, FL\nBoca Raton, FL\n33139"}
            aria-label="Locations or ZIP codes"
          />
        </Field>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 16 }}>
          {SOURCES.map((s) => (
            <button
              key={s} type="button"
              className={`as-tog${on[s] ? " on" : ""}`}
              aria-pressed={on[s]}
              onClick={() => setOn((p) => ({ ...p, [s]: !p[s] }))}
            >
              <i style={{ background: TONE_DOT[s] }} />
              {SOURCE_LABEL[s]}
              {s === "courted" ? <span style={{ color: "var(--muted)", fontWeight: 400 }}>free</span> : null}
            </button>
          ))}
          <span style={{ marginLeft: "auto" }}>
            <Check checked={showAll} onChange={setShowAll} label="Show all columns" />
          </span>
        </div>

        <div style={{ marginTop: 16 }}>
          <button
            type="button" className="as-btn ghost"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((v) => !v)}
          >
            {optionsOpen ? "▾" : "▸"} Options
          </button>
        </div>

        {optionsOpen ? (
          <div style={{
            display: "grid", gap: 16, marginTop: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(258px, 1fr))",
          }}>
            <OptGroup label="Courted" dot={TONE_DOT.courted}>
              <Field label="Max results" hint="(0 = all)">
                <input className="as-i tnum" type="number" min={0} value={courtedMax}
                  onChange={(e) => setCourtedMax(e.target.value)} />
              </Field>
              <Field label="Min LTM sales volume ($)">
                <input className="as-i tnum" type="number" min={0} value={minSalesVolume}
                  onChange={(e) => setMinSalesVolume(e.target.value)} />
              </Field>
              <Check checked={courtedEnrich} onChange={setCourtedEnrich}
                label="Enrich" hint="(mobile, office address…)" />
              <Check checked={courtedAllAgents} onChange={setCourtedAllAgents}
                label="All agents" hint="(full MLS sweep — ignores locations)" />
            </OptGroup>

            <OptGroup label="Zillow" dot={TONE_DOT.zillow}>
              <Field label="Max pages / location" hint="(max 25)">
                <input className="as-i tnum" type="number" min={1} max={25} value={zillowMaxPages}
                  onChange={(e) => setZillowMaxPages(e.target.value)} />
              </Field>
              <Field label="Concurrency" hint="(4 safe · higher = faster/riskier)">
                <input className="as-i tnum" type="number" min={1} max={12} value={zillowConcurrency}
                  onChange={(e) => setZillowConcurrency(e.target.value)} />
              </Field>
              <Check checked={zillowEnrich} onChange={setZillowEnrich}
                label="Enrich" hint="(profile pages — phone, email, license)" />
            </OptGroup>

            <OptGroup label="Realtor.com" dot={TONE_DOT.realtor}>
              <Field label="Max results" hint="(0 = all · costs credits)">
                <input className="as-i tnum" type="number" min={0} value={realtorMax}
                  onChange={(e) => setRealtorMax(e.target.value)} />
              </Field>
              <Field label="Enrich concurrency">
                <input className="as-i tnum" type="number" min={1} max={8} value={realtorConcurrency}
                  onChange={(e) => setRealtorConcurrency(e.target.value)} />
              </Field>
              <Check checked={realtorEnrich} onChange={setRealtorEnrich}
                label="Enrich" hint="(phone, license, areas — 1 credit-call/agent)" />
            </OptGroup>
          </div>
        ) : null}

        <Actions>
          {/* One button, two jobs — exactly as the tool does it. */}
          <button
            className="as-btn"
            onClick={() => (job.running ? jobStore.stop() : void start())}
            style={job.running ? { background: "var(--red)", boxShadow: "none" } : undefined}
          >
            {job.running ? "■ Stop" : "Search"}
          </button>
          {job.sweepEmail && job.running ? (
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Sweeping {job.sweepEmail} — started from Courted accounts.
            </span>
          ) : null}
        </Actions>
        <Msg text={error || job.error || ""} tone="error" />
      </Card>

      {SOURCES.map((s) => (
        <ResultPanel
          key={s} source={s} state={job.sources[s]}
          columns={displayColumns(columns, s, showAll)}
          onExport={job.jobId ? () => exportCsv(s) : undefined}
        />
      ))}
    </div>
  );
}

function OptGroup(
  { label, dot, children }: { label: string; dot: string; children: React.ReactNode },
) {
  return (
    <div style={{
      border: "1px solid var(--line)", borderRadius: 12, padding: 16,
      display: "grid", gap: 12, alignContent: "start", background: "var(--inset)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
        <i style={{ width: 9, height: 9, borderRadius: "50%", background: dot, display: "block" }} />
        {label}
      </div>
      {children}
    </div>
  );
}
