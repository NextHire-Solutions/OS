"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  LOW_LEFT,
  checkSelection,
  inboxesInTargets,
  planRemoval,
  runTargets,
  wouldStopSending,
  type CheckProgress,
  type PlanRow,
  type RemovalPlan,
  type RemovalResult,
} from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { fullNumber } from "@/lib/tools/analytics/format.ts";

import { removalByInbox, removalCampaigns, removalOverlap, removalRun } from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Btn } from "./toast";

/*
 * Removing the selected inboxes from every campaign (5 Nov — the rules and why are in inbox-removal.ts).
 *
 * Four steps, and nothing changes before the third:
 *
 *   checking  which of these inboxes each open campaign holds, read from EmailBison
 *   review    exactly what would happen to each campaign
 *   running   one campaign at a time, with the choice to stop between two
 *   done      what really happened, campaign by campaign
 */

type RunResult = RemovalResult & { name: string };

type Stage =
  | { name: "checking"; progress: CheckProgress | null }
  | { name: "failed"; message: string }
  | { name: "review"; plan: RemovalPlan }
  | { name: "running"; targets: PlanRow[]; results: RunResult[] }
  | { name: "done"; targets: PlanRow[]; results: RunResult[]; stopped: boolean };

const STATUS_TONE: Record<string, string> = { active: "s-done", queued: "plan-prod", launching: "plan-prod", paused: "s-ok", draft: "plan-min" };
const plural = (n: number, one: string, many = `${one}s`) => `${fullNumber(n)} ${n === 1 ? one : many}`;

export function RemoveInboxesDialog({
  inboxIds: selected,
  leftOut,
  onClose,
}: {
  /** The selected EmailBison inboxes. */
  inboxIds: number[];
  /** Selected inboxes this doesn't cover: Instantly's. */
  leftOut: number;
  /** `changed`: something really came off, so the page's figures are out of date. */
  onClose: (changed: boolean) => void;
}) {
  /*
   * The selection as it was when this opened, once. The page behind re-renders on its own (its EmailBison figures poll)
   * and hands in a new array each time: following it re-ran the check, and put the review back over a run in progress.
   */
  const [inboxIds] = useState(selected);
  const [stage, setStage] = useState<Stage>({ name: "checking", progress: null });
  const [includeActive, setIncludeActive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const closed = useRef(false);
  const stop = useRef(false);
  const changed = useRef(false);
  // A double click on Remove lands where Stop then is: it mustn't stop the run it just started.
  const startedAt = useRef(0);

  const check = useCallback(async () => {
    setStage({ name: "checking", progress: null });
    try {
      const { campaigns } = await removalCampaigns();
      if (closed.current) return;
      const overlaps = await checkSelection(
        inboxIds,
        campaigns,
        {
          byInbox: async (ids) => (await removalByInbox(ids)).campaigns,
          overlap: (campaign, ids) => removalOverlap(campaign.id, campaign.inboxes, ids),
        },
        {
          cancelled: () => closed.current,
          onProgress: (progress) => { if (!closed.current) setStage({ name: "checking", progress }); },
        },
      );
      if (closed.current || !overlaps) return;
      setStage({ name: "review", plan: planRemoval(inboxIds, campaigns, overlaps) });
    } catch (e) {
      if (!closed.current) setStage({ name: "failed", message: e instanceof Error ? e.message : "EmailBison did not answer." });
    }
  }, [inboxIds]);

  useEffect(() => {
    closed.current = false;
    void check();
    return () => { closed.current = true; };
  }, [check]);

  const close = () => {
    closed.current = true;
    onClose(changed.current);
  };

  // The buttons change from one step to the next, and a removed button takes the focus with it. It stays in the dialog.
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-rm-stage]")?.closest<HTMLElement>("[role=dialog]")?.focus();
  }, [stage.name]);

  // Leaving the page mid-run would hide a campaign left paused: the browser asks first.
  const inRun = stage.name === "running";
  useEffect(() => {
    if (!inRun) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [inRun]);

  /*
   * One campaign at a time: a run cut short has changed only what it has reported. `earlier` and `all` are for trying
   * again: what is already settled stays in the final report, against every campaign this was for.
   */
  const run = async (targets: PlanRow[], earlier: RunResult[] = [], all: PlanRow[] = targets) => {
    const batchId = crypto.randomUUID();
    startedAt.current = Date.now();
    stop.current = false;
    setStopping(false);
    let results: RunResult[] = [];
    setStage({ name: "running", targets, results });
    for (const target of targets) {
      // Gone from the page: no more campaigns are started, and whatever is under way finishes on the server.
      if (stop.current || closed.current) break;
      let result: RunResult;
      try {
        result = await removalRun({ campaignId: target.id, inboxIds: target.inboxIds, pauseActive: includeActive, batchId });
      } catch (e) {
        result = {
          campaignId: target.id, name: target.name, ok: false, outcome: "failed", applied: 0, before: null, left: null,
          paused: false, stillPaused: false, removedIds: [],
          // No answer about one that may have been mid-pause: it can't be called unchanged, or tried again as if it were paused.
          unsure: includeActive && target.status !== "draft" && target.status !== "paused",
          error: e instanceof Error ? e.message : "No answer from the server. Check this campaign before trying again.",
        };
      }
      if (result.removedIds.length) changed.current = true;
      results = [...results, result];
      setStage({ name: "running", targets, results });
    }
    const order = new Map(all.map((t, i) => [t.id, i]));
    const report = [...earlier, ...results].sort((a, b) => (order.get(a.campaignId) ?? 0) - (order.get(b.campaignId) ?? 0));
    setStage({ name: "done", targets: all, results: report, stopped: stop.current });
  };

  const running = stage.name === "running";

  return (
    <DialogFrame
      open
      // While a campaign is mid-change, Stop is the way out: closing here would hide what it went on to do.
      onClose={running ? () => {} : close}
      width={760}
      title={stage.name === "done" ? "Remove inboxes from campaigns: finished" : "Remove inboxes from campaigns"}
      description={stage.name === "done" ? undefined : `${plural(inboxIds.length, "inbox", "inboxes")} selected`}
      footer={<Footer stage={stage} includeActive={includeActive} stopping={stopping} onClose={close} onRetryCheck={() => void check()}
        onRun={(targets) => void run(targets)}
        onStop={() => {
          if (Date.now() - startedAt.current < 800) return;
          stop.current = true;
          setStopping(true);
        }}
        onRetry={(targets, earlier, all) => void run(targets, earlier, all)} />}
    >
      <div data-rm-stage={stage.name} style={{ display: "contents" }}>
        {stage.name === "checking" ? <Checking progress={stage.progress} /> : null}
        {stage.name === "failed" ? <Fail>Couldn&apos;t check the campaigns: {stage.message}</Fail> : null}
        {stage.name === "review" ? <Review plan={stage.plan} selected={inboxIds.length} leftOut={leftOut} includeActive={includeActive} onIncludeActive={setIncludeActive} /> : null}
        {stage.name === "running" ? <Running targets={stage.targets} results={stage.results} stopping={stopping} /> : null}
        {stage.name === "done" ? <Done targets={stage.targets} results={stage.results} stopped={stage.stopped} /> : null}
      </div>
    </DialogFrame>
  );
}

function Footer({
  stage, includeActive, stopping, onClose, onRetryCheck, onRun, onStop, onRetry,
}: {
  stage: Stage;
  includeActive: boolean;
  stopping: boolean;
  onClose: () => void;
  onRetryCheck: () => void;
  onRun: (targets: PlanRow[]) => void;
  onStop: () => void;
  onRetry: (targets: PlanRow[], earlier: RunResult[], all: PlanRow[]) => void;
}) {
  if (stage.name === "checking") return <Btn onClick={onClose}>Cancel</Btn>;
  if (stage.name === "failed") {
    return (
      <>
        <Btn onClick={onClose}>Close</Btn>
        <Btn primary onClick={onRetryCheck}>Try again</Btn>
      </>
    );
  }
  if (stage.name === "running") return <Btn disabled={stopping} data-rm-stop onClick={onStop}>{stopping ? "Stopping…" : "Stop after this campaign"}</Btn>;
  if (stage.name === "done") {
    const failed = stage.results.filter((r) => !r.ok && !r.stillPaused && !r.unsure);
    const notDone = stage.targets.filter((t) => !stage.results.some((r) => r.campaignId === t.id) || failed.some((r) => r.campaignId === t.id));
    return (
      <>
        {notDone.length ? (
          <Btn data-rm-retry onClick={() => onRetry(notDone, stage.results.filter((r) => !notDone.some((t) => t.id === r.campaignId)), stage.targets)}>
            {notDone.length === 1 ? "Try the other campaign" : `Try the other ${fullNumber(notDone.length)} campaigns`}
          </Btn>
        ) : null}
        <Btn primary data-rm-close onClick={onClose}>Close</Btn>
      </>
    );
  }
  const targets = runTargets(stage.plan, includeActive);
  const nothing = !stage.plan.change.length && !stage.plan.active.length && !stage.plan.keep.length;
  if (nothing) return <Btn primary onClick={onClose}>Close</Btn>;
  return (
    <>
      <Btn onClick={onClose}>Cancel</Btn>
      <button type="button" className="btn an-rm-go" data-rm-go disabled={!targets.length} onClick={() => onRun(targets)}>
        {targets.length ? `Remove from ${plural(targets.length, "campaign")}` : "Nothing to remove yet"}
      </button>
    </>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <div className="track" aria-hidden>
      <i style={{ width: `${Math.round(Math.min(1, share) * 100)}%`, background: "var(--blue)", transition: "width .25s" }} />
    </div>
  );
}

function Checking({ progress }: { progress: CheckProgress | null }) {
  const counted = progress && progress.total > 0;
  return (
    <div style={{ display: "grid", gap: 10, padding: "6px 0" }}>
      <div role="status" className="tnum" data-rm-progress>
        {!counted
          ? "Reading your campaigns from EmailBison…"
          : progress.unit === "inbox"
            ? `Checking inbox ${fullNumber(progress.done)} of ${fullNumber(progress.total)}…`
            : `Checking campaign ${fullNumber(progress.done)} of ${fullNumber(progress.total)}…`}
      </div>
      <Bar share={counted ? progress.done / progress.total : 0} />
      <div className="mut" style={{ fontSize: 12.5 }}>
        {counted && progress.unit === "campaign"
          ? "EmailBison lists a campaign's inboxes a few at a time, so this can take a few minutes the first time. Nothing has changed yet."
          : "Nothing has changed yet."}
      </div>
    </div>
  );
}

function Rows({ rows, dim = false, section }: { rows: PlanRow[]; dim?: boolean; section: string }) {
  return (
    <div className="an-rm-list" data-rm-section={section} style={{ opacity: dim ? 0.55 : 1 }}>
      <div className="an-rm-row an-rm-head" aria-hidden>
        <span>Campaign</span>
        <span>Status</span>
        <span className="r">Removing</span>
        <span className="r">Left after</span>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="an-rm-row" data-rm-campaign={row.id}>
          <span className="an-rm-name" title={row.name}>{row.name}</span>
          <span><span className={`badge ${STATUS_TONE[row.status] ?? "plan-min"}`}>{row.status}</span></span>
          <span className="r tnum"><span className="an-rm-tiny">Removing </span>{fullNumber(row.inboxIds.length)}</span>
          <span className="r tnum" style={row.left > 0 && (row.left < LOW_LEFT || row.leftConnected === 0) ? { color: "var(--amber, #B7791F)", fontWeight: 600 } : undefined} title={row.leftConnected === 0 ? "None of these can connect" : undefined}>
            <span className="an-rm-tiny">Left after </span>{fullNumber(row.left)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Review({
  plan, selected, leftOut, includeActive, onIncludeActive,
}: {
  plan: RemovalPlan;
  selected: number;
  leftOut: number;
  includeActive: boolean;
  onIncludeActive: (on: boolean) => void;
}) {
  const targets = runTargets(plan, includeActive);
  const open = plan.change.length + plan.active.length + plan.keep.length;
  const inboxes = inboxesInTargets(targets);
  const stops = wouldStopSending(targets);
  return (
    <>
      <Panel style={{ background: "var(--inset)" }}>
        <div className="tnum" data-rm-summary>
          {open ? (
            <>
              <b>{plural(plan.onSomething, "inbox", "inboxes")}</b> {plan.onSomething === 1 ? "is" : "are"} on <b>{plural(open, "open campaign")}</b>.
            </>
          ) : (
            <>{selected === 1 ? "This inbox isn't" : "None of these inboxes is"} on an open campaign, so there&apos;s nothing to remove.</>
          )}
        </div>
        {plan.onNothing > 0 && open ? (
          <div className="mut tnum" style={{ fontSize: 12.5, marginTop: 3 }}>{plural(plan.onNothing, "other inbox", "other inboxes")} {plan.onNothing === 1 ? "is" : "are"} on no open campaign, so nothing changes for {plan.onNothing === 1 ? "it" : "them"}.</div>
        ) : null}
        {leftOut > 0 ? (
          <div className="mut tnum" data-rm-leftout style={{ fontSize: 12.5, marginTop: 3 }}>{plural(leftOut, "Instantly inbox", "Instantly inboxes")} left out: this removes EmailBison inboxes.</div>
        ) : null}
        <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>Finished and archived campaigns aren&apos;t changed.</div>
      </Panel>

      {plan.change.length ? (
        <section className="an-rm-sec" aria-label="Paused and draft campaigns">
          <h3>Paused and draft campaigns <span className="mut tnum">{fullNumber(plan.change.length)}</span></h3>
          <Rows rows={plan.change} section="change" />
        </section>
      ) : null}

      {plan.active.length ? (
        <section className="an-rm-sec" aria-label="Active campaigns">
          <label className="an-rm-tick">
            <input type="checkbox" data-rm-active checked={includeActive} onChange={(e) => onIncludeActive(e.target.checked)} style={{ accentColor: "var(--blue)" }} />
            <span>
              <b>Also remove from {plural(plan.active.length, "active campaign")}</b>
              <span className="mut">EmailBison won&apos;t change an active campaign. Each one is paused, the inboxes come off, and it starts again straight away, so it stops sending briefly, usually for under a minute.</span>
            </span>
          </label>
          <Rows rows={plan.active} dim={!includeActive} section="active" />
        </section>
      ) : null}

      {plan.keep.length ? (
        <section className="an-rm-sec" aria-label="Campaigns left alone">
          <h3>Left alone <span className="mut tnum">{fullNumber(plan.keep.length)}</span></h3>
          <p className="mut" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            These inboxes are all {plan.keep.length === 1 ? "this campaign has" : "these campaigns have"}. EmailBison archives a paused campaign with no inboxes, so add other inboxes first, then run this again.
          </p>
          <Rows rows={plan.keep} dim section="keep" />
        </section>
      ) : null}

      {targets.length ? (
        <Warn>
          <span className="tnum" data-rm-warning>
            <b>{plural(inboxes, "inbox", "inboxes")}</b> will stop sending for <b>{plural(targets.length, "campaign")}</b>.
            To put them back, assign them again from each campaign&apos;s Inboxes button.
            {stops.length ? (
              <span style={{ display: "block", marginTop: 4 }} data-rm-stops>
                <b>{plural(stops.length, "campaign")} would keep only inboxes that can&apos;t connect, so {stops.length === 1 ? "it" : "they"} would stop sending:</b>{" "}
                {stops.map((s) => s.name).join(", ")}.
              </span>
            ) : null}
          </span>
        </Warn>
      ) : null}
    </>
  );
}

function resultLine(r: RunResult): string {
  switch (r.outcome) {
    case "removed": return `${fullNumber(r.applied)} removed${r.left === null ? "" : `, ${fullNumber(r.left)} left`}${r.paused && !r.stillPaused ? ", started again" : ""}`;
    case "nothing": return "None of them was on it any more";
    case "active": return "Not changed: it has become active";
    case "last": return "Not changed: it would have no inboxes left";
    case "finished": return "Not changed: it has finished";
    case "failed": return `${r.error ?? "It didn't go through"}${r.applied > 0 ? ` ${fullNumber(r.applied)} did come off.` : ""}`;
  }
}

function ResultRows({ rows, targets }: { rows: RunResult[]; targets: PlanRow[] }) {
  const names = new Map(targets.map((t) => [t.id, t.name]));
  return (
    <div className="an-rm-list" data-rm-results>
      {rows.map((r) => (
        <div key={r.campaignId} className="an-rm-res" data-rm-result={r.outcome} data-rm-campaign={r.campaignId}>
          <span aria-hidden className={`an-rm-mark ${r.ok && r.outcome === "removed" ? "ok" : !r.ok ? "bad" : "still"}`}>{r.ok && r.outcome === "removed" ? "✓" : !r.ok ? "!" : "–"}</span>
          <span className="an-rm-name" title={r.name || names.get(r.campaignId)}>{r.name || names.get(r.campaignId)}</span>
          <span className="tnum an-rm-out">{resultLine(r)}</span>
        </div>
      ))}
    </div>
  );
}

function Running({ targets, results, stopping }: { targets: PlanRow[]; results: RunResult[]; stopping: boolean }) {
  const now = targets.find((t) => !results.some((r) => r.campaignId === t.id));
  return (
    <>
      <div style={{ display: "grid", gap: 10 }}>
        <div role="status" className="tnum" data-rm-progress>
          {stopping ? "Stopping after this campaign…" : `Campaign ${fullNumber(Math.min(results.length + 1, targets.length))} of ${fullNumber(targets.length)}`}
          {now ? <span className="mut">: {now.name}</span> : null}
        </div>
        <Bar share={results.length / targets.length} />
      </div>
      {results.length ? <ResultRows rows={[...results].reverse()} targets={targets} /> : null}
    </>
  );
}

function Done({ targets, results, stopped }: { targets: PlanRow[]; results: RunResult[]; stopped: boolean }) {
  const removed = results.filter((r) => r.outcome === "removed" && r.ok);
  // Each inbox once, as the review counted them: five inboxes on ten campaigns is five inboxes.
  const total = new Set(results.flatMap((r) => r.removedIds)).size;
  const stillPaused = results.filter((r) => r.stillPaused);
  const unsure = results.filter((r) => r.unsure);
  const failed = results.filter((r) => !r.ok && !r.stillPaused && !r.unsure);
  const notReached = targets.length - results.length;
  return (
    <>
      <Panel style={{ background: "var(--inset)" }}>
        <div className="tnum" data-rm-done>
          <b>{plural(total, "inbox", "inboxes")}</b> removed across <b>{fullNumber(removed.length)} of {plural(targets.length, "campaign")}</b>.
        </div>
        {stopped && notReached > 0 ? <div className="mut tnum" style={{ fontSize: 12.5, marginTop: 3 }}>Stopped: {plural(notReached, "campaign")} not reached, and not changed.</div> : null}
        {removed.length ? <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>The Assigned column and Active inboxes catch up within a few minutes.</div> : null}
      </Panel>
      {stillPaused.length ? (
        <Fail>
          <b>{stillPaused.length === 1 ? "This campaign is" : "These campaigns are"} still paused and not sending.</b> {"Start " + (stillPaused.length === 1 ? "it" : "them") + " from Campaigns:"}
          {stillPaused.map((r) => (
            <div key={r.campaignId}><a href={`/analytics/campaigns/${r.campaignId}`} style={{ color: "inherit", textDecoration: "underline" }}>{r.name}</a></div>
          ))}
        </Fail>
      ) : null}
      {unsure.length ? (
        <Fail>
          <b>{unsure.length === 1 ? "This campaign" : "These campaigns"} may be paused. Please check {unsure.length === 1 ? "it" : "them"}:</b>
          {unsure.map((r) => (
            <div key={r.campaignId}><a href={`/analytics/campaigns/${r.campaignId}`} style={{ color: "inherit", textDecoration: "underline" }}>{r.name}</a></div>
          ))}
        </Fail>
      ) : null}
      {failed.length ? <Fail>{plural(failed.length, "campaign")} didn&apos;t go through. The reason is beside each one below.</Fail> : null}
      <ResultRows rows={results} targets={targets} />
    </>
  );
}
