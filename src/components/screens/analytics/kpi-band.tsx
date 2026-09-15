"use client";

import {
  compactNumber,
  delta,
  duration,
  percent,
  ratio,
  type Delta,
} from "@/lib/tools/analytics/format.ts";

/*
 * The KPI band — twelve cells in two rows of six, in the design's own `.kpi`.
 *
 * Deliberately NOT the `.cards` grid every other workspace screen uses. Twelve
 * cards would be a wall; the design has a recessed hairline-divided band for
 * exactly this, and `.kpi` in workspace.css is already `repeat(6, 1fr)` with a
 * `:nth-child(n+7)` top border for the second row. It was written for this
 * screen and has never been used.
 *
 * The mapping below — which tiles, in which order, with which note — is the
 * tool's `use-kpis.ts`, kept line for line. Formatting happens HERE, through
 * the tool's own `format.ts`, so the band and the tables share one set of rules
 * and `DASH` stays the only way a nullish metric reaches the DOM.
 */

export interface KpiValues {
  sent: number;
  prospects: number | null;
  replies: number;
  humanReplies: number;
  /* Nullable: Instantly can supply neither, and a 0 would read as "none". */
  positive: number | null;
  bounces: number | null;
  medianReplyTime: number | null;
  medianFollowUpTime: number | null;
  replyRate: number | null;
  humanRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
}

export interface KpiResponse {
  current: KpiValues;
  previous?: KpiValues;
  deltas?: Partial<Record<keyof KpiValues, number | null>>;
  compareLabel?: { from: string; to: string };
  coverage: {
    followUpBusinessHours: string | null;
    followUpSampleSize: number | null;
    replyTimingSampleSize: number;
    platforms?: string[];
    positiveCoversInstantly?: boolean;
    instantlyExcludedBy?: "campaign-filter" | null;
  };
  range?: { from: string; to: string };
}

const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

function scopeNote(platforms: string[] | undefined): string | undefined {
  // One platform is the case worth calling out. Both, or unknown, is the whole
  // estate and needs no caveat.
  if (!platforms || platforms.length !== 1) return undefined;
  return `${PLATFORM_LABEL[platforms[0]] ?? platforms[0]} only`;
}

/**
 * Whether a rise is good news. Bounces going up is not a green number, and that
 * judgement belongs to the metric, not to the formatter.
 */
const UP_IS_GOOD: Record<string, boolean> = {
  sent: true,
  prospects: true,
  replies: true,
  humanReplies: true,
  positive: true,
  bounces: false,
  medianReplyTime: false, // faster is better
  medianFollowUpTime: false,
  replyRate: true,
  humanRate: true,
  positiveRate: true,
  leadToEmail: false, // fewer emails per positive is better
};

interface Cell {
  key: string;
  label: string;
  value: string;
  delta: Delta | null;
  note?: string;
  upIsGood: boolean;
}

export function kpiCells(data: KpiResponse | null): { cells: Cell[]; scope?: string } {
  if (!data) return { cells: [] };
  const c = data.current;
  const deltaFor = (key: keyof KpiValues): Delta | null =>
    data.deltas ? delta(data.deltas[key] ?? null) : null;

  const cell = (key: keyof KpiValues, label: string, value: string, note?: string): Cell => ({
    key,
    label,
    value,
    delta: deltaFor(key),
    note,
    upIsGood: UP_IS_GOOD[key] ?? true,
  });

  /*
   * When a campaign filter has taken Instantly out of scope, SAY THAT instead
   * of the bare platform name. "EmailBison only" beside a ticked Instantly chip
   * invites the reader to conclude the filter is broken.
   */
  const scope =
    data.coverage.instantlyExcludedBy === "campaign-filter"
      ? "EmailBison only — the campaign filter selects EmailBison campaigns, so Instantly is not included"
      : scopeNote(data.coverage.platforms);

  /*
   * Why Positive is a dash, said on the tile rather than left to be discovered.
   * MasterInbox labels decide Positive and key on EmailBison reply ids, so with
   * Instantly in scope the honest answer is "not available". An unexplained
   * dash beside eleven populated tiles reads as a broken metric.
   */
  const positiveNote =
    data.coverage.positiveCoversInstantly === false ? "EmailBison only" : scope;

  return {
    scope,
    cells: [
      cell("sent", "Sent", compactNumber(c.sent)),
      cell("prospects", "Prospects", compactNumber(c.prospects)),
      cell("replies", "Replies", compactNumber(c.replies)),
      cell("humanReplies", "Human Replies", compactNumber(c.humanReplies)),
      cell("positive", "Positive", compactNumber(c.positive), positiveNote),
      cell("bounces", "Bounces", compactNumber(c.bounces)),
      cell(
        "medianReplyTime",
        "Median Reply Time",
        duration(c.medianReplyTime),
        data.coverage.replyTimingSampleSize
          ? `n=${data.coverage.replyTimingSampleSize.toLocaleString("en-US")}`
          : "no timing data yet",
      ),
      cell(
        "medianFollowUpTime",
        "Median Follow-up Time",
        duration(c.medianFollowUpTime),
        // Surfaced because this metric is business-hours adjusted while Median
        // Reply Time is raw elapsed time. Side by side they would otherwise
        // read as the same kind of measure.
        data.coverage.followUpBusinessHours ? "business hours" : undefined,
      ),
      cell("replyRate", "Reply Rate", percent(c.replyRate)),
      cell("humanRate", "Human Rate", percent(c.humanRate)),
      cell("positiveRate", "Positive Rate", percent(c.positiveRate), positiveNote),
      cell("leadToEmail", "Lead to Email", ratio(c.leadToEmail), positiveNote),
    ],
  };
}

export function KpiBand({ data, loading }: { data: KpiResponse | null; loading: boolean }) {
  const { cells, scope } = kpiCells(data);

  if (!cells.length) {
    return (
      <div className="kpi" aria-busy={loading}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i}>
            <div className="k">&nbsp;</div>
            <div className="v">
              <span
                style={{
                  display: "block", width: 62, height: 22, borderRadius: 6,
                  background: "var(--inset-2)",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div
        className="kpi"
        /*
         * Dimmed rather than replaced while a filter change is in flight. The
         * tool's `placeholderData: keepPreviousData` for the same reason: a band
         * that blanks for 400ms on every chip click makes the page feel broken
         * and shoves everything below it up and down.
         */
        style={loading ? { opacity: 0.55, transition: "opacity .14s" } : undefined}
        aria-busy={loading}
      >
        {cells.map((c) => (
          <div key={c.key}>
            <div className="k" title={c.label}>{c.label}</div>
            <div className="v tnum">
              {c.value}
              {c.delta ? (
                <span
                  className={`d ${
                    c.delta.tone === "flat" ? "fl" : (c.delta.tone === "up") === c.upIsGood ? "up" : "dn"
                  }`}
                >
                  {c.delta.label}
                </span>
              ) : null}
            </div>
            {c.note ? <div className="n">{c.note}</div> : null}
          </div>
        ))}
      </div>
      {/*
        The band-wide scope is said ONCE, not stamped onto twelve tiles.
        "EmailBison only" repeated a dozen times is noise that trains the eye to
        skip exactly the caveat it is there to deliver.
      */}
      {scope ? (
        <div style={{ margin: "10px 26px 0", fontSize: 12.5, color: "var(--muted)" }}>
          {scope}
        </div>
      ) : null}
    </>
  );
}
