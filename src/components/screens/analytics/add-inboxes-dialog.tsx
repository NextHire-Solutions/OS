"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { addSelection, type AddResult } from "@/lib/tools/analytics/campaigns/inbox-add.ts";
import type { OpenCampaign } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { fullNumber } from "@/lib/tools/analytics/format.ts";

import { addRun, removalCampaigns } from "./actions";
import { DialogFrame, Fail, Panel } from "./dialog-frame";
import { Btn } from "./toast";

/*
 * Adding the selected inboxes to the campaigns picked here (6 Nov — the rules and why are in inbox-add.ts).
 *
 *   loading  every open campaign, as EmailBison has it now
 *   pick     tick or untick campaigns; nothing changes before Add
 *   running  one campaign at a time, with the choice to stop between two
 *   done     what really happened, campaign by campaign, by each campaign's own count
 */

type RunResult = AddResult & { name: string };

type Stage =
  | { name: "loading" }
  | { name: "failed"; message: string }
  | { name: "pick" }
  | { name: "running"; targets: OpenCampaign[]; results: RunResult[] }
  | { name: "done"; targets: OpenCampaign[]; results: RunResult[]; stopped: boolean };

type StatusFilter = "all" | "active" | "paused" | "draft";
const STATUS_TONE: Record<string, string> = { active: "s-done", queued: "plan-prod", launching: "plan-prod", paused: "s-ok", draft: "plan-min" };
const plural = (n: number, one: string, many = `${one}s`) => `${fullNumber(n)} ${n === 1 ? one : many}`;
/** Queued and launching are on their way to sending: they count as active here, as on the Campaigns page. */
const groupOf = (status: string): Exclude<StatusFilter, "all"> => (status === "paused" ? "paused" : status === "draft" ? "draft" : "active");

export function AddInboxesDialog({
  inboxes: selectedRows,
  onClose,
}: {
  /** The selected inboxes, with their status: only Connected EmailBison ones are added. */
  inboxes: ReadonlyArray<{ id: number | string; status: string | null }>;
  /** `changed`: something really went on, so the page's figures are out of date. */
  onClose: (changed: boolean) => void;
}) {
  // The selection as it was when this opened, once: the page behind re-renders on its own and hands in new arrays.
  const [selection] = useState(() => addSelection(selectedRows));
  const [stage, setStage] = useState<Stage>({ name: "loading" });
  const [campaigns, setCampaigns] = useState<OpenCampaign[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [stopping, setStopping] = useState(false);
  const closed = useRef(false);
  const stop = useRef(false);
  const changed = useRef(false);
  const startedAt = useRef(0);

  const load = async () => {
    setStage({ name: "loading" });
    try {
      const { campaigns: open } = await removalCampaigns();
      if (closed.current) return;
      setCampaigns([...open].sort((a, b) => a.name.localeCompare(b.name)));
      setStage({ name: "pick" });
    } catch (e) {
      if (!closed.current) setStage({ name: "failed", message: e instanceof Error ? e.message : "EmailBison did not answer." });
    }
  };
  useEffect(() => {
    closed.current = false;
    void load();
    return () => { closed.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    closed.current = true;
    onClose(changed.current);
  };

  // The buttons change from one step to the next, and a removed button takes the focus with it. It stays in the dialog.
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-add-stage]")?.closest<HTMLElement>("[role=dialog]")?.focus();
  }, [stage.name]);

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

  const counts = useMemo(() => {
    const c = { all: campaigns.length, active: 0, paused: 0, draft: 0 };
    for (const x of campaigns) c[groupOf(x.status)]++;
    return c;
  }, [campaigns]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return campaigns.filter((c) => (status === "all" || groupOf(c.status) === status) && (!q || c.name.toLowerCase().includes(q)));
  }, [campaigns, query, status]);
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const targets = campaigns.filter((c) => picked.has(c.id));
  const activePicked = targets.filter((c) => groupOf(c.status) === "active").length;

  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickShown = (on: boolean) => setPicked((p) => { const n = new Set(p); for (const c of shown) if (on) n.add(c.id); else n.delete(c.id); return n; });

  /* One campaign at a time: a run cut short has changed only what it has reported. */
  const run = async (list: OpenCampaign[], earlier: RunResult[] = [], all: OpenCampaign[] = list) => {
    const batchId = crypto.randomUUID();
    startedAt.current = Date.now();
    stop.current = false;
    setStopping(false);
    let results: RunResult[] = [];
    setStage({ name: "running", targets: list, results });
    for (const target of list) {
      if (stop.current || closed.current) break;
      let result: RunResult;
      try {
        result = await addRun({ campaignId: target.id, inboxIds: selection.send, batchId });
      } catch (e) {
        result = {
          campaignId: target.id, name: target.name, ok: false, outcome: "failed", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0,
          error: e instanceof Error ? e.message : "No answer from the server. Check this campaign before trying again.",
        };
      }
      if (result.added > 0) changed.current = true;
      results = [...results, result];
      setStage({ name: "running", targets: list, results });
    }
    const order = new Map(all.map((t, i) => [t.id, i]));
    const report = [...earlier, ...results].sort((a, b) => (order.get(a.campaignId) ?? 0) - (order.get(b.campaignId) ?? 0));
    setStage({ name: "done", targets: all, results: report, stopped: stop.current });
  };

  const running = stage.name === "running";
  const footer = (() => {
    if (stage.name === "loading") return <Btn onClick={close}>Cancel</Btn>;
    if (stage.name === "failed") return <><Btn onClick={close}>Close</Btn><Btn primary onClick={() => void load()}>Try again</Btn></>;
    if (stage.name === "running") {
      return (
        <Btn disabled={stopping} data-add-stop onClick={() => { if (Date.now() - startedAt.current < 800) return; stop.current = true; setStopping(true); }}>
          {stopping ? "Stopping…" : "Stop after this campaign"}
        </Btn>
      );
    }
    if (stage.name === "done") {
      const failed = stage.results.filter((r) => !r.ok);
      const notDone = stage.targets.filter((t) => !stage.results.some((r) => r.campaignId === t.id) || failed.some((r) => r.campaignId === t.id));
      return (
        <>
          {notDone.length ? (
            <Btn data-add-retry onClick={() => void run(notDone, stage.results.filter((r) => !notDone.some((t) => t.id === r.campaignId)), stage.targets)}>
              {notDone.length === 1 ? "Try the other campaign" : `Try the other ${fullNumber(notDone.length)} campaigns`}
            </Btn>
          ) : null}
          <Btn primary data-add-close onClick={close}>Close</Btn>
        </>
      );
    }
    return (
      <>
        <Btn onClick={close}>Cancel</Btn>
        <Btn primary data-add-go disabled={!targets.length || !selection.send.length} onClick={() => void run(targets)}>
          {!selection.send.length ? "Nothing to add" : targets.length ? `Add to ${plural(targets.length, "campaign")}` : "Pick campaigns"}
        </Btn>
      </>
    );
  })();

  return (
    <DialogFrame
      open
      // While a campaign is mid-change, Stop is the way out: closing here would hide what it went on to do.
      onClose={running ? () => {} : close}
      width={760}
      title={stage.name === "done" ? "Add inboxes to campaigns: finished" : "Add inboxes to campaigns"}
      description={stage.name === "done" ? undefined : `${plural(selectedRows.length, "inbox", "inboxes")} selected`}
      footer={footer}
    >
      <div data-add-stage={stage.name} style={{ display: "contents" }}>
        {stage.name === "loading" ? <div role="status" className="mut" data-add-progress style={{ padding: "6px 0" }}>Reading your campaigns from EmailBison… Nothing has changed yet.</div> : null}
        {stage.name === "failed" ? <Fail>Couldn&apos;t read the campaigns: {stage.message}</Fail> : null}
        {stage.name === "pick" ? (
          <>
            <Panel style={{ background: "var(--inset)" }}>
              <div className="tnum" data-add-summary>
                {selection.send.length
                  ? <><b>{plural(selection.send.length, "inbox", "inboxes")}</b> will be added to each campaign you pick.</>
                  : <>None of these inboxes is connected to EmailBison, so there&apos;s nothing to add.</>}
              </div>
              {selection.notConnected > 0 ? (
                <div className="mut tnum" data-add-notconnected style={{ fontSize: 12.5, marginTop: 3 }}>
                  {plural(selection.notConnected, "inbox", "inboxes")} that can&apos;t connect {selection.notConnected === 1 ? "is" : "are"} left out: {selection.notConnected === 1 ? "it" : "they"} couldn&apos;t send.
                </div>
              ) : null}
              {selection.instantly > 0 ? (
                <div className="mut tnum" data-add-leftout style={{ fontSize: 12.5, marginTop: 3 }}>{plural(selection.instantly, "Instantly inbox", "Instantly inboxes")} left out: this adds EmailBison inboxes.</div>
              ) : null}
              <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>Inboxes a campaign already has are skipped. Finished and archived campaigns aren&apos;t listed.</div>
            </Panel>

            <div className="an-add-bar">
              <input className="an-add-find" type="search" aria-label="Search campaigns" placeholder="Search campaigns…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="an-add-seg" role="group" aria-label="Status">
                {(["all", "active", "paused", "draft"] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={status === s} data-add-status={s} onClick={() => setStatus(s)}>
                    {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)} <span className="tnum mut">{fullNumber(counts[s])}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="an-add-tools">
              <span className="tnum mut" data-add-picked>{plural(picked.size, "campaign")} picked{targets.length && shown.length < campaigns.length ? ` · ${fullNumber(targets.filter((t) => !shown.includes(t)).length)} not shown` : ""}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="gh" data-add-pick-shown disabled={!shown.length || allShownPicked} onClick={() => pickShown(true)}>
                {shown.length === campaigns.length ? "Select all" : `Select all ${fullNumber(shown.length)} shown`}
              </button>
              <button type="button" className="gh" data-add-clear disabled={!picked.size} onClick={() => setPicked(new Set())}>Clear</button>
            </div>

            <div className="an-rm-list an-add-list" data-add-campaigns>
              <div className="an-rm-row an-add-row an-rm-head" aria-hidden>
                <span />
                <span>Campaign</span>
                <span>Status</span>
                <span className="r">Inboxes now</span>
              </div>
              {shown.length ? shown.map((c) => (
                <label key={c.id} className="an-rm-row an-add-row" data-add-campaign={c.id}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={c.name} style={{ accentColor: "var(--blue)" }} />
                  <span className="an-rm-name" title={c.name}>{c.name}</span>
                  <span><span className={`badge ${STATUS_TONE[c.status] ?? "plan-min"}`}>{c.status}</span></span>
                  <span className="r tnum"><span className="an-rm-tiny">Inboxes now </span>{fullNumber(c.inboxes)}</span>
                </label>
              )) : <div className="mut an-add-none">{campaigns.length ? "No campaign matches." : "There's no open campaign to add to."}</div>}
            </div>
            {activePicked > 0 ? (
              <div className="mut" data-add-active style={{ fontSize: 12.5 }}>
                {plural(activePicked, "active campaign")} picked: {activePicked === 1 ? "it starts" : "they start"} sending from these inboxes straight away. Nothing is paused.
              </div>
            ) : null}
          </>
        ) : null}
        {stage.name === "running" ? <Running targets={stage.targets} results={stage.results} stopping={stopping} /> : null}
        {stage.name === "done" ? <Done targets={stage.targets} results={stage.results} stopped={stage.stopped} /> : null}
      </div>
    </DialogFrame>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <div className="track" aria-hidden>
      <i style={{ width: `${Math.round(Math.min(1, share) * 100)}%`, background: "var(--blue)", transition: "width .25s" }} />
    </div>
  );
}

function resultLine(r: RunResult): string {
  switch (r.outcome) {
    case "added": return `${fullNumber(r.added)} added${r.alreadyOn ? `, ${fullNumber(r.alreadyOn)} already on it` : ""}${r.after === null ? "" : `, ${fullNumber(r.after)} now`}${r.dropped ? ` · ${plural(r.dropped, "inbox", "inboxes")} EmailBison no longer has` : ""}`;
    case "nothing": return "Every one was on it already";
    case "finished": return "Not changed: it has finished";
    case "failed": return `${r.error ?? "It didn't go through"}${r.added > 0 ? ` ${fullNumber(r.added)} did go on.` : ""}`;
  }
}

function ResultRows({ rows, targets }: { rows: RunResult[]; targets: OpenCampaign[] }) {
  const names = new Map(targets.map((t) => [t.id, t.name]));
  return (
    <div className="an-rm-list" data-add-results>
      {rows.map((r) => (
        <div key={r.campaignId} className="an-rm-res" data-rm-result={r.outcome} data-add-result={r.outcome} data-add-campaign={r.campaignId}>
          <span aria-hidden className={`an-rm-mark ${r.ok && r.outcome === "added" ? "ok" : !r.ok ? "bad" : "still"}`}>{r.ok && r.outcome === "added" ? "✓" : !r.ok ? "!" : "–"}</span>
          <span className="an-rm-name" title={r.name || names.get(r.campaignId)}>{r.name || names.get(r.campaignId)}</span>
          <span className="tnum an-rm-out">{resultLine(r)}</span>
        </div>
      ))}
    </div>
  );
}

function Running({ targets, results, stopping }: { targets: OpenCampaign[]; results: RunResult[]; stopping: boolean }) {
  const now = targets.find((t) => !results.some((r) => r.campaignId === t.id));
  return (
    <>
      <div style={{ display: "grid", gap: 10 }}>
        <div role="status" className="tnum" data-add-progress>
          {stopping ? "Stopping after this campaign…" : `Campaign ${fullNumber(Math.min(results.length + 1, targets.length))} of ${fullNumber(targets.length)}`}
          {now ? <span className="mut">: {now.name}</span> : null}
        </div>
        <Bar share={results.length / targets.length} />
      </div>
      {results.length ? <ResultRows rows={[...results].reverse()} targets={targets} /> : null}
    </>
  );
}

function Done({ targets, results, stopped }: { targets: OpenCampaign[]; results: RunResult[]; stopped: boolean }) {
  const added = results.filter((r) => r.ok && r.outcome === "added");
  const already = results.filter((r) => r.ok && r.outcome === "nothing");
  const failed = results.filter((r) => !r.ok);
  const notReached = targets.length - results.length;
  return (
    <>
      <Panel style={{ background: "var(--inset)" }}>
        <div className="tnum" data-add-done>
          Added to <b>{fullNumber(added.length)} of {plural(targets.length, "campaign")}</b>.
          {already.length ? <> {plural(already.length, "campaign")} had every one already.</> : null}
        </div>
        {stopped && notReached > 0 ? <div className="mut tnum" style={{ fontSize: 12.5, marginTop: 3 }}>Stopped: {plural(notReached, "campaign")} not reached, and not changed.</div> : null}
        {added.length ? <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>The Assigned column and Active inboxes catch up within a few minutes.</div> : null}
      </Panel>
      {failed.length ? <Fail>{plural(failed.length, "campaign")} didn&apos;t go through. The reason is beside each one below.</Fail> : null}
      <ResultRows rows={results} targets={targets} />
    </>
  );
}
