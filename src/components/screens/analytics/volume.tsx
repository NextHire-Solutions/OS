"use client";

import { useState } from "react";

import { DASH, compactNumber, percent } from "@/lib/tools/analytics/format.ts";
import { gapLabel, neededShare, type CapacityPicture } from "@/lib/tools/analytics/sending-capacity.ts";
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
  /** Capacity with idle platforms set aside, and what the active campaigns need. Null if it could not be read. */
  picture?: CapacityPicture | null;
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
  const picture = data?.picture ?? null;
  /*
   * The picture's totals where there is one: it leaves out a platform with no
   * active campaign (13 Oct — 536 idle Instantly inboxes were a quarter of the
   * headline). The plain sum is the fallback for an answer without it.
   */
  const dailyTotal = picture ? picture.daily : capacity.reduce((t, c) => t + Number(c.daily_capacity), 0);
  const inboxes = picture ? picture.inboxes : capacity.reduce((t, c) => t + Number(c.inboxes), 0);
  const unavailable = picture ? picture.unavailable : capacity.reduce((t, c) => t + Number(c.unavailable), 0);
  // Per day, because capacity is a daily figure. Comparing a 30-day total
  // against a daily ceiling would read as 750% utilisation.
  const perDay = data && data.days > 0 ? data.total / data.days : 0;
  const using = dailyTotal > 0 ? perDay / dailyTotal : null;
  const max = Math.max(1, ...(data?.rows ?? []).map((r) => Number(r.sent)));
  const share = picture ? neededShare(picture) : null;
  const short = picture ? picture.gap < 0 : false;

  return (
    <>
      <Box title="Sending capacity" note="Inbox limits as they are now — not filtered by the date range.">
        <div
          data-capacity
          style={{ padding: 22, display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}
        >
          <div data-capacity-tile="capacity">
            <div className="card-l">Daily sending capacity</div>
            <div className="card-n tnum">{compactNumber(dailyTotal)}</div>
            <div className="card-s">
              {Math.round(dailyTotal).toLocaleString("en-US")} a day across {inboxes.toLocaleString("en-US")} connected inboxes
            </div>
            {unavailable > 0 ? (
              <div style={{ marginTop: 8, color: "var(--red)", fontSize: 12.5 }}>
                {unavailable.toLocaleString("en-US")}/day in inboxes that cannot connect
              </div>
            ) : null}
          </div>

          {/* Capacity NEEDED (13 Oct): the active campaigns' daily send limits, added up. */}
          {picture ? (
            <div data-capacity-tile="needed">
              <div className="card-l">Needed by active campaigns</div>
              <div className="card-n tnum">{compactNumber(picture.needed)}</div>
              <div className="card-s">
                {Math.round(picture.needed).toLocaleString("en-US")} a day · the daily send limits of{" "}
                {picture.activeCampaigns.toLocaleString("en-US")} active campaign{picture.activeCampaigns === 1 ? "" : "s"}
              </div>
              <div
                data-capacity-gap={short ? "short" : "ok"}
                style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: short ? "var(--red)" : "var(--green)" }}
              >
                {gapLabel(picture)}
              </div>
              <div className="track" aria-hidden style={{ marginTop: 8 }}>
                <i style={{ width: `${Math.min(100, (share ?? 0) * 100)}%`, background: short ? "var(--red)" : SERIES_COLOR.sent }} />
              </div>
              <div className="card-s" style={{ marginTop: 8 }}>
                {share == null ? "No connected capacity to compare with." : `${percent(share, 0)} of capacity`}
                {picture.newLeads > 0 ? ` · ${Math.round(picture.newLeads).toLocaleString("en-US")} new leads a day` : ""}
                {picture.withoutLimit > 0
                  ? ` · ${picture.withoutLimit} active campaign${picture.withoutLimit === 1 ? " has" : "s have"} no daily limit on record`
                  : ""}
              </div>
            </div>
          ) : null}

          <div data-capacity-tile="using">
            <div className="card-l">Actually sending</div>
            <div className="card-n tnum">{using == null ? DASH : percent(using, 0)}</div>
            <div className="card-s" style={{ marginBottom: 8 }}>
              {Math.round(perDay).toLocaleString("en-US")} sent a day over {data?.days ?? 0} day{data?.days === 1 ? "" : "s"}, weekends included
            </div>
            {/* The meter is the ratio the two numbers above already state; it
                exists so the gap is visible at a glance, not to add a fact. */}
            <div className="track" aria-hidden>
              <i style={{ width: `${Math.min(100, (using ?? 0) * 100)}%`, background: SERIES_COLOR.sent }} />
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {(picture
                ? picture.platforms.map((p) => ({ platform: p.platform, daily: p.daily, inboxes: p.inboxes, counted: p.counted }))
                : capacity.map((c) => ({ platform: c.platform, daily: Number(c.daily_capacity), inboxes: Number(c.inboxes), counted: true }))
              ).map((c) => (
                <div key={c.platform} data-capacity-platform={c.platform} data-counted={c.counted ? "yes" : "no"} style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  <b>{PLATFORM_LABEL[c.platform] ?? c.platform}</b>{" "}
                  <span className="tnum">{c.daily.toLocaleString("en-US")}/day</span>{" "}
                  <span className="mut">· {c.inboxes.toLocaleString("en-US")} inboxes</span>
                  {c.counted ? null : (
                    <span className="mut"> · not counted: no active campaign on {PLATFORM_LABEL[c.platform] ?? c.platform}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* "How is this calculated?" — answered where the number is. */}
        <div data-capacity-how style={{ padding: "0 22px 20px", fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
          <b style={{ color: "var(--ink-2)", fontWeight: 600 }}>How this is worked out.</b>{" "}
          Capacity is the daily limit of every inbox that can send, added up — EmailBison inboxes that are Connected, and
          Instantly accounts that are not archived. Inboxes that cannot connect are listed separately and never added in.
          A platform with no active campaign is left out of the total. Needed is the daily send limit of every active
          campaign, added up. Actually sending is the emails sent in the date range, divided by its days.
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
        <div style={{ padding: "14px 22px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
          {(data?.rows ?? []).length === 0 ? (
            <div className="mut" style={{ padding: "20px 0" }}>
              {data ? "Nothing sent in this range." : "Loading…"}
            </div>
          ) : (
            (data?.rows ?? []).map((r) => (
              /* One line per client (9 Oct): name, bar, count, share — the standalone tool's layout. */
              <div
                key={`${r.platform}-${r.label}`}
                style={{ display: "grid", gridTemplateColumns: "minmax(120px, 230px) minmax(0, 1fr) 72px 52px", alignItems: "center", gap: 14, fontSize: 13 }}
              >
                  <span
                    title={r.label}
                    style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {r.label}
                    {/* Named, not colour-coded: a second hue would encode
                        platform while the bar encodes volume. */}
                    {r.platform === "instantly" ? (
                      <span className="c c-inst" style={{ marginLeft: 7 }}>Instantly</span>
                    ) : null}
                  </span>
                  <Bar fraction={Number(r.sent) / max} color={SERIES_COLOR.sent} />
                  <span className="tnum" style={{ textAlign: "right" }}>{Number(r.sent).toLocaleString("en-US")}</span>
                  <span className="tnum mut" style={{ textAlign: "right" }}>
                    {percent(r.grand_total > 0 ? Number(r.sent) / Number(r.grand_total) : null, 1)}
                  </span>
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
