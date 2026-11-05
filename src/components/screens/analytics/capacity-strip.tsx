"use client";

import { useEffect, useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import { gapLabel, type ActiveInboxCapacity, type CapacityPicture } from "@/lib/tools/analytics/sending-capacity.ts";
import { fullStamp } from "@/lib/workspace/dates";

import { ACTIVE_CAPACITY_URL } from "./actions";

/*
 * The capacity strip above the Campaigns list (13 Oct; 5 Nov, client: "ADD a second metric showing the active inboxes
 * (those connected to active campaigns) along with their daily sending volume. That way we'd have both views: total
 * connected and actual usable capacity").
 *
 * Three figures side by side, each measured against what the active campaigns need, because either can be short while
 * the other has room: the whole workspace can send enough while the inboxes actually on campaigns can't.
 */

interface Snapshot {
  status: "ready" | "refreshing" | "loading" | "error";
  active: ActiveInboxCapacity | null;
  asOf: string | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

const POLL_MS = 5000;
const POLL_LIMIT = 120;

/* Asked for once the page is up, and again until the read from EmailBison has finished. `again` asks afresh when it changes. */
function useActiveCapacity(skip: boolean, again: unknown): Snapshot | null {
  const [answer, setAnswer] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asked = 0;
    // No more answers are coming: a figure already on screen stays, and "Counting…" doesn't go on for ever.
    const giveUp = () => setAnswer((was) => (was?.active ? { ...was, status: "ready", progress: null } : { status: "error", active: null, asOf: null, progress: null, error: "No answer." }));
    const ask = async () => {
      try {
        const res = await fetch(ACTIVE_CAPACITY_URL, { credentials: "same-origin" });
        const next = (await res.json()) as Snapshot;
        if (!live) return;
        if (!res.ok || !next?.status) return giveUp();
        setAnswer(next);
        asked++;
        if (next.status === "loading" || next.status === "refreshing") {
          if (asked < POLL_LIMIT) timer = setTimeout(() => void ask(), POLL_MS);
          else giveUp();
        }
      } catch {
        if (live) giveUp();
      }
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [skip, again]);
  return answer;
}

const day = (n: number) => `${fullNumber(Math.round(n))} a day`;

function GapBadge({ daily, needed }: { daily: number; needed: number }) {
  if (needed === 0) return null;
  const gap = daily - needed;
  return <span className={`badge an-cap-b ${gap < 0 ? "s-risk" : "s-done"}`} data-capacity-gap={gap < 0 ? "short" : "ok"}>{gapLabel({ gap, needed })}</span>;
}

function ActiveCell({ snapshot, needed }: { snapshot: Snapshot | null; needed: number }) {
  const active = snapshot?.active ?? null;
  if (active) {
    return (
      <>
        <span className="an-cap-n tnum" data-capacity-value>{day(active.daily)}</span>
        <span className="an-cap-s tnum">
          {fullNumber(active.inboxes)} {active.inboxes === 1 ? "inbox" : "inboxes"} on {fullNumber(active.campaigns)} active {active.campaigns === 1 ? "campaign" : "campaigns"}
        </span>
        {active.cannotConnect > 0 ? (
          <span className="an-cap-s tnum" data-capacity-dead style={{ color: "var(--red)" }}>{fullNumber(active.cannotConnect)} more on them can&apos;t connect</span>
        ) : null}
        <GapBadge daily={active.daily} needed={needed} />
        {snapshot?.asOf ? (
          <span className="an-cap-t" data-capacity-checked>Checked {fullStamp(snapshot.asOf)} ET{snapshot.status === "refreshing" ? ", updating" : ""}</span>
        ) : null}
      </>
    );
  }
  if (snapshot?.status === "error") {
    return (
      <>
        <span className="an-cap-n an-cap-wait" data-capacity-value>Not available</span>
        <span className="an-cap-s">EmailBison didn&apos;t answer just now. It tries again in a few minutes.</span>
      </>
    );
  }
  const progress = snapshot?.progress;
  return (
    <>
      <span className="an-cap-n an-cap-wait" data-capacity-value>Counting…</span>
      <span className="an-cap-s tnum" role="status">
        {progress?.total ? `Reading campaign ${fullNumber(Math.min(progress.done + 1, progress.total))} of ${fullNumber(progress.total)} from EmailBison` : "Reading from EmailBison"}
      </span>
    </>
  );
}

export function CapacityStrip({ capacity, showActive }: { capacity: CapacityPicture; showActive: boolean }) {
  const snapshot = useActiveCapacity(!showActive, capacity.activeCampaigns);
  return (
    <div className={`an-cap${showActive ? "" : " two"}`} data-campaign-capacity={capacity.gap < 0 ? "short" : "ok"}>
      <div data-capacity-cell="total">
        <span className="an-cap-l" title="The daily limits of every inbox that can send, on a campaign or not.">All connected inboxes</span>
        <span className="an-cap-n tnum" data-capacity-value>{day(capacity.daily)}</span>
        <span className="an-cap-s tnum">{fullNumber(capacity.inboxes)} {capacity.inboxes === 1 ? "inbox" : "inboxes"}</span>
        <GapBadge daily={capacity.daily} needed={capacity.needed} />
      </div>
      {showActive ? (
        <div data-capacity-cell="active" data-capacity-state={snapshot?.status ?? "asking"}>
          <span className="an-cap-l" title="The daily limits of the Connected inboxes attached to at least one active campaign, each counted once.">Active inboxes</span>
          <ActiveCell snapshot={snapshot} needed={capacity.needed} />
        </div>
      ) : null}
      <div data-capacity-cell="needed">
        <span className="an-cap-l" title="The daily send limits of every active campaign, added up.">Active campaigns need</span>
        <span className="an-cap-n tnum" data-capacity-value>{day(capacity.needed)}</span>
        <span className="an-cap-s tnum">
          {capacity.activeCampaigns === 0
            ? "No campaign is active"
            : `${fullNumber(capacity.activeCampaigns)} ${capacity.activeCampaigns === 1 ? "campaign" : "campaigns"}${capacity.newLeads > 0 ? ` · ${fullNumber(capacity.newLeads)} new leads a day` : ""}`}
        </span>
        <a className="mut an-cap-how" href="/analytics/volume">How this is worked out →</a>
      </div>
    </div>
  );
}
