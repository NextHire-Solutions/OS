"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BLOCK_AT, formatRate, HEALTH_WINDOW_DAYS, MIN_SENDS, MIN_WARMUP_SCORE, MIN_WARMUP_SENT, WARMUP_WINDOW_DAYS, type InboxVerdict, type PoolPick } from "@/lib/tools/analytics/campaigns/renew/inbox-health.ts";
import { statusLabel } from "@/lib/tools/analytics/campaigns/renew/leads.ts";
import type { RenewJob } from "@/lib/tools/analytics/campaigns/renew/jobs.ts";
import type { RenewPreview, RenewResult } from "@/lib/tools/analytics/campaigns/renew/renew.ts";
import { fullNumber } from "@/lib/tools/analytics/format.ts";

import { RENEW_URL, startRenew } from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Btn } from "./toast";

/*
 * DUPLICATE & RENEW CAMPAIGN (BrokerStaffer spec, 19 Nov) — the review window
 * and the run's progress. lib/tools/analytics/campaigns/renew/renew.ts does
 * the work; this shows what it will do before it does it:
 *   the old name and its new numbered name, the new campaign's name, the leads
 *   to be transferred, the healthy inboxes to be assigned, the ZF / NO-ZF tag,
 *   the schedule and daily limits, and every inbox left out with the reason.
 * Confirming starts it on the server; it carries on if this window is closed.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; preview: RenewPreview }
  | { kind: "running"; jobId: string; job: RenewJob | null; note?: string };

const DAY_SHORT: Record<string, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

function Row({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="tnum" style={{ display: "flex", justifyContent: "space-between", gap: 12, fontWeight: strong ? 600 : undefined }}>
      <span className={strong ? undefined : "mut"}>{label}</span>
      <span style={{ textAlign: "right" }}>{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-renew-section={title} style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 650, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted)" }}>{title}</div>
      {children}
    </section>
  );
}

function InboxList({ items, show }: { items: InboxVerdict[]; show: "reasons" | "note" }) {
  if (!items.length) return null;
  return (
    <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--line-soft)", borderRadius: "var(--r-md)" }}>
      {items.map((v) => (
        <div key={v.id} className="tnum" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 8px", borderBottom: "1px solid var(--line-soft)", fontSize: 12.5 }}>
          <span style={{ overflowWrap: "anywhere" }}>{v.email}</span>
          <span className="mut" style={{ textAlign: "right" }}>{show === "reasons" ? v.reasons.join(" · ") : v.note ?? (v.rate === null ? "" : formatRate(v.rate))}</span>
        </div>
      ))}
    </div>
  );
}

function PoolList({ items }: { items: PoolPick[] }) {
  if (!items.length) return null;
  return (
    <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--line-soft)", borderRadius: "var(--r-md)" }}>
      {items.map((v) => (
        <div key={v.id} className="tnum" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 8px", borderBottom: "1px solid var(--line-soft)", fontSize: 12.5 }}>
          <span style={{ overflowWrap: "anywhere" }}>{v.email}</span>
          <span className="mut" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            {fullNumber(v.spare)}/day free · {v.rate === null ? "too little sending to judge" : `${formatRate(v.rate)} bounced`}
            {v.tags.length ? ` · ${v.tags.slice(0, 2).join(", ")}${v.sameGroup ? " (same group)" : ""}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A campaign the quick checks already refused: the reason, and the campaign to renew instead when there is one. */
function Refused({ p }: { p: RenewPreview }) {
  const currentId = !p.names.ok ? p.names.currentId : undefined;
  return (
    <>
      <Fail>
        <div data-renew-blockers>{p.blockers.join("\n")}</div>
      </Fail>
      {currentId ? (
        <div>
          <a href={`/analytics/campaigns/${currentId}`} data-renew-current style={{ color: "var(--blue)" }}>
            Open the current campaign (#{currentId})
          </a>
        </div>
      ) : null}
    </>
  );
}

function Review({ p }: { p: RenewPreview }) {
  const j = p.inboxes.judgement;
  const pool = p.inboxes.pool;
  const fromOld = j ? j.add.length + j.warn.length : 0;
  const toAdd = fromOld + (pool?.picks.length ?? 0);
  const unjudged = j ? j.add.filter((v) => v.rate === null).length : 0;
  const leftEntries = Object.entries(p.leads.left).filter(([, n]) => n > 0);
  return (
    <>
      <Section title="Names">
        <Panel style={{ display: "grid", gap: 6 }}>
          {p.names.ok ? (
            <>
              <div>
                <div className="mut" style={{ fontSize: 12 }}>This campaign is renamed</div>
                <div data-renew-old-name style={{ overflowWrap: "anywhere" }}>
                  <s className="mut">{p.source.name}</s> → <b>{p.names.numberedName}</b>
                </div>
              </div>
              <div>
                <div className="mut" style={{ fontSize: 12 }}>The new campaign is named</div>
                <div data-renew-new-name style={{ overflowWrap: "anywhere" }}><b>{p.names.newName}</b></div>
              </div>
              <div className="mut" style={{ fontSize: 12 }}>
                {p.names.earlier.length
                  ? `Earlier rounds found: ${p.names.earlier.map((r) => r.round).join(", ")}. This one becomes round ${p.names.round}.`
                  : "No earlier rounds found: this one becomes round 1."}
              </div>
            </>
          ) : (
            <div style={{ overflowWrap: "anywhere" }}>{p.source.name}</div>
          )}
        </Panel>
      </Section>

      <Section title="Leads">
        <Panel style={{ display: "grid", gap: 4 }}>
          <Row label="In Sequence: moved (they stop here and start again from the first email)">{fullNumber(p.leads.move)}</Row>
          <Row label="Sequence Finished: copied (they stay finished here)">{fullNumber(p.leads.copy)}</Row>
          <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 4 }}>
            <Row label="Total leads to be transferred" strong>
              <span data-renew-transfer>{fullNumber(p.leads.transfer)}</span>
            </Row>
          </div>
          {p.leads.busy.move + p.leads.busy.copy > 0 ? (
            <Row label="Of them, also being emailed by another campaign (added anyway)">{fullNumber(p.leads.busy.move + p.leads.busy.copy)}</Row>
          ) : null}
          {leftEntries.length ? (
            <div className="mut" style={{ fontSize: 12 }}>
              Staying on this campaign only: {leftEntries.map(([k, n]) => `${statusLabel(k)} ${fullNumber(n)}`).join(" · ")}
            </div>
          ) : null}
        </Panel>
      </Section>

      <Section title="Inboxes">
        {!p.inboxes.healthReady ? (
          <Panel><span className="mut">The inbox health check is not switched on yet.</span></Panel>
        ) : j ? (
          <Panel style={{ display: "grid", gap: 6 }}>
            <Row label="Healthy inboxes to be assigned" strong>
              <span data-renew-inboxes>{fullNumber(toAdd)}</span>
            </Row>
            <Row label={`From this campaign (of its ${fullNumber(p.inboxes.onSource)})`}>
              <span data-renew-inboxes-own>{fullNumber(fromOld)}</span>
            </Row>
            {pool && pool.needed > 0 ? (
              <Row label={`From the wider pool, as the kept inboxes can send ${fullNumber(p.inboxes.capacity.kept)}/day and the campaign up to ${fullNumber(p.inboxes.capacity.campaignLimit)}/day`}>
                <span data-renew-inboxes-pool>{fullNumber(pool.picks.length)}</span>
              </Row>
            ) : pool && p.inboxes.capacity.campaignLimit ? (
              <div className="mut" style={{ fontSize: 12 }} data-renew-pool-none>
                No inboxes needed from the wider pool: the kept inboxes can send {fullNumber(p.inboxes.capacity.kept)}/day, enough for the
                campaign&rsquo;s {fullNumber(p.inboxes.capacity.campaignLimit)}/day.
              </div>
            ) : null}
            <div className="mut" style={{ fontSize: 12 }}>
              Added only when connected in EmailBison, not tagged Dead, with a bounce rate under {BLOCK_AT}% over the last {HEALTH_WINDOW_DAYS} days
              (judged once an inbox has sent {MIN_SENDS} emails) and a warm-up score of at least {MIN_WARMUP_SCORE} over the last {WARMUP_WINDOW_DAYS} days
              (judged once it has sent {MIN_WARMUP_SENT} warm-up emails){unjudged ? `; ${fullNumber(unjudged)} had sent too little to judge and are added` : ""}.
              {pool && pool.needed > 0
                ? " Pool inboxes must also not be tagged Warm up, with sending capacity left today (from synced sends, so approximate); inboxes in this campaign's own groups come first, and each is checked again just before it is added."
                : null}
            </div>
            {pool && pool.picks.length ? (
              <details>
                <summary style={{ cursor: "pointer" }} data-renew-pool>From the wider pool: {fullNumber(pool.picks.length)} (adding {fullNumber(pool.added)}/day)</summary>
                <PoolList items={pool.picks} />
              </details>
            ) : null}
            {j.warn.length ? (
              <details>
                <summary style={{ cursor: "pointer" }}>Added with a warning: {fullNumber(j.warn.length)}</summary>
                <InboxList items={j.warn} show="reasons" />
              </details>
            ) : null}
            {j.leave.length ? (
              <details open={j.leave.length <= 8}>
                <summary style={{ cursor: "pointer" }} data-renew-excluded>Left out: {fullNumber(j.leave.length)}</summary>
                <InboxList items={j.leave} show="reasons" />
              </details>
            ) : (
              <div className="mut" style={{ fontSize: 12 }}>No inbox is left out.</div>
            )}
          </Panel>
        ) : null}
      </Section>

      <Section title="Tag, schedule and limits">
        <Panel style={{ display: "grid", gap: 4 }}>
          <Row label="Tag">
            <span data-renew-tag>{p.tag.names.length ? p.tag.names.join(" and ") : "None (the old campaign has no ZF or NO-ZF tag)"}</span>
          </Row>
          <Row label="Sending schedule">
            {p.schedule
              ? `${p.schedule.days.map((d) => DAY_SHORT[d] ?? d).join(", ") || "No days"}${p.schedule.start && p.schedule.end ? `, ${p.schedule.start} to ${p.schedule.end}` : ""}${p.schedule.timezone ? ` (${p.schedule.timezone})` : ""}`
              : "Not set"}
          </Row>
          <Row label="Daily limit">{p.limits.maxEmailsPerDay === null ? "Not set" : `${fullNumber(p.limits.maxEmailsPerDay)} emails`}</Row>
          <Row label="New leads per day">{p.limits.maxNewLeadsPerDay === null ? "Not set" : fullNumber(p.limits.maxNewLeadsPerDay)}</Row>
          <div className="mut" style={{ fontSize: 12 }}>
            Copied as they are, with the emails and follow-ups ({fullNumber(p.source.steps)} sequence step{p.source.steps === 1 ? "" : "s"}).
          </div>
        </Panel>
      </Section>

      {p.links.portal || p.links.picks || p.links.setups || p.links.clientPinned ? (
        <Section title="In the OS">
          <Panel style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
            {p.links.portal ? <div>The portal its replies go to is kept for the new campaign.</div> : null}
            {p.links.picks ? <div>New Prospects go to the new campaign ({p.links.picks === 1 ? "the client's pick moves" : `${p.links.picks} picks move`}).</div> : null}
            {p.links.setups ? <div>The client's setup campaign record moves to the new campaign.</div> : null}
            {p.links.clientPinned ? <div>The client pinned by hand follows the new campaign (once the analytics sync lists it).</div> : null}
          </Panel>
        </Section>
      ) : null}

      {p.warnings.length ? (
        <Warn>
          <div style={{ display: "grid", gap: 4 }} data-renew-warnings>
            {p.warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        </Warn>
      ) : null}
      {p.blockers.length ? (
        <Fail>
          <div data-renew-blockers>{p.blockers.join("\n")}</div>
        </Fail>
      ) : (
        <Warn>
          <b>The new campaign is created as a draft and sends nothing until you start it.</b> Nothing is deleted: this campaign keeps all
          its leads and history.
        </Warn>
      )}
    </>
  );
}

function Outcome({ r }: { r: RenewResult }) {
  if (!r.ok) {
    return (
      <>
        <Fail><span data-renew-error>{r.error}</span></Fail>
        {r.newCampaignId ? (
          <Panel style={{ display: "grid", gap: 4 }}>
            <Row label="New campaign (draft)">#{r.newCampaignId}</Row>
            <Row label="Leads moved">{fullNumber(r.leads.moved)}</Row>
            <Row label="Leads copied">{fullNumber(r.leads.copied)}</Row>
            <Row label="Inboxes added">{fullNumber(r.inboxesAdded)}</Row>
          </Panel>
        ) : null}
      </>
    );
  }
  return (
    <>
      <p style={{ margin: 0 }} data-renew-done>
        <b>{r.oldName}</b> is now <b>{r.numberedName}</b>, and the new draft <b>{r.newName}</b> (#{r.newCampaignId}) is ready.
      </p>
      <Panel style={{ display: "grid", gap: 4 }}>
        <Row label="Leads moved (In Sequence)">{fullNumber(r.leads.moved)}</Row>
        <Row label="Leads copied (Sequence Finished)">{fullNumber(r.leads.copied)}</Row>
        {r.leads.copyRefused ? <Row label="Copies EmailBison refused">{fullNumber(r.leads.copyRefused)}</Row> : null}
        {r.leads.busy ? <Row label="Of them, also in another campaign's sequence">{fullNumber(r.leads.busy)}</Row> : null}
        {r.leads.skippedAtMove ? <Row label="Left on the old campaign at the last check">{fullNumber(r.leads.skippedAtMove)}</Row> : null}
        <Row label="Inboxes added">{fullNumber(r.inboxesAdded)}</Row>
        {r.pool.asked ? <Row label="Of them from the wider pool">{fullNumber(r.pool.added)}{r.pool.dropped.length ? ` (${fullNumber(r.pool.dropped.length)} dropped at the last check)` : ""}</Row> : null}
        <Row label="Tag">{r.tags.length ? r.tags.join(" and ") : "None"}</Row>
      </Panel>
      {r.leads.lost.length ? (
        <Fail>
          <span data-renew-lost>
            {fullNumber(r.leads.lost.length)} lead{r.leads.lost.length === 1 ? " was" : "s were"} stopped on the old campaign but {r.leads.lost.length === 1 ? "is" : "are"} not on the new one:{" "}
            {r.leads.lost.slice(0, 10).map((l) => l.email ?? `#${l.id}`).join(", ")}
            {r.leads.lost.length > 10 ? ` and ${r.leads.lost.length - 10} more` : ""}. Another campaign is still emailing {r.leads.lost.length === 1 ? "it" : "them"}; add{" "}
            {r.leads.lost.length === 1 ? "it" : "them"} to the new campaign by hand if you want {r.leads.lost.length === 1 ? "it" : "them"} there.
          </span>
        </Fail>
      ) : null}
      {r.pinPending ? (
        <Warn>The new campaign is pinned to the old one&rsquo;s client as soon as the analytics sync lists it (within about 30 minutes).</Warn>
      ) : null}
      {r.leads.notArrived.length ? (
        <Warn>
          Not on the new campaign yet: {r.leads.notArrived.slice(0, 10).map((l) => l.email ?? `#${l.id}`).join(", ")}
          {r.leads.notArrived.length > 10 ? ` and ${r.leads.notArrived.length - 10} more` : ""}.
        </Warn>
      ) : null}
      {r.warnings.length ? <Warn><div style={{ display: "grid", gap: 4 }}>{r.warnings.map((w) => <div key={w}>{w}</div>)}</div></Warn> : null}
      <Warn><b>The new campaign is a draft and is not sending.</b> Check it, then start it from the Campaigns page when you are ready.</Warn>
    </>
  );
}

export function RenewDialog({
  campaignId,
  campaignName,
  open,
  onOpenChange,
  onFinished,
}: {
  campaignId: string;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const finishedNotified = useRef<string | null>(null);

  // A fresh review every time it opens: leads and inboxes change by the minute.
  const loadReview = useCallback(async (signal?: AbortSignal) => {
    setPhase({ kind: "loading" });
    try {
      const res = await fetch(RENEW_URL(campaignId), { credentials: "same-origin", signal });
      const body = (await res.json().catch(() => ({}))) as { preview?: RenewPreview; runningJobId?: string | null; error?: string };
      if (signal?.aborted) return;
      if (body.runningJobId) setPhase({ kind: "running", jobId: body.runningJobId, job: null, note: "This campaign is already being renewed." });
      else if (res.ok && body.preview) setPhase({ kind: "review", preview: body.preview });
      else setPhase({ kind: "error", message: body.error ?? `Could not read the campaign (${res.status}).` });
    } catch (e) {
      if (!signal?.aborted) setPhase({ kind: "error", message: e instanceof Error ? e.message : "Could not read the campaign." });
    }
  }, [campaignId]);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    void loadReview(ctl.signal);
    return () => ctl.abort();
  }, [open, loadReview]);

  // While running: ask how it is getting on every 2 seconds.
  const jobId = phase.kind === "running" ? phase.jobId : null;
  useEffect(() => {
    if (!open || !jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${RENEW_URL(campaignId)}?job=${encodeURIComponent(jobId)}`, { credentials: "same-origin" });
        const body = (await res.json().catch(() => ({}))) as { job?: RenewJob; error?: string };
        if (stop) return;
        if (body.job) {
          setPhase((p) => (p.kind === "running" && p.jobId === jobId ? { ...p, job: body.job! } : p));
          if (body.job.finishedAt) {
            if (finishedNotified.current !== jobId) { finishedNotified.current = jobId; onFinished(); }
            return;
          }
        } else if (!res.ok) {
          setPhase({ kind: "error", message: body.error ?? `Could not read the renewal's progress (${res.status}).` });
          return;
        }
      } catch { /* a missed poll: try again */ }
      if (!stop) setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stop = true; };
  }, [open, jobId, campaignId, onFinished]);

  const confirm = async () => {
    if (phase.kind !== "review") return;
    setStarting(true);
    try {
      const { ok, status, body } = await startRenew(campaignId, phase.preview.token, phase.preview.inboxes.pool?.picks.map((x) => x.id) ?? []);
      if (body.jobId) setPhase({ kind: "running", jobId: body.jobId, job: null, note: status === 409 ? body.error : undefined });
      else if (!ok) setPhase({ kind: "error", message: body.error ?? `Could not start (${status}).` });
    } finally {
      setStarting(false);
    }
  };

  const close = () => onOpenChange(false);
  const job = phase.kind === "running" ? phase.job : null;
  const result = job?.result ?? null;
  const runningNow = phase.kind === "running" && !result;

  const refused = phase.kind === "review" && phase.preview.checked === "quick";
  const footer =
    refused ? (
      <Btn onClick={close}>Close</Btn>
    ) : phase.kind === "review" ? (
      <>
        <Btn onClick={close} disabled={starting}>Cancel</Btn>
        <Btn primary data-renew-confirm onClick={() => void confirm()} disabled={starting || phase.preview.blockers.length > 0}>
          {starting ? "Starting…" : "Duplicate & Renew"}
        </Btn>
      </>
    ) : phase.kind === "error" ? (
      <>
        <Btn onClick={close}>Close</Btn>
        <Btn onClick={() => void loadReview()}>Try again</Btn>
      </>
    ) : (
      // Blue only once there is a result to close on; plain while loading or running (no blue-to-white flash).
      <Btn primary={!!result} onClick={close}>{runningNow ? "Close (it carries on)" : "Close"}</Btn>
    );

  return (
    <DialogFrame
      open={open}
      onClose={close}
      width={640}
      title={result ? (result.ok ? "Campaign renewed" : "Renewal stopped") : refused ? "This campaign cannot be renewed" : "Duplicate & Renew Campaign"}
      description={<span style={{ overflowWrap: "anywhere" }}>{campaignName}</span>}
      footer={footer}
    >
      {phase.kind === "loading" ? (
        <div className="mut" data-renew-loading>Checking the campaign, then reading its leads and inboxes… (up to half a minute on a big campaign)</div>
      ) : phase.kind === "error" ? (
        <Fail><span data-renew-load-error>{phase.message}</span></Fail>
      ) : phase.kind === "review" ? (
        phase.preview.checked === "quick" ? <Refused p={phase.preview} /> : <Review p={phase.preview} />
      ) : result ? (
        <Outcome r={result} />
      ) : (
        <>
          {phase.note ? <Warn>{phase.note}</Warn> : null}
          <Panel style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
            <div data-renew-progress>
              {(job?.log.length ? job.log : ["Starting…"]).map((line, i, all) => (
                <div key={`${i}-${line}`} className={i === all.length - 1 ? undefined : "mut"}>{line}</div>
              ))}
            </div>
          </Panel>
          <div className="mut" style={{ fontSize: 12 }}>You can close this window: the renewal carries on, and it is recorded in the campaign history.</div>
        </>
      )}
    </DialogFrame>
  );
}
