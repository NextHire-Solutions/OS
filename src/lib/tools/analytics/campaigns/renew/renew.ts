import { createHash } from "node:crypto";

import { capacityKept, inboxesToAdd, poolNeeded, isConnected, judgeInboxes, pickFromPool, poolRefusal, type InboxJudgement, type PoolPlan, type RecentBounces, type SourceInbox } from "./inbox-health.ts";
import { leadsToTransfer, planLeads, type BusyExample, type CampaignLeadRow, type LeadPlan } from "./leads.ts";
import type { LinkResult, LinkState } from "./links.ts";
import { HIGH_ROUND, nameKey, planNames, searchTermFor, type NamedCampaign, type NamePlan } from "./naming.ts";
import { statusRefusal } from "./status.ts";

/*
 * DUPLICATE & RENEW CAMPAIGN (BrokerStaffer spec, 19 Nov) — the review and the run.
 *
 * One click turns a campaign's round over: the campaign takes the next number
 * ("LIV Indy Realty 6 + …"), and a copy with the original name gets its
 * sequence, settings and schedule (EmailBison's Duplicate carries those —
 * measured), its ZF / NO-ZF tag (Duplicate drops tags — measured), its healthy
 * inboxes, topped up from the wider pool when they cannot cover the campaign's
 * daily limit (inbox-health.ts), its In Sequence leads MOVED and its Sequence
 * Finished leads COPIED (leads.ts). The new campaign is a DRAFT: it sends
 * nothing until someone starts it. The OS's own links follow (links.ts).
 *
 * ORDER, SO A FAILURE NEVER LEAVES A MESS:
 *   1. the copy is made, named, tagged and given its inboxes;
 *   2. Sequence Finished leads are copied — the old campaign is still untouched,
 *      so any failure up to here deletes the copy and stops: nothing changed;
 *   3. In Sequence leads are moved — the first change to the old campaign, and
 *      not undoable, so from here a failure stops and SAYS exactly where things
 *      are, never deletes;
 *   4. only then the old campaign takes its number, and the links follow.
 *
 * THE RUN RE-READS EVERYTHING and refuses if what the review showed — the two
 * names, the tag, the inboxes to add — has changed since (the token). Lead
 * counts may drift (a running campaign keeps sending); they are reported as
 * they turned out.
 *
 * Pure orchestration over injected reads and writes (RenewIO) — the real ones
 * are in io.ts; renew.test.ts runs it all against a fake EmailBison that
 * behaves as the live one was measured to on 19 Nov.
 */

/* ------------------------------------------------------------------------------------------------- types --- */

export interface RenewCampaign {
  id: number;
  name: string;
  status: string;
  tags: Array<{ id: number; name: string }>;
  maxEmailsPerDay: number | null;
  maxNewLeadsPerDay: number | null;
}

export interface RenewSchedule {
  days: string[];
  start: string | null;
  end: string | null;
  timezone: string | null;
}

export interface RenewReads {
  campaign(id: number): Promise<RenewCampaign | null>;
  schedule(id: number): Promise<RenewSchedule | null>;
  /** Every sequence step (versions included). */
  stepCount(id: number): Promise<number>;
  /** Campaigns whose name contains `term` (EmailBison's live search). */
  searchCampaigns(term: string): Promise<NamedCampaign[]>;
  /** Every lead row of the campaign, with each lead's row per campaign. */
  leadRows(id: number): Promise<CampaignLeadRow[]>;
  leadCount(id: number): Promise<number>;
  inboxes(id: number): Promise<SourceInbox[]>;
  inboxCount(id: number): Promise<number>;
  /** Every live inbox in the workspace (the wider pool), from the analytics copy. */
  poolInboxes(): Promise<SourceInbox[]>;
  /** EmailBison's own status for each inbox, read now (a pool pick is checked before it is added). */
  liveInboxStatus(ids: number[]): Promise<Map<number, string | null>>;
  /** Analytics 098; "missing" before it is run. */
  recentBounces(ids: number[]): Promise<RecentBounces[] | "missing">;
  /** EmailBison's warm-up score per inbox over the last WARMUP_WINDOW_DAYS, with the warm-up emails sent then. */
  warmup(): Promise<Map<number, { score: number; sent: number }>>;
  links(id: number): Promise<LinkState>;
  /** The latest renewal of this campaign in the audit log (its rows share a batch id), or null. */
  lastRenewal(sourceId: number): Promise<LastRenewal | null>;
  /** The campaign's client when a person pinned it (analytics campaign_clients, match_method 'manual'); null when automatic. */
  clientPin(campaignId: number): Promise<ClientPin | null>;
  /** Inbox addresses never picked from the pool automatically (the intro sender). */
  reservedInboxEmails(): string[];
}

export interface LastRenewal {
  at: string;
  actor: string;
  /** A "finished" row was written. */
  finished: boolean;
  ok: boolean | null;
  /** The copy it made, when it got that far (and was not deleted again). */
  newCampaignId: number | null;
  rolledBack: boolean;
}

/**
 * A client pinned by hand. Only pins follow the new campaign: the analytics sync works everything else out from the
 * campaign's NAME on every run (its client, and exclusion such as "internal test"), and the new campaign has the
 * same name; a pin is the one thing the sync never recomputes (sync/jobs.ts), so without copying it the new campaign
 * would fall back to the name match the pin was there to correct.
 */
export interface ClientPin {
  clientId: string;
}

export interface RenewWrites {
  /** EmailBison's Duplicate: the new campaign's id. Never retried (a lost answer may have made one). */
  duplicate(id: number): Promise<number>;
  rename(id: number, name: string): Promise<void>;
  tag(campaignId: number, tagIds: number[]): Promise<void>;
  attachInboxes(campaignId: number, inboxIds: number[]): Promise<void>;
  /** "added" or "refused" (EmailBison's 422: every lead is in another sequence, bounced or unsubscribed). Throws otherwise. */
  attachLeads(campaignId: number, leadIds: number[]): Promise<"added" | "refused">;
  /** EmailBison's move with allow_parallel_sending: the lead lands on toId but stays In Sequence on fromId (a copy). */
  moveLeads(fromId: number, toId: number, leadIds: number[]): Promise<void>;
  /** Stops future emails to these leads on this campaign only. */
  stopLeads(campaignId: number, leadIds: number[]): Promise<void>;
  deleteCampaign(id: number): Promise<void>;
  moveLinks(oldId: number, newId: number, newName: string, by: string, state: LinkState): Promise<LinkResult>;
  /** Sets the new campaign's client mapping like the old one's; false while the new campaign is not synced yet. */
  applyClientPin(campaignId: number, pin: ClientPin, fromId: number): Promise<boolean>;
  audit(entry: RenewAudit): Promise<void>;
}

export interface RenewIO extends RenewReads, RenewWrites {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RenewAudit {
  /** "copied": the copy exists (written the moment Duplicate answers, so an interrupted run is never invisible). */
  stage: "started" | "copied" | "finished";
  sourceId: number;
  sourceName: string;
  newCampaignId: number | null;
  ok: boolean;
  actor: string;
  detail: Record<string, unknown>;
  error: string | null;
}

export interface RenewPreview {
  source: { id: number; name: string; status: string; steps: number; tags: string[] };
  names: NamePlan;
  leads: {
    move: number;
    copy: number;
    transfer: number;
    busy: { move: number; copy: number; examples: BusyExample[] };
    left: Record<string, number>;
    total: number;
  };
  inboxes: {
    onSource: number;
    judgement: InboxJudgement | null;
    healthReady: boolean;
    pool: PoolPlan | null;
    /** What the kept inboxes can send a day, against the campaign's own daily limit (the pool makes up any shortfall). */
    capacity: { kept: number; campaignLimit: number | null };
  };
  tag: { ids: number[]; names: string[] };
  schedule: RenewSchedule | null;
  limits: { maxEmailsPerDay: number | null; maxNewLeadsPerDay: number | null };
  links: { ready: boolean; error: string | null; portal: boolean; picks: number; setups: number; clientPinned: boolean };
  /** Why it cannot be run; empty when it can. */
  blockers: string[];
  /** Said in the review, not stopping it. */
  warnings: string[];
  /** What the run must still find: the names, the tag, the inboxes. */
  token: string;
  /**
   * "quick": a check that needs no lead or inbox read already said no (status, an earlier round, no emails, an
   * unfinished renewal), so nothing else was read and the leads/inboxes parts are empty. "full": everything read.
   */
  checked: "quick" | "full";
}

/* --------------------------------------------------------------------------------------------- the review --- */

/** Inbox tags too broad to be a group (every inbox has one of them). */
const GENERIC_TAGS = new Set(["all", "google", "outlook"]);
/** The workspace's tags that mark the copy; carried from the old campaign to the new one. */
const ZF_TAGS = new Set(["zf", "no-zf", "no zf", "nozf"]);

export function zfTags(tags: RenewCampaign["tags"]): RenewCampaign["tags"] {
  return tags.filter((t) => ZF_TAGS.has(t.name.trim().toLowerCase()));
}

interface Loaded {
  preview: RenewPreview;
  plan: LeadPlan | null;
  addIds: number[];
  /** Every pool inbox that may be picked right now (a reviewed pick must still be one at run time). */
  poolEligible: Map<number, SourceInbox>;
  linkState: LinkState;
  pin: ClientPin | null;
}

export function tokenFor(p: Pick<RenewPreview, "source" | "names" | "tag">, addIds: readonly number[]): string {
  const names = p.names.ok ? [p.names.newName, p.names.numberedName] : [p.names.reason];
  const body = JSON.stringify({ s: [p.source.id, p.source.name], names, tag: [...p.tag.ids].sort((a, b) => a - b), inboxes: [...addIds].sort((a, b) => a - b) });
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

const NO_LINKS: LinkState = { ready: true, error: null, portalRoute: null, picks: [], setups: [] };

async function load(sourceId: number, io: RenewReads): Promise<Loaded | { missing: string }> {
  const source = await io.campaign(sourceId);
  if (!source) return { missing: "This campaign was not found in EmailBison." };

  /*
   * THE QUICK CHECKS FIRST (user, 19 Nov: "show if we cannot duplicate and renew any campaign little faster"). They
   * need four small reads — the status, the name search, the step count, the audit log — about a second, where the
   * leads and inboxes take 10-40 s on a big campaign. A campaign they refuse is told so straight away, nothing more read.
   */
  const [steps, siblings, last] = await Promise.all([
    io.stepCount(sourceId),
    io.searchCampaigns(searchTermFor(source.name)),
    io.lastRenewal(sourceId),
  ]);
  const names = planNames({ id: source.id, name: source.name, status: source.status }, siblings.some((c) => c.id === source.id) ? siblings : [...siblings, { id: source.id, name: source.name, status: source.status }]);
  const tags = zfTags(source.tags);
  const status = source.status.trim().toLowerCase();
  const quick: string[] = [];
  const byStatus = statusRefusal(source.status);
  if (byStatus) quick.push(byStatus);
  if (!names.ok) quick.push(names.reason);
  if (steps === 0) quick.push("This campaign has no emails in its sequence.");
  // An earlier renewal that did not finish, and whose copy is still there: never a second copy beside it (review, 19 Nov).
  if (last && last.newCampaignId && !last.rolledBack && (!last.finished || last.ok === false)) {
    const copy = await io.campaign(last.newCampaignId);
    const gone = !copy || /pending deletion|deleted/i.test(copy.status);
    if (!gone) {
      quick.push(
        `A renewal of this campaign started ${last.at.slice(0, 16).replace("T", " ")} UTC by ${last.actor} did not finish, and its copy #${copy!.id} ("${copy!.name}", ${copy!.status}) is still there. ` +
          "Check that copy in EmailBison: finish it by hand, or delete it, before renewing again.",
      );
    }
  }
  if (quick.length) {
    const preview: RenewPreview = {
      source: { id: source.id, name: source.name, status: source.status, steps, tags: source.tags.map((t) => t.name) },
      names,
      leads: { move: 0, copy: 0, transfer: 0, busy: { move: 0, copy: 0, examples: [] }, left: {}, total: 0 },
      inboxes: { onSource: 0, judgement: null, healthReady: true, pool: null, capacity: { kept: 0, campaignLimit: source.maxEmailsPerDay } },
      tag: { ids: tags.map((t) => t.id), names: tags.map((t) => t.name) },
      schedule: null,
      limits: { maxEmailsPerDay: source.maxEmailsPerDay, maxNewLeadsPerDay: source.maxNewLeadsPerDay },
      links: { ready: true, error: null, portal: false, picks: 0, setups: 0, clientPinned: false },
      blockers: quick,
      warnings: [],
      token: "",
      checked: "quick",
    };
    preview.token = tokenFor(preview, []);
    return { preview, plan: null, addIds: [], poolEligible: new Map(), linkState: NO_LINKS, pin: null };
  }

  const [schedule, rows, inboxes, links, pool, pin] = await Promise.all([
    io.schedule(sourceId),
    io.leadRows(sourceId),
    io.inboxes(sourceId),
    io.links(sourceId),
    io.poolInboxes(),
    io.clientPin(sourceId),
  ]);
  const own = new Set(inboxes.map((i) => i.id));
  const askIds = [...new Set([...own, ...pool.map((i) => i.id)])];
  const [rawBounces, warm] = await Promise.all([
    askIds.length ? io.recentBounces(askIds) : Promise.resolve([] as RecentBounces[]),
    io.warmup().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  ]);
  const warmupReady = !(warm instanceof Error);
  // Every inbox gets a row (one with no recent sends has no bounce row), carrying its warm-up score.
  const bounces: RecentBounces[] | "missing" = rawBounces === "missing" ? "missing" : (() => {
    const byId = new Map(rawBounces.map((r) => [Number(r.id), r]));
    return askIds.map((id) => {
      const b = byId.get(id);
      const w = warm instanceof Error ? undefined : warm.get(id);
      return { id, sent: b?.sent ?? 0, bounced: b?.bounced ?? 0, sent24h: b?.sent24h ?? 0, warmupScore: w ? w.score : null, warmupSent: w?.sent ?? 0 };
    });
  })();
  const healthReady = bounces !== "missing" && warmupReady;
  const judgement = healthReady ? judgeInboxes(inboxes, bounces) : null;
  const addIds = judgement ? inboxesToAdd(judgement) : [];
  // The wider pool only makes up what the kept inboxes cannot send of the campaign's own daily limit (the user, 19 Nov).
  // Same-group inboxes first: the old campaign's own inbox groups (its tags, the generic ones aside).
  const groupTags = new Set(inboxes.flatMap((i) => i.tags.map((t) => t.trim().toLowerCase())).filter((t) => t && !GENERIC_TAGS.has(t)));
  const reserved = new Set(io.reservedInboxEmails().map((e) => e.trim().toLowerCase()));
  const poolOptions = { groupTags, reservedEmails: reserved };
  const poolPlan = healthReady && judgement ? pickFromPool(pool, bounces, poolNeeded(judgement, source.maxEmailsPerDay), own, poolOptions) : null;
  const keptCapacity = judgement ? capacityKept(judgement) : 0;
  const poolEligible = new Map<number, SourceInbox>();
  if (healthReady) {
    const byId = new Map(bounces.map((r) => [Number(r.id), r]));
    for (const i of pool) if (!own.has(i.id) && !poolRefusal(i, byId.get(i.id), poolOptions)) poolEligible.set(i.id, i);
  }

  const plan = planLeads(sourceId, rows);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (bounces === "missing") blockers.push("The inbox health check is not switched on yet: it needs the analytics database update 098_os_inbox_recent_bounces.sql to be run.");
  else if (!warmupReady) blockers.push(`EmailBison's warm-up scores could not be read just now, so the inboxes could not be checked. Try again in a minute. (${(warm as Error).message.slice(0, 120)})`);
  if (!links.ready) blockers.push(`The OS links to this campaign (portal choice, Prospects) could not be read, so they could not be kept: ${links.error ?? "unknown error"}.`);
  if (healthReady && inboxes.length && !addIds.length && !poolPlan?.picks.length) blockers.push("None of this campaign's inboxes passes the health check and the wider pool has none to spare, so the new campaign could not send.");
  if (!inboxes.length) blockers.push("This campaign has no inboxes, so there are none to give the new campaign.");
  if (!leadsToTransfer(plan)) blockers.push("No lead is In Sequence or Sequence Finished, so the new campaign would be empty.");

  const orphan = siblings.find((c) => c.id !== source.id && nameKey(c.name) === nameKey(`Copy of ${source.name}`));
  if (orphan) warnings.push(`A campaign named "Copy of ${source.name}" (#${orphan.id}, ${orphan.status ?? "status unknown"}) exists, probably left by an earlier attempt. Delete it if it is not needed.`);
  if (pin) warnings.push("This campaign's client is pinned by hand; the new campaign is pinned to the same client as soon as the analytics sync lists it (within about 30 minutes).");
  if (names.ok && names.round > HIGH_ROUND) warnings.push(`This would be round ${names.round}. Check the earlier rounds listed: a number in another campaign's name may have been read as a round.`);
  if (poolPlan && poolPlan.shortfall > 0) {
    warnings.push(`The kept inboxes can send ${keptCapacity}/day, less than the campaign's ${source.maxEmailsPerDay ?? "?"}/day, and the wider pool has healthy inboxes for only ${poolPlan.added}/day more.`);
  }
  if (!tags.length) warnings.push("The old campaign has no ZF or NO-ZF tag, so the new one gets none.");
  if (tags.length > 1) warnings.push(`The old campaign has both ${tags.map((t) => t.name).join(" and ")}; the new one gets both.`);
  if (names.ok && names.sameName.length) {
    warnings.push(`${names.sameName.map((c) => `#${c.id}${c.status ? ` (${c.status})` : ""}`).join(", ")} also ${names.sameName.length === 1 ? "has" : "have"} this exact name and ${names.sameName.length === 1 ? "is" : "are"} left as ${names.sameName.length === 1 ? "it is" : "they are"}.`);
  }
  if (plan.busy.move + plan.busy.copy) {
    const n = plan.busy.move + plan.busy.copy;
    warnings.push(`${n} of these lead${n === 1 ? " is" : "s are"} also being emailed by another campaign right now. ${n === 1 ? "It is" : "They are"} added anyway, so ${n === 1 ? "it gets" : "they get"} both sequences until one of them ends.`);
  }
  if (status === "active" && plan.move.length) {
    warnings.push(`This campaign is still sending: its ${plan.move.length} In Sequence lead${plan.move.length === 1 ? "" : "s"} stop here and start again from the first email on the new campaign once it is started.`);
  }

  const preview: RenewPreview = {
    source: { id: source.id, name: source.name, status: source.status, steps, tags: source.tags.map((t) => t.name) },
    names,
    leads: { move: plan.move.length, copy: plan.copy.length, transfer: leadsToTransfer(plan), busy: plan.busy, left: plan.left, total: plan.total },
    inboxes: { onSource: inboxes.length, judgement, healthReady, pool: poolPlan, capacity: { kept: keptCapacity, campaignLimit: source.maxEmailsPerDay } },
    tag: { ids: tags.map((t) => t.id), names: tags.map((t) => t.name) },
    schedule,
    limits: { maxEmailsPerDay: source.maxEmailsPerDay, maxNewLeadsPerDay: source.maxNewLeadsPerDay },
    links: { ready: links.ready, error: links.error, portal: !!links.portalRoute, picks: links.picks.length, setups: links.setups.length, clientPinned: !!pin },
    blockers,
    warnings,
    token: "",
    checked: "full",
  };
  preview.token = tokenFor(preview, addIds);
  return { preview, plan, addIds, poolEligible, linkState: links, pin };
}

export async function previewRenew(sourceId: number, io: RenewReads): Promise<RenewPreview | { error: string }> {
  const loaded = await load(sourceId, io);
  if ("missing" in loaded) return { error: loaded.missing };
  return loaded.preview;
}

/* ------------------------------------------------------------------------------------------------ the run --- */

export type RenewStage = "checking" | "copying" | "naming" | "tagging" | "inboxes" | "copying-leads" | "moving-leads" | "waiting" | "stopping-old" | "renaming-old" | "links" | "done";

export interface RenewResult {
  ok: boolean;
  stage: RenewStage;
  sourceId: number;
  oldName: string;
  numberedName: string | null;
  newCampaignId: number | null;
  newName: string | null;
  /** True when the copy was deleted again because a step before any lead moved failed. */
  rolledBack: boolean;
  inboxesAdded: number;
  /** Pool inboxes: asked for in the review, added, and dropped (no longer healthy, connected or with capacity). */
  pool: { asked: number; added: number; dropped: Array<{ id: number; email: string | null; why: string }> };
  tags: string[];
  leads: {
    planned: { move: number; copy: number };
    copied: number;
    moved: number;
    /** Copies EmailBison refused (another sequence, bounced or unsubscribed since the review). */
    copyRefused: number;
    /** Moved leads not on the new campaign when the run finished, and not taken by another campaign: still arriving. */
    notArrived: Array<{ id: number; email: string | null }>;
    /**
     * Moved leads NOT on the new campaign when the run finished that another campaign is emailing: stopped here, not
     * added there (yet). Not lost from sending — the other campaign still emails them — but not where they were meant to
     * go: named so they can be added by hand. The move says allow_parallel_sending, so this should not happen.
     */
    lost: Array<{ id: number; email: string | null; campaignIds: number[] }>;
    /** Left out at the moment of the move: no longer In Sequence here since the review (replied, stopped…). */
    skippedAtMove: number;
    /** Moved leads stopped on the old campaign once they were on the new one (the move itself leaves them there). */
    stoppedOnOld: number;
    busy: number;
  };
  /** The client mapping the new campaign is still to be given (once synced): the job keeps trying. */
  pinPending: ClientPin | null;
  links: LinkResult | null;
  /** The old campaign took its number. */
  oldRenamed: boolean;
  warnings: string[];
  error: string | null;
}

export type Progress = (stage: RenewStage, line: string) => void;

const CHUNK_INBOXES = 250;
const CHUNK_LEADS = 500;
/** How long a move into the copy is waited for before saying it is still arriving. */
const MOVE_WAIT_MS = 8 * 60_000;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runRenew(sourceId: number, token: string, poolIds: readonly number[], actor: string, io: RenewIO, progress: Progress = () => {}): Promise<RenewResult> {
  const result: RenewResult = {
    ok: false, stage: "checking", sourceId, oldName: "", numberedName: null, newCampaignId: null, newName: null, rolledBack: false,
    inboxesAdded: 0, pool: { asked: 0, added: 0, dropped: [] }, tags: [],
    leads: { planned: { move: 0, copy: 0 }, copied: 0, moved: 0, copyRefused: 0, notArrived: [], lost: [], skippedAtMove: 0, stoppedOnOld: 0, busy: 0 },
    pinPending: null, links: null, oldRenamed: false, warnings: [], error: null,
  };
  const step = (stage: RenewStage, line: string) => { result.stage = stage; progress(stage, line); };

  step("checking", "Reading the campaign again and checking nothing changed since the review…");
  const loaded = await load(sourceId, io);
  if ("missing" in loaded) { result.error = loaded.missing; return result; }
  const { preview, plan, addIds, poolEligible, linkState, pin } = loaded;
  result.oldName = preview.source.name;
  if (preview.blockers.length) { result.error = preview.blockers.join(" "); return result; }
  if (preview.token !== token) {
    result.error = "Something changed since the review (a name, the tag or the inboxes). Nothing was done: open Duplicate & Renew again to see it as it is now.";
    return result;
  }
  if (!preview.names.ok || !plan) { result.error = "The names could not be worked out."; return result; }
  const names = preview.names;
  result.numberedName = names.numberedName;
  result.newName = names.newName;
  result.leads.planned = { move: plan.move.length, copy: plan.copy.length };
  result.leads.busy = plan.busy.move + plan.busy.copy;
  result.warnings = [...preview.warnings];

  // The pool inboxes the review showed, each still healthy, connected and with capacity — checked again now.
  const asked = [...new Set(poolIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  result.pool.asked = asked.length;
  const stillOk = asked.filter((id) => poolEligible.has(id));
  for (const id of asked) if (!poolEligible.has(id)) result.pool.dropped.push({ id, email: null, why: "no longer healthy, connected or with capacity to spare" });
  let poolAdd: number[] = [];
  if (stillOk.length) {
    const live = await io.liveInboxStatus(stillOk);
    for (const id of stillOk) {
      if (isConnected(live.get(id))) poolAdd.push(id);
      else result.pool.dropped.push({ id, email: poolEligible.get(id)?.email ?? null, why: `${live.get(id) ?? "no status"} in EmailBison now` });
    }
  }
  if (result.pool.dropped.length) result.warnings.push(`${result.pool.dropped.length} pool inbox${result.pool.dropped.length === 1 ? " was" : "es were"} left out at the last check: ${result.pool.dropped.slice(0, 5).map((d) => d.email ?? `#${d.id}`).join(", ")}.`);
  poolAdd = poolAdd.filter((id) => !addIds.includes(id));

  const audit = async (stage: RenewAudit["stage"]) => {
    try {
      await io.audit({
        // Only the finished row carries the outcome; "started" and "copied" are steps, not results.
        stage, sourceId, sourceName: preview.source.name, newCampaignId: result.newCampaignId, ok: stage === "finished" ? result.ok : true, actor, error: result.error,
        detail: {
          stage: result.stage, numberedName: names.numberedName, newName: names.newName, inboxesAdded: result.inboxesAdded, tags: result.tags,
          leads: { ...result.leads, notArrived: result.leads.notArrived.length, lost: result.leads.lost.map((l) => l.id) },
          links: result.links, oldRenamed: result.oldRenamed, rolledBack: result.rolledBack, pinPending: !!result.pinPending,
        },
      });
    } catch { /* the audit row never decides the outcome */ }
  };
  await audit("started");

  // Before any lead moves, a failure deletes the copy: nothing at all has changed.
  const undo = async (stage: RenewStage, error: unknown) => {
    result.stage = stage;
    result.error = errText(error);
    if (result.newCampaignId) {
      try {
        await io.deleteCampaign(result.newCampaignId);
        result.rolledBack = true;
        result.error += " The copy was deleted again, so nothing changed.";
        result.newCampaignId = null;
      } catch (e) {
        result.error += ` The copy (#${result.newCampaignId}) could not be deleted (${errText(e)}): delete it in EmailBison.`;
      }
    } else if (stage === "copying") {
      result.error += ` If EmailBison made the copy before its answer was lost, a draft named "Copy of ${preview.source.name}" may exist: delete it.`;
    }
    await audit("finished");
    return result;
  };

  try {
    step("copying", "Copying the campaign (emails, settings, schedule)…");
    result.newCampaignId = await io.duplicate(sourceId);
    await audit("copied");
    const steps = await io.stepCount(result.newCampaignId);
    if (steps !== preview.source.steps) throw new Error(`The copy has ${steps} sequence steps, the campaign has ${preview.source.steps}.`);

    step("naming", `Naming the copy "${names.newName}"…`);
    await io.rename(result.newCampaignId, names.newName);

    if (preview.tag.ids.length) {
      step("tagging", `Tagging it ${preview.tag.names.join(" and ")}…`);
      await io.tag(result.newCampaignId, preview.tag.ids);
      result.tags = preview.tag.names;
    }

    const allInboxes = [...addIds, ...poolAdd];
    step("inboxes", `Adding ${allInboxes.length} healthy inbox${allInboxes.length === 1 ? "" : "es"}${poolAdd.length ? ` (${poolAdd.length} from the wider pool)` : ""}…`);
    for (const part of chunks(allInboxes, CHUNK_INBOXES)) await io.attachInboxes(result.newCampaignId, part);
    result.inboxesAdded = await io.inboxCount(result.newCampaignId);
    if (result.inboxesAdded < allInboxes.length) throw new Error(`Only ${result.inboxesAdded} of ${allInboxes.length} inboxes are on the copy.`);
    result.pool.added = poolAdd.length;

    step("copying-leads", `Copying ${plan.copy.length} Sequence Finished lead${plan.copy.length === 1 ? "" : "s"}…`);
    const before = await io.leadCount(result.newCampaignId);
    for (const part of chunks(plan.copy, CHUNK_LEADS)) {
      if ((await io.attachLeads(result.newCampaignId, part)) === "refused") result.leads.copyRefused += part.length;
    }
    result.leads.copied = Math.max(0, (await io.leadCount(result.newCampaignId)) - before);
    result.leads.copyRefused = Math.max(result.leads.copyRefused, plan.copy.length - result.leads.copied);
  } catch (e) {
    return undo(result.stage, e);
  }

  // From here the old campaign changes: never deleted on failure, always told exactly.
  const newId = result.newCampaignId!;
  let toMove: number[] = [];
  let sent = 0;
  try {
    if (plan.move.length) {
      // Checked AGAIN at the moment of the move: only leads still In Sequence here are moved (one that replied or was
      // stopped since the review stays). Another campaign emailing it does not matter: the move says allow_parallel_sending.
      step("moving-leads", "Checking each lead is still In Sequence…");
      const fresh = planLeads(sourceId, await io.leadRows(sourceId));
      const freeNow = new Set(fresh.move);
      toMove = plan.move.filter((id) => freeNow.has(id));
      result.leads.skippedAtMove = plan.move.length - toMove.length;
      if (result.leads.skippedAtMove) {
        result.warnings.push(`${result.leads.skippedAtMove} lead${result.leads.skippedAtMove === 1 ? " was" : "s were"} left on the old campaign at the last check: no longer In Sequence there (replied or stopped since the review).`);
      }
      step("moving-leads", `Moving ${toMove.length} In Sequence lead${toMove.length === 1 ? "" : "s"}…`);
      for (const part of chunks(toMove, CHUNK_LEADS)) {
        await io.moveLeads(sourceId, newId, part);
        sent += part.length;
      }

      step("waiting", "Waiting for EmailBison to finish the move…");
      const expected = result.leads.copied + toMove.length;
      const deadline = io.now() + MOVE_WAIT_MS;
      let count = await io.leadCount(newId);
      let steady = 0;
      while (count < expected && io.now() < deadline) {
        await io.sleep(10_000);
        const next = await io.leadCount(newId);
        steady = next === count ? steady + 1 : 0;
        count = next;
        if (steady >= 6) break; // a minute without change: it has done what it will do
      }
      // Which moved leads are on the copy: read its leads and compare, lead by lead.
      const onCopy = new Set((await io.leadRows(newId)).map((r) => Number(r.id)));
      const arrived = toMove.filter((id) => onCopy.has(id));
      const missing = toMove.filter((id) => !onCopy.has(id));
      result.leads.moved = arrived.length;

      /*
       * THE MOVE IS A COPY WITH allow_parallel_sending (measured 19 Nov: the lead lands on the new campaign and stays In
       * Sequence on the old one). So the old campaign is told to stop emailing exactly the leads that ARRIVED — never one
       * that did not, which keeps its old sequence rather than dropping out of both. Checked by reading the old campaign
       * again; one more stop for any still going; if the old campaign is still emailing some after that, the run stops
       * here (before the old campaign is renamed) and names them.
       */
      const IN_SEQ = new Set(["in_sequence", "sending_paused"]);
      const stillOnOld = (rows: CampaignLeadRow[], ids: readonly number[]) => {
        const want = new Set(ids);
        return rows.filter((r) => want.has(Number(r.id)) && IN_SEQ.has(String((r.lead_campaign_data ?? []).find((d) => Number(d.campaign_id) === sourceId)?.status ?? "").trim().toLowerCase()));
      };
      let rowsNow: CampaignLeadRow[] = [];
      if (arrived.length) {
        step("stopping-old", `Stopping the ${arrived.length} moved lead${arrived.length === 1 ? "" : "s"} on the old campaign…`);
        for (const part of chunks(arrived, CHUNK_LEADS)) await io.stopLeads(sourceId, part);
        await io.sleep(10_000);
        rowsNow = await io.leadRows(sourceId);
        let still = stillOnOld(rowsNow, arrived);
        if (still.length) {
          for (const part of chunks(still.map((r) => Number(r.id)), CHUNK_LEADS)) await io.stopLeads(sourceId, part);
          await io.sleep(15_000);
          rowsNow = await io.leadRows(sourceId);
          still = stillOnOld(rowsNow, arrived);
        }
        result.leads.stoppedOnOld = arrived.length - still.length;
        if (still.length) {
          throw new Error(
            `${still.length} moved lead${still.length === 1 ? " is" : "s are"} on the new campaign but the old campaign is still emailing ${still.length === 1 ? "it" : "them"}` +
              ` (${still.slice(0, 5).map((r) => r.email ?? `#${r.id}`).join(", ")}${still.length > 5 ? "…" : ""}): stop ${still.length === 1 ? "it" : "them"} on the old campaign in EmailBison.`,
          );
        }
      }
      if (missing.length) {
        // Not on the new campaign: still arriving, or (another campaign emailing it) not added. Never stopped on the old one.
        if (!rowsNow.length) rowsNow = await io.leadRows(sourceId);
        const byId = new Map(rowsNow.map((r) => [Number(r.id), r]));
        for (const id of missing) {
          const r = byId.get(id);
          const elsewhere = (r?.lead_campaign_data ?? [])
            .filter((d) => ![sourceId, newId].includes(Number(d.campaign_id)) && String(d.status ?? "").trim().toLowerCase() === "in_sequence")
            .map((d) => Number(d.campaign_id));
          if (elsewhere.length) result.leads.lost.push({ id, email: r?.email ?? null, campaignIds: elsewhere });
          else result.leads.notArrived.push({ id, email: r?.email ?? null });
        }
      }
    }

    step("renaming-old", `Renaming the old campaign "${names.numberedName}"…`);
    await io.rename(sourceId, names.numberedName);
    result.oldRenamed = true;

    step("links", "Pointing the OS's portal choice and Prospects at the new campaign…");
    result.links = await io.moveLinks(sourceId, newId, names.newName, actor, linkState);
    if (result.links.errors.length) result.warnings.push(...result.links.errors);
    if (result.leads.notArrived.length) {
      result.warnings.push(`${result.leads.notArrived.length} moved lead${result.leads.notArrived.length === 1 ? " is" : "s are"} not on the new campaign yet. EmailBison may still be moving ${result.leads.notArrived.length === 1 ? "it" : "them"}; check the new campaign's leads in a few minutes.`);
    }
    if (pin) {
      step("links", "Giving the new campaign the old one's client setting…");
      let applied = false;
      try { applied = await io.applyClientPin(newId, pin, sourceId); } catch { applied = false; }
      if (!applied) result.pinPending = pin;
    }
    result.ok = true;
    step("done", "Done. The new campaign is a draft and sends nothing until it is started.");
  } catch (e) {
    // What the move actually did, read from the copy itself (never a count of what was asked for).
    if (toMove.length && !result.leads.moved) {
      try {
        const onCopy = new Set((await io.leadRows(newId)).map((r) => Number(r.id)));
        result.leads.moved = toMove.filter((id) => onCopy.has(id)).length;
      } catch { /* told as unknown below */ }
    }
    const moved = toMove.length
      ? ` ${result.leads.moved} of ${toMove.length} In Sequence leads are on it (${sent} were sent to EmailBison's move; ${result.leads.stoppedOnOld} stopped on the old campaign).`
      : "";
    result.error = `${errText(e)} The new campaign (#${newId}) exists with what was done so far; nothing was undone.${moved}${result.oldRenamed ? "" : " The old campaign was NOT renamed."}`;
  }
  await audit("finished");
  return result;
}
