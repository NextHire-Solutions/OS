"use client";

import { useEffect, useState } from "react";

/*
 * Where the tools disagree about clients.
 *
 * The point of this screen is to be BORING most of the time. It compares each
 * pair of client lists and, for each difference, says whether it is expected or
 * worth acting on — because the lists are meant to differ:
 *
 *   Master Inbox   every client ever created, including test entries
 *   Client Health  the billed roster, including paused and churned
 *   Analytics      only clients set up for campaign attribution
 *
 * A screen that flagged all of that as a problem would be ignored within a
 * week. So differences carry their explanation, and only the genuinely
 * actionable ones are styled to draw the eye.
 */

interface Roster {
  tool: string;
  label: string;
  definition: string;
  count: number;
  excluded: string[];
  unavailable: string | null;
}

interface Comparison {
  left: { tool: string; label: string; count: number };
  right: { tool: string; label: string; count: number };
  summary: { matched: number; likely: number; onlyLeft: number; onlyRight: number };
  likely: { left: string; right: string; score: number }[];
  onlyLeft: { name: string; [k: string]: unknown }[];
  onlyRight: { name: string; [k: string]: unknown }[];
}

interface StatusReading {
  source: string;
  label: string;
  status: string | null;
  unreadable?: boolean;
}

interface StatusConflict {
  name: string;
  master: string | null;
  readings: StatusReading[];
  disagreeing: string[];
  severity: "act" | "expected";
  why: string;
  crossesActive: boolean;
}

interface StatusReport {
  conflicts: StatusConflict[];
  agreed: number;
  unreadable: { source: string; label: string }[];
  error?: string;
}

interface CoverageCell {
  tool: string;
  label: string;
  verdict: "present" | "explained" | "expected" | "gap";
  reason?: string;
}

interface CoverageRow {
  clientId: string;
  name: string;
  status: string;
  cells: CoverageCell[];
  gaps: string[];
}

interface StatusCoverage {
  status: string;
  total: number;
  present: Record<string, number>;
}

interface CoverageReport {
  rows: CoverageRow[];
  byStatus?: StatusCoverage[];
  withGaps: number;
  gapsByTool: { tool: string; label: string; gaps: number }[];
  explained: number;
  expected: number;
  unreadable: string[];
  error?: string;
}

interface Payload {
  generatedAt?: string;
  rosters: Roster[];
  comparisons: Comparison[];
  /** Where the tools hold the same client at different statuses. */
  statuses?: StatusReport;
  /** Which tools hold each client, and whether an absence is intentional. */
  coverage?: CoverageReport;
  unavailable: { tool: string; label: string; reason: string }[];
}

export function DiscrepanciesScreen() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reconcile/clients")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load"));
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <Frame>
        <div className="card">
          <div className="card-l">Unavailable</div>
          <p style={{ fontSize: 14, color: "var(--muted)" }}>{error}</p>
        </div>
      </Frame>
    );
  }

  if (!data) {
    return (
      <Frame>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>Comparing client lists…</p>
      </Frame>
    );
  }

  const readable = data.rosters.filter((r) => !r.unavailable);

  return (
    <Frame>
      {/* What each list actually contains — the single most useful thing here.
          Most "discrepancies" dissolve once you read these three sentences. */}
      <div className="cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, data.rosters.length)}, 1fr)` }}>
        {data.rosters.map((r) => (
          <div className="card" key={r.tool}>
            <div className="card-l">{r.label}</div>
            <div
              className="card-n tnum"
              style={r.unavailable ? { color: "#B9C0CB" } : undefined}
            >
              {r.unavailable ? "—" : r.count}
            </div>
            <div className="card-s" style={{ lineHeight: 1.5 }}>
              {r.unavailable ?? r.definition}
            </div>
          </div>
        ))}
      </div>

      {readable.length < 2 ? (
        <div className="anno">
          <b>Not enough to compare.</b> At least two client lists must be readable.
        </div>
      ) : null}

      {/* §16 asks for a last-synchronised time. Every list here is read live
          when the page loads, so this IS that time — and saying so matters:
          without it a stale tab looks exactly like a fresh one, and someone
          acts on a comparison from an hour ago. */}
      {data.generatedAt ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14 }}>
          Every list read live at{" "}
          <b>
            {new Date(data.generatedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </b>
          . Reload to compare again.
        </p>
      ) : null}

      {/* Status disagreements come FIRST. A client the tools disagree about is
          actionable in a way a membership difference usually is not: it means
          somebody is still being served, still being billed, or has had their
          portal shut while we think they are live. */}
      <StatusConflicts report={data.statuses} />

      {/* Then coverage: which tools hold each client, and whether an absence
          was decided or merely happened. */}
      <Coverage report={data.coverage} />

      <div className="tbl-title" style={{ marginTop: 28 }}>
        Which clients each list contains
      </div>

      {data.comparisons.map((c) => {
        const key = `${c.left.tool}-${c.right.tool}`;
        const clean = c.summary.onlyLeft === 0 && c.summary.onlyRight === 0 && c.summary.likely === 0;

        return (
          <div className="tbl-wrap" key={key}>
            <div className="tbl-head">
              <div>
                <div className="tbl-title">
                  {c.left.label} vs {c.right.label}
                </div>
                <div className="tbl-sub">
                  {c.summary.matched} match exactly
                  {c.summary.likely > 0 ? ` · ${c.summary.likely} likely the same, spelled differently` : ""}
                  {c.summary.onlyLeft > 0 ? ` · ${c.summary.onlyLeft} only in ${c.left.label}` : ""}
                  {c.summary.onlyRight > 0 ? ` · ${c.summary.onlyRight} only in ${c.right.label}` : ""}
                </div>
              </div>
              <span className={`badge ${clean ? "s-done" : "s-ok"}`}>
                <span className="dot" />
                {clean ? "Agreed" : "Differs"}
              </span>
            </div>

            {clean ? null : (
              <div style={{ padding: "16px 22px 20px" }}>
                {c.likely.length > 0 ? (
                  <Section
                    title="Likely the same client, spelled differently"
                    hint="Worth aligning the names — the tools join clients by name, so a mismatch here silently splits one client into two."
                  >
                    {c.likely.map((l) => (
                      <div key={`${l.left}-${l.right}`} style={rowStyle}>
                        <span>{l.left}</span>
                        <span style={{ color: "var(--muted)" }}>≈</span>
                        <span>{l.right}</span>
                      </div>
                    ))}
                  </Section>
                ) : null}

                {c.onlyLeft.length > 0 ? (
                  <Section title={`Only in ${c.left.label}`}>
                    {c.onlyLeft.map((e) => (
                      <div key={e.name} style={rowStyle}>
                        <span>{e.name}</span>
                        <Meta entry={e} />
                      </div>
                    ))}
                  </Section>
                ) : null}

                {c.onlyRight.length > 0 ? (
                  <Section title={`Only in ${c.right.label}`}>
                    {c.onlyRight.map((e) => (
                      <div key={e.name} style={rowStyle}>
                        <span>{e.name}</span>
                        <Meta entry={e} />
                      </div>
                    ))}
                  </Section>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {/* Placeholder rows are removed before comparing, and named here.
          Filtering silently would look identical to a bug eating a client. */}
      {data.rosters.some((r) => r.excluded.length > 0) ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7 }}>
          Not counted, because they are buckets rather than clients:{" "}
          {data.rosters.flatMap((r) => r.excluded).join(", ")}.
        </p>
      ) : null}
    </Frame>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 0",
  fontSize: 13.5,
  color: "var(--ink-2)",
  borderTop: "1px solid var(--line-soft)",
};

function Meta({ entry }: { entry: { name: string; [k: string]: unknown } }) {
  const bits: string[] = [];
  if (typeof entry.plan === "string") bits.push(entry.plan);
  if (typeof entry.status === "string") bits.push(entry.status);
  if (typeof entry.intros === "number") bits.push(`${entry.intros} intros`);
  if (typeof entry.campaigns === "number") bits.push(`${entry.campaigns} campaigns`);
  if (bits.length === 0) return null;
  return (
    <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--muted)" }}>
      {bits.join(" · ")}
    </span>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
      {hint ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3, lineHeight: 1.55 }}>
          {hint}
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

/*
 * Status disagreements.
 *
 * Designed to be empty most days, and to say so plainly when it is — a panel
 * that renders nothing is indistinguishable from one that failed to load, and
 * "we checked and everything agrees" is itself the useful answer here.
 */
function StatusConflicts({ report }: { report?: StatusReport }) {
  if (!report) return null;

  if (report.error) {
    return (
      <div className="anno" style={{ marginTop: 18 }}>
        <b>Statuses could not be compared.</b> {report.error} — the list comparison below is
        unaffected.
      </div>
    );
  }

  const act = report.conflicts.filter((c) => c.severity === "act");
  const expected = report.conflicts.filter((c) => c.severity === "expected");

  return (
    <div style={{ marginTop: 22 }}>
      <div className="tbl-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <div className="tbl-title">Status disagreements</div>
          <div className="tbl-sub">
            {report.agreed} client{report.agreed === 1 ? "" : "s"} agree everywhere
            {act.length > 0 ? ` · ${act.length} need a decision` : ""}
            {expected.length > 0 ? ` · ${expected.length} expected` : ""}
          </div>
        </div>
        <span className={`badge ${act.length === 0 ? "s-done" : "s-ok"}`}>
          <span className="dot" />
          {act.length === 0 ? "Agreed" : "Differs"}
        </span>
      </div>

      {report.unreadable.length > 0 ? (
        <div className="anno">
          <b>Not every source answered.</b>{" "}
          {report.unreadable.map((u) => u.label).join(", ")} could not be read, so these
          results are partial. Nothing below counts a silent source as agreement.
        </div>
      ) : null}

      {act.length === 0 && expected.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
          Every client the master knows about has the same status in every tool that holds
          one.
        </div>
      ) : null}

      {act.map((c) => (
        <ConflictRow key={c.name} conflict={c} />
      ))}

      {expected.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 13, color: "var(--muted)", cursor: "pointer" }}>
            {expected.length} expected difference{expected.length === 1 ? "" : "s"} — clients
            still onboarding, which no tool has a word for
          </summary>
          <div style={{ marginTop: 8 }}>
            {expected.map((c) => (
              <ConflictRow key={c.name} conflict={c} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/*
 * Why the raw client counts differ — the question that keeps being asked.
 *
 * Comparing 54 against 46 says nothing, because the lists are not meant to
 * hold the same thing: a churned client is removed from Analytics
 * attribution, and the Onboarding tool only ever held clients that came
 * through intake. Comparing ACTIVE against ACTIVE is the comparison that
 * means something, and that row should read n/n right across.
 */
function StatusMatrix({
  byStatus,
  gapsByTool,
}: {
  byStatus?: StatusCoverage[];
  gapsByTool: { tool: string; label: string; gaps: number }[];
}) {
  if (!byStatus || byStatus.length === 0) return null;
  const tools = gapsByTool.map((g) => ({ tool: g.tool, label: g.label }));

  return (
    <div className="tbl-wrap" style={{ marginTop: 10 }}>
      <div className="tbl-head">
        <div>
          <div className="tbl-title">Clients per tool, by status</div>
          <div className="tbl-sub">
            Raw totals differ for good reasons. The row to read is <b>active</b> — it should be
            complete in every column.
          </div>
        </div>
      </div>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>In the master list</th>
              {tools.map((t) => <th key={t.tool}>{t.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {byStatus.map((s) => (
              <tr key={s.status}>
                <td style={{ textTransform: "capitalize", fontWeight: 600 }}>{s.status}</td>
                <td className="tnum">{s.total}</td>
                {tools.map((t) => {
                  const n = s.present[t.tool];
                  const unreadable = n === -1;
                  const complete = n === s.total;
                  return (
                    <td
                      key={t.tool}
                      className="tnum"
                      style={{
                        // Only the active row is meant to be complete, so only
                        // it is coloured. Colouring the rest would flag the
                        // churned row as a permanent problem.
                        color: unreadable
                          ? "var(--muted)"
                          : s.status === "active"
                            ? complete ? "var(--green)" : "var(--red)"
                            : undefined,
                        fontWeight: s.status === "active" ? 600 : undefined,
                      }}
                      title={unreadable ? "This tool could not be read" : undefined}
                    >
                      {unreadable ? "—" : `${n}/${s.total}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: StatusConflict }) {
  return (
    <div
      style={{
        border: "1px solid var(--line, #E6E8EC)",
        borderRadius: 8,
        padding: "10px 12px",
        marginTop: 8,
        // The only visual weight on the page goes to the case that costs money
        // or is visible to a customer.
        borderLeftWidth: conflict.crossesActive ? 3 : 1,
        borderLeftColor: conflict.crossesActive ? "#D9822B" : undefined,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{conflict.name}</div>
        {conflict.readings
          .filter((r) => r.status !== null && !r.unreadable)
          .map((r) => (
            <span
              key={r.source}
              style={{
                fontSize: 12,
                color: "var(--muted)",
                whiteSpace: "nowrap",
              }}
            >
              {r.label}:{" "}
              <b style={{ color: r.source === "os" ? "var(--ink)" : undefined }}>{r.status}</b>
            </span>
          ))}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 5, lineHeight: 1.55 }}>
        {conflict.why}
      </div>
    </div>
  );
}

/*
 * Tool coverage (§17).
 *
 * Only clients with an UNACCOUNTED-FOR absence are listed. Everything that a
 * written reason or a standing rule covers is counted in the summary line and
 * otherwise left out — a table of fifty clients by four tools is two hundred
 * cells nobody reads, and the ten that matter would be lost in it.
 */
function Coverage({ report }: { report?: CoverageReport }) {
  if (!report) return null;

  if (report.error) {
    return (
      <div className="anno" style={{ marginTop: 18 }}>
        <b>Tool coverage could not be checked.</b> {report.error}
      </div>
    );
  }

  const withGaps = report.rows.filter((r) => r.gaps.length > 0);

  return (
    <div style={{ marginTop: 26 }}>
      <div className="tbl-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <div className="tbl-title">Tool coverage</div>
          <div className="tbl-sub">
            {report.rows.length} client{report.rows.length === 1 ? "" : "s"} checked
            {report.explained > 0 ? ` · ${report.explained} absence${report.explained === 1 ? "" : "s"} explained` : ""}
            {report.expected > 0 ? ` · ${report.expected} expected` : ""}
            {withGaps.length > 0 ? ` · ${withGaps.length} unaccounted for` : ""}
          </div>
        </div>
        <span className={`badge ${withGaps.length === 0 ? "s-done" : "s-ok"}`}>
          <span className="dot" />
          {withGaps.length === 0 ? "Accounted for" : "Gaps"}
        </span>
      </div>

      {report.unreadable.length > 0 ? (
        <div className="anno">
          <b>Not every tool answered.</b> {report.unreadable.join(", ")} could not be read, so
          no client is reported as missing from them.
        </div>
      ) : null}

      <StatusMatrix byStatus={report.byStatus} gapsByTool={report.gapsByTool} />

      {withGaps.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
          Every client is either in each tool, or its absence has a reason.
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Missing from</th>
              </tr>
            </thead>
            <tbody>
              {withGaps.map((row) => (
                <tr key={row.clientId}>
                  <td>{row.name}</td>
                  <td style={{ color: "var(--muted)" }}>{row.status}</td>
                  <td>
                    {row.cells
                      .filter((c) => c.verdict === "gap")
                      .map((c) => c.label)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.gapsByTool.some((g) => g.gaps > 0) ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
          By tool:{" "}
          {report.gapsByTool
            .filter((g) => g.gaps > 0)
            .map((g) => `${g.label} ${g.gaps}`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="hero">
        <h1>Consistency</h1>
        <p>Where the tools disagree about clients, and whether it matters</p>
      </div>
      <div className="wrap">{children}</div>
    </>
  );
}
