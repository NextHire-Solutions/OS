"use client";

import { useState } from "react";

import { DASH, compactNumber, percent } from "@/lib/tools/analytics/format.ts";
import { VOLUME_URL, useAnalyticsData } from "./actions";
import { AnalyticsFilters, FilterBar, todayInET, useAnalyticsFilters } from "./filters";
import { SERIES_COLOR } from "./palette";
import { AnalyticsTabs, Bar, Box, LoadError, Seg } from "./shared";

/*
 * Campaign Analytics — Email volume.
 *
 * The tool's `/analytics/volume`: how much the estate can send, and where what
 * it sent went. Second tab in the tool's own strip, between Campaign and
 * Infrastructure, and it shares the filter bar — minus the campaign picker,
 * which the tool hides here because the capacity RPC takes no campaign at all
 * ("selecting a campaign left the total at 251,963 and every bar unchanged").
 *
 * TWO SHAPES, BECAUSE THEY ARE TWO QUESTIONS. Capacity is one number and a
 * ratio, so it is a stat tile. The split is magnitude across ~40 named clients,
 * so it is a ranked bar and not a pie: forty slices cannot be compared by
 * angle. One measure, one hue — this is Sent, so every bar wears the Sent
 * series colour; colour by rank would move as the date range moves.
 *
 * Capacity is deliberately NOT date-filtered ("how much can we send a day" is
 * a property of the estate right now); the split is. The tile's own note says
 * which is which.
 */

interface VolumeResponse {
  capacity: Array<{ platform: string; inboxes: number; daily_capacity: number; unavailable: number }>;
  rows: Array<{ label: string; platform: string; sent: number; grand_total: number }>;
  total: number;
  days: number;
  group: "client" | "campaign";
  /** Which platforms these figures describe — set by the filter bar. */
  platforms: string[];
  range: { from: string; to: string };
}

const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

/** "both platforms" / "EmailBison only" — never a bare total with no scope. */
function scopeLabel(platforms: string[] | undefined): string {
  const list = platforms ?? [];
  if (list.length !== 1) return "both platforms";
  return `${PLATFORM_LABEL[list[0]] ?? list[0]} only`;
}

export function AnalyticsVolumeScreen() {
  // Resolved once per mount, never per render — see campaign.tsx.
  const [today] = useState(todayInET);
  return (
    <AnalyticsFilters today={today}>
      <VolumeBody />
    </AnalyticsFilters>
  );
}

function VolumeBody() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();

  return (
    <div className="an-screen">
      <AnalyticsTabs active="volume" />
      <FilterBar tab="volume" />
      <div className="wrap">
        <div style={{ marginBottom: 18 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>Email volume</div>
          <div className="tbl-sub">How much the estate can send, and where what it sent went.</div>
        </div>
        <VolumeView qs={qs} />
      </div>
    </div>
  );
}

export function VolumeView({ qs }: { qs: string }) {
  const [group, setGroup] = useState<"client" | "campaign">("client");
  const { data, error, loading } = useAnalyticsData<VolumeResponse>(
    VOLUME_URL(`${qs}&group=${group}`),
  );

  if (error) return <LoadError what="Volume" error={error} />;

  const capacity = data?.capacity ?? [];
  const dailyTotal = capacity.reduce((t, c) => t + Number(c.daily_capacity), 0);
  const inboxes = capacity.reduce((t, c) => t + Number(c.inboxes), 0);
  const unavailable = capacity.reduce((t, c) => t + Number(c.unavailable), 0);
  // Per day, because capacity is a daily figure. Comparing a 30-day total
  // against a daily ceiling would read as 750% utilisation.
  const perDay = data && data.days > 0 ? data.total / data.days : 0;
  const using = dailyTotal > 0 ? perDay / dailyTotal : null;
  const max = Math.max(1, ...(data?.rows ?? []).map((r) => Number(r.sent)));

  return (
    <>
      <Box title="Sending capacity" note="Lifetime inbox limits — not filtered by the date range.">
        <div style={{ padding: 22, display: "grid", gap: 20, gridTemplateColumns: "minmax(240px, 1fr) 2fr" }}>
          <div>
            <div className="card-l">Daily sending capacity</div>
            <div className="card-n tnum">{compactNumber(dailyTotal)}</div>
            <div className="card-s">across {inboxes.toLocaleString("en-US")} inboxes</div>
            {unavailable > 0 ? (
              <div style={{ marginTop: 8, color: "var(--red)", fontSize: 12.5 }}>
                {unavailable.toLocaleString("en-US")}/day in inboxes that cannot connect
              </div>
            ) : null}
          </div>
          <div>
            <div className="card-l">
              Using {using == null ? DASH : percent(using, 0)}
            </div>
            <div className="card-s" style={{ marginBottom: 8 }}>
              {Math.round(perDay).toLocaleString("en-US")} sent a day over {data?.days ?? 0} days
            </div>
            {/* The meter is the ratio the two numbers above already state; it
                exists so the gap is visible at a glance, not to add a fact. */}
            <div className="track" aria-hidden>
              <i style={{ width: `${Math.min(100, (using ?? 0) * 100)}%`, background: SERIES_COLOR.sent }} />
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {capacity.map((c) => (
                <div key={c.platform} style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  <b>{PLATFORM_LABEL[c.platform] ?? c.platform}</b>{" "}
                  <span className="tnum">{Number(c.daily_capacity).toLocaleString("en-US")}/day</span>{" "}
                  <span className="mut">· {Number(c.inboxes).toLocaleString("en-US")} inboxes</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Box>

      <Box
        title="Where the volume went"
        /*
          The scope is NAMED rather than assumed. The tool's first version said
          "both platforms" unconditionally, which was true only until the
          platform filter could reach this tab — a filtered total labelled as
          covering both is a wrong number wearing a confident caption.
        */
        note={
          data
            ? `${data.total.toLocaleString("en-US")} sent in range · ${scopeLabel(data.platforms)}`
            : undefined
        }
        right={
          <Seg
            label="Group volume by"
            value={group}
            options={[
              { value: "client", label: "By client" },
              { value: "campaign", label: "By campaign" },
            ]}
            onChange={setGroup}
          />
        }
        style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
      >
        <div style={{ padding: "14px 22px 6px", display: "flex", flexDirection: "column", gap: 11 }}>
          {(data?.rows ?? []).length === 0 ? (
            <div className="mut" style={{ padding: "20px 0" }}>
              {data ? "Nothing sent in this range." : "Loading…"}
            </div>
          ) : (
            (data?.rows ?? []).map((r) => (
              <div key={`${r.platform}-${r.label}`}>
                <div style={{ display: "flex", gap: 10, fontSize: 13, marginBottom: 4 }}>
                  <span
                    title={r.label}
                    style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {r.label}
                    {/* Named, not colour-coded: a second hue would encode
                        platform while the bar encodes volume. */}
                    {r.platform === "instantly" ? (
                      <span className="c c-inst" style={{ marginLeft: 7 }}>Instantly</span>
                    ) : null}
                  </span>
                  <span className="tnum">{Number(r.sent).toLocaleString("en-US")}</span>
                  <span className="tnum mut" style={{ width: 52, textAlign: "right" }}>
                    {percent(r.grand_total > 0 ? Number(r.sent) / Number(r.grand_total) : null, 1)}
                  </span>
                </div>
                <Bar fraction={Number(r.sent) / max} color={SERIES_COLOR.sent} />
              </div>
            ))
          )}
        </div>
        <div style={{ padding: "12px 22px 20px", fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
          <b style={{ color: "var(--ink-2)", fontWeight: 600 }}>Top 25.</b> Shares are of all volume
          in range, not just the rows shown, so they will not sum to 100%.
        </div>
      </Box>
    </>
  );
}
