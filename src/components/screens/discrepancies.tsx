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

interface Payload {
  rosters: Roster[];
  comparisons: Comparison[];
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
