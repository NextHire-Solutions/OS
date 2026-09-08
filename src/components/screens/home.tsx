"use client";

import type { ToolSnapshot } from "@/lib/connectors/types";
import { ToolGlyph } from "@/components/shell/tool-glyph";
import { toGrantId } from "@/lib/workspace/tool-ids";
import { greeting } from "@/lib/workspace/greeting";
import { OverviewCard } from "./overview-card";
import { Lazy } from "./lazy";
import type { Overview } from "@/lib/workspace/overview";

/*
 * The workspace home, following the design's markup and class names.
 *
 * Every number is real — the tool cards read the same status store the API
 * serves. Where the design shows a figure we cannot source yet, the card says
 * so rather than carrying the mockup's placeholder into production: a made-up
 * number that looks live is the one thing a status screen must never do.
 */

/* Keyed by GRANT id — snapshots carry connector ids, so they are mapped first. */
const TINTS: Record<string, { bg: string; fg: string }> = {
  inbox: { bg: "#E8F0FF", fg: "#0165FE" },
  clients: { bg: "#DFF6EA", fg: "#0E8A5F" },
  analytics: { bg: "#EFEBFF", fg: "#5B3FD4" },
  search: { bg: "#FFF2E2", fg: "#B45309" },
  onboarding: { bg: "#DFF6EA", fg: "#0E8A5F" },
};


export function HomeScreen({
  snapshots,
  summary,
  overview,
  firstName,
  now,
}: {
  snapshots: ToolSnapshot[];
  summary: { headline: string; breakdown: string };
  /** Null until loaded — only the home screen needs it, and it costs five calls. */
  overview: Overview | null;
  firstName: string;
  now: Date;
}) {
  return (
    <>
      <div className="hero">
        <h1>
          {greeting(now)}, {firstName}
        </h1>
        <p>
          {summary.headline} · {summary.breakdown}
        </p>
      </div>

      <div className="wrap">
        {/* The one expensive part of this screen: five upstream calls. It is
            loaded here rather than on every route in the workspace. */}
        <Lazy<Overview>
          initial={overview}
          url="/api/workspace/home"
          label="The overview"
          skeleton={<OverviewSkeleton />}
        >
          {(o) => <OverviewCard overview={o} />}
        </Lazy>

        <div className="tools">
          {snapshots.map((tool) => {
            // Snapshots are keyed by connector id; glyphs and tints by grant
            // id. Mapping here is what stopped three of four icons rendering
            // as empty tiles.
            const glyphId = toGrantId(tool.id);
            const tint = TINTS[glyphId] ?? { bg: "var(--inset)", fg: "var(--ink-2)" };
            return (
              <a
                key={tool.id}
                className="tool"
                href={tool.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="tool-h">
                  <span className="tool-i" style={{ background: tint.bg, color: tint.fg }}>
                    <ToolGlyph id={glyphId} />
                  </span>
                  <span>
                    <b>{tool.name}</b>
                    <small>{tool.description}</small>
                  </span>
                </div>

                <div className="tool-m">
                  {tool.metrics.length > 0 ? (
                    tool.metrics.slice(0, 2).map((m) => (
                      <div key={m.key}>
                        <b className="tnum">{formatMetric(m)}</b>
                        <span>{m.label}</span>
                      </div>
                    ))
                  ) : (
                    /*
                     * No numbers rather than invented ones. The design shows
                     * two per card; when a tool cannot answer, say why — this
                     * is exactly where a placeholder would quietly become a
                     * number someone trusts.
                     */
                    <div>
                      <b style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)" }}>
                        {stateLabel(tool)}
                      </b>
                      <span>{tool.notes[0]?.text ?? "No metrics available"}</span>
                    </div>
                  )}
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </>
  );
}

function stateLabel(tool: ToolSnapshot): string {
  switch (tool.state) {
    case "up":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Unreachable";
    case "unconfigured":
      return "Not configured";
    default:
      return "Unknown";
  }
}

function formatMetric(metric: ToolSnapshot["metrics"][number]): string {
  const { value, format } = metric;
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;

  switch (format) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "compact":
      return value >= 1000
        ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`
        : String(value);
    case "duration":
      return value >= 3600
        ? `${Math.round(value / 3600)}h`
        : `${Math.max(1, Math.round(value / 60))}m`;
    default:
      return value.toLocaleString("en-US");
  }
}

/* Shaped like the overview card so the page does not jump when it arrives. */
function OverviewSkeleton() {
  return (
    <div className="ov-card" aria-busy="true" style={{ minHeight: 188 }}>
      <div className="ov-top">
        <div className="ov-title">
          <span style={{ display: "block", width: 150, height: 15, borderRadius: 5, background: "var(--inset-2)" }} />
        </div>
      </div>
      <div className="ovkpis">
        {Array.from({ length: 4 }, (_, i) => (
          <div className="ovk" key={i}>
            <div className="ovk-l"><span style={{ display: "block", width: 62, height: 10, borderRadius: 5, background: "var(--inset-2)" }} /></div>
            <div className="ovk-n"><span style={{ display: "block", width: 52, height: 22, borderRadius: 5, background: "var(--inset-2)" }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
