"use client";

import { useState } from "react";

import { fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import { SCHEDULE_URL, describeSync, runSync, useAnalyticsData } from "./actions";
import { SERIES_COLOR } from "./palette";
import { Bar, Box, LoadError } from "./shared";
import { StalenessStrip } from "./staleness-strip";
import { Btn, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — Schedule.
 *
 * The tool's `/schedule`: what goes out next. A different question from "how
 * did it do", which is why the tool keeps it as its own screen rather than a
 * tab, and why it has no filter bar — a forecast has no date range, it has
 * three days.
 *
 * All three days are fetched at once rather than behind a picker: the point is
 * the comparison, and three totals side by side ARE the picker.
 *
 * ONE HONEST GAP, reported rather than hidden: the schedule reads EmailBison's
 * sending schedules and joins the `campaigns` table. Instantly's ~318 campaigns
 * do not appear in it at all, and the tool says nothing about that. The caption
 * below does.
 */

interface ScheduleRow { campaignId: number; name: string; status: string; emails: number }
interface ScheduleGroup { clientId: string | null; name: string; rows: ScheduleRow[]; total: number }
interface ScheduleResponse {
  day: string;
  error: string | null;
  groups: ScheduleGroup[];
  total: number;
  campaignCount: number;
}

const DAYS = [
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "day_after_tomorrow", label: "Day after" },
] as const;

export function AnalyticsScheduleScreen() {
  const [day, setDay] = useState<string>("today");
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);

  const today = useAnalyticsData<ScheduleResponse>(SCHEDULE_URL("today"));
  const tomorrow = useAnalyticsData<ScheduleResponse>(SCHEDULE_URL("tomorrow"));
  const after = useAnalyticsData<ScheduleResponse>(SCHEDULE_URL("day_after_tomorrow"));

  const byDay: Record<string, ReturnType<typeof useAnalyticsData<ScheduleResponse>>> = {
    today,
    tomorrow,
    day_after_tomorrow: after,
  };
  const active = byDay[day];

  if (today.error) return <LoadError what="The schedule" error={today.error} />;

  return (
    <div className="an-screen">
    <StalenessStrip />
    <div className="wrap">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>Schedule</div>
          <div className="tbl-sub">
            {active.data
              ? `${fullNumber(active.data.total)} emails · ${active.data.campaignCount} campaigns · ${active.data.groups.length} clients`
              : "Loading…"}
          </div>
        </div>
        <Btn
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const outcome = await runSync("sync-entities");
              await Promise.all([today.reload(), tomorrow.reload(), after.reload()]);
              show(describeSync("Schedule", outcome));
            } catch (e) {
              show({ text: e instanceof Error ? e.message : "Sync failed", bad: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Sync schedule
        </Btn>
      </div>

      {/*
        Three day cards, all loaded, all showing their own total. The comparison
        IS the picker — a dropdown would hide the very thing you came to see.
      */}
      <div className="cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {DAYS.map((d) => {
          const state = byDay[d.id];
          const on = day === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className="card"
              aria-pressed={on}
              onClick={() => setDay(d.id)}
              style={{
                textAlign: "left", cursor: "pointer",
                borderColor: on ? "var(--blue)" : undefined,
                boxShadow: on ? "var(--sh-raise)" : undefined,
              }}
            >
              <div className="card-l">{d.label}</div>
              <div className="card-n tnum">{state.data ? fullNumber(state.data.total) : "…"}</div>
              <div className="card-s">
                {state.data
                  ? `${state.data.campaignCount} campaign${state.data.campaignCount === 1 ? "" : "s"}`
                  : "loading"}
              </div>
            </button>
          );
        })}
      </div>

      {active.data?.error ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>The forecast is incomplete.</b> {active.data.error}
        </div>
      ) : null}

      <div
        className="grid2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", opacity: active.loading ? 0.6 : 1, transition: "opacity .14s" }}
      >
        {(active.data?.groups ?? []).length === 0 ? (
          <div className="mut">
            {active.data ? "Nothing is scheduled to send." : "Loading…"}
          </div>
        ) : null}
        {(active.data?.groups ?? []).map((g) => (
          <div key={g.clientId ?? "unassigned"} className="abox" style={{ padding: 0 }}>
            <div className="abox-h">
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: 15 }}>{g.name}</h2>
                <div className="note">
                  {fullNumber(g.total)} emails ·{" "}
                  {percent(active.data && active.data.total > 0 ? g.total / active.data.total : null, 0)} of the day
                </div>
              </div>
            </div>
            <div style={{ padding: "10px 18px 4px" }}>
              <Bar
                fraction={active.data && active.data.total > 0 ? g.total / active.data.total : 0}
                color={SERIES_COLOR.sent}
              />
            </div>
            <div style={{ padding: "8px 18px 16px" }}>
              {g.rows.map((r) => (
                <div
                  key={r.campaignId}
                  style={{ display: "flex", gap: 10, alignItems: "center", padding: "5px 0", fontSize: 12.5 }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </span>
                  {/* The status chip appears only when it is NOT active — a
                      row of identical "active" chips carries no information. */}
                  {r.status !== "active" ? <span className="badge s-ok">{r.status}</span> : null}
                  <span className="tnum mut">{fullNumber(r.emails)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
        EmailBison only. The forecast is built from EmailBison&rsquo;s sending schedules joined to
        its campaigns; Instantly publishes no equivalent, so its campaigns are absent from these
        totals rather than counted as zero.
      </div>
      <Toast toast={toast} />
    </div>
    </div>
  );
}
