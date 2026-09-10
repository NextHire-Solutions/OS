"use client";

import {
  campaignDetail,
  campaignGroups,
  type PopupCampaign,
} from "@/lib/tools/client-health/campaigns";
import type { DashboardClient } from "@/lib/tools/client-health/types";

import { Dialog, DialogBody, DialogFoot, DialogHead } from "./dialog";

/*
 * Every campaign linked to one client.
 *
 * The Weekly row only shows what is RUNNING — that is the tool's spec and it
 * keeps the table about this week. This is where the rest lives: what stopped,
 * what finished, and the reply rates per campaign that migration 0009 added.
 *
 * Grouped by vendor because a client's Instantly and Bison campaigns are run
 * by different people against different lists, and an interleaved list invites
 * comparisons between two things that are not comparable. Headings appear only
 * when both vendors are present; with one they label the obvious.
 */

const TONE: Record<string, { fg: string; bg: string }> = {
  Running: { fg: "var(--green)", bg: "var(--green-bg)" },
  "Campaign Paused": { fg: "var(--yellow)", bg: "var(--yellow-bg)" },
  Finished: { fg: "var(--muted)", bg: "var(--inset-2)" },
  Draft: { fg: "var(--muted)", bg: "var(--inset-2)" },
};

const n = (v: number) => v.toLocaleString("en-US");

export function CampaignsPopup({
  client,
  onClose,
}: {
  client: DashboardClient;
  onClose: () => void;
}) {
  const g = campaignGroups(client);

  const sub = [
    `${g.running.length} active ${g.running.length === 1 ? "campaign" : "campaigns"}`,
    g.running.length > 0 ? `${n(g.totalSent)} emails sent` : null,
    g.all.length > g.running.length ? `${g.all.length - g.running.length} paused / finished` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog onClose={onClose} labelledBy="ch-camps-title" width={620}>
      <DialogHead
        id="ch-camps-title"
        title={client.name}
        sub={
          <>
            {sub}
            {g.all.length > 0 ? (
              <span style={{ display: "block", marginTop: 6, fontSize: 12.5 }}>
                Email counts include every sequence step and subsequence — they match each
                vendor’s campaign total, not its Step Analytics view.
              </span>
            ) : null}
          </>
        }
      />

      <DialogBody>
        {g.all.length === 0 ? (
          <div style={{ padding: "38px 10px", textAlign: "center", color: "var(--muted)" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
              No campaigns linked
            </div>
            <div style={{ fontSize: 13.5 }}>
              Campaigns link by name — this client’s name does not appear in any
              Instantly or Bison campaign.
            </div>
          </div>
        ) : (
          <>
            {g.instantly.length > 0 ? (
              <Group label={g.showHeaders ? "Instantly" : null} campaigns={g.instantly} />
            ) : null}
            {g.bison.length > 0 ? (
              <Group label={g.showHeaders ? "Bison" : null} campaigns={g.bison} />
            ) : null}
          </>
        )}
      </DialogBody>

      <DialogFoot>
        <button className="btn" onClick={onClose}>Close</button>
      </DialogFoot>
    </Dialog>
  );
}

function Group({ label, campaigns }: { label: string | null; campaigns: PopupCampaign[] }) {
  return (
    <div style={{ marginBottom: 6 }}>
      {label ? (
        <div
          className="grp-h"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "4px 0 10px",
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          {label}
          <span className="cpill" style={{ fontWeight: 600 }}>{campaigns.length}</span>
        </div>
      ) : null}

      {campaigns.map((c) => (
        <CampaignCard key={`${c.source}:${c.id}`} campaign={c} />
      ))}
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: PopupCampaign }) {
  const d = campaignDetail(campaign);
  const tone = TONE[d.label];

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        padding: "13px 15px",
        marginBottom: 10,
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={campaign.name}
        >
          {campaign.name}
        </div>
        <div className="tnum" style={{ fontSize: 13.5, fontWeight: 700 }}>
          {Math.round(d.pct)}%
        </div>
      </div>

      <div className="track" style={{ marginTop: 8 }}>
        <i style={{ width: `${d.pct}%` }} />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          fontSize: 12.5,
          color: "var(--muted)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <b className="tnum" style={{ color: "var(--ink-2)" }}>{n(d.completed)}</b>
          {" / "}
          <span className="tnum">{n(d.total)}</span> leads
          <span style={{ margin: "0 6px" }}>·</span>
          <b className="tnum" style={{ color: "var(--ink-2)" }}>{n(d.sent)}</b> emails sent
        </span>
        <span
          style={{
            flex: "none",
            padding: "3px 9px",
            borderRadius: 8,
            fontSize: 11.5,
            fontWeight: 600,
            color: tone.fg,
            background: tone.bg,
          }}
        >
          {d.label}
        </span>
      </div>

      {/* Reply and positive-reply rates, per campaign. An em dash where the
          denominator is zero — a 0.0% reply rate on a campaign that has sent
          nothing is a claim about a campaign that has not run. */}
      <div
        style={{
          display: "flex",
          gap: 18,
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--line-soft)",
          fontSize: 12.5,
        }}
      >
        <Rate label="Reply" pct={d.replyPct} count={d.replies} />
        <Rate label="Positive" pct={d.positivePct} count={d.interested} />
      </div>
    </div>
  );
}

function Rate({ label, pct, count }: { label: string; pct: number | null; count: number }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="tnum" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
        {pct === null ? "—" : `${pct.toFixed(1)}% (${n(count)})`}
      </span>
    </span>
  );
}
