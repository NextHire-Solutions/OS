import { test } from "node:test";
import assert from "node:assert/strict";

import type { RecentBounces, SourceInbox } from "./inbox-health.ts";
import type { CampaignLeadRow } from "./leads.ts";
import { moveLinks, type LinkState, type LinkStore } from "./links.ts";
import { startRenewJob, getJob } from "./jobs.ts";
import { previewRenew, runRenew, type ClientPin, type LastRenewal, type RenewAudit, type RenewIO } from "./renew.ts";

/*
 * A fake EmailBison that behaves as the live one was MEASURED to on 19 Nov
 * (throwaway campaigns 1304-1312):
 *   - Duplicate makes a draft "Copy of …" with the sequence, settings and schedule, and no tags, inboxes or leads;
 *   - a lead on a running campaign or a DRAFT reads in_sequence there; on a paused one, sending_paused;
 *   - renew always sends allow_parallel_sending (io.ts), so attach adds a lead another campaign is emailing and refuses
 *     only a dead lead; when it adds none it answers 422 "No leads were added …";
 *   - Move WITH the option (what renew sends) adds the lead to the new campaign and LEAVES it In Sequence on the old one
 *     (a copy; still there 4 minutes later); stop-future-emails then stops it there (stopped_manually).
 *   - Move WITHOUT the option stops the lead on the old campaign (stopped_moved_another_campaign) and adds it to the new
 *     one, except a lead In Sequence on a third campaign: stopped and NOT added. `ignoresParallel` makes this fake
 *     behave so, to prove the run names such a lead rather than hiding it.
 */

type St = "in_sequence" | "sending_paused" | "sequence_finished" | "stopped" | "replied";
interface FCampaign { id: number; name: string; status: string; tags: Array<{ id: number; name: string }>; steps: number; maxE: number; maxN: number; inboxes: Set<number>; leads: Map<number, { status: St; reason: string | null }> }

class World {
  campaigns = new Map<number, FCampaign>();
  leads = new Map<number, { email: string; status: string }>();
  inboxes = new Map<number, SourceInbox>();
  bounces: Map<number, RecentBounces> | "missing" = new Map();
  links: LinkState = { ready: true, error: null, portalRoute: { osClientId: "c1", miClientId: "p1", source: "manual" }, picks: [{ osClientId: "c1", mlsCode: "" }], setups: [] };
  nextId = 2000;
  writes: string[] = [];
  audits: RenewAudit[] = [];
  /** Throw on the nth call of a write (name → { at, error }). */
  fail: Record<string, { at: number; error: Error }> = {};
  counts: Record<string, number> = {};
  /** EmailBison ignoring allow_parallel_sending (never seen): a busy lead is then refused / dropped by a move. */
  ignoresParallel = false;
  /** stop-future-emails answering ok but changing nothing (never seen): the run must notice. */
  stopIgnored = false;
  /** Moves land only after this many lead-count reads (EmailBison: "may take a few minutes"). */
  moveDelayReads = 0;
  pendingMoves: Array<{ to: number; id: number }> = [];
  clock = 0;

  campaign(o: Partial<FCampaign> & { id: number; name: string }): FCampaign {
    const c: FCampaign = { status: "active", tags: [], steps: 3, maxE: 3000, maxN: 1500, inboxes: new Set(), leads: new Map(), ...o };
    this.campaigns.set(c.id, c);
    return c;
  }
  lead(id: number, onto: Array<[number, St]>, status = "unverified") {
    this.leads.set(id, { email: `l${id}@x.com`, status });
    for (const [cid, st] of onto) this.campaigns.get(cid)!.leads.set(id, { status: st, reason: null });
  }
  inbox(id: number, o: Partial<SourceInbox> = {}, attempts = 0, bounced = 0, sent24h = 0) {
    this.inboxes.set(id, { id, email: `i${id}@send.com`, status: "Connected", tags: [], dailyLimit: 25, ...o });
    if (this.bounces !== "missing") this.bounces.set(id, { id, sent: attempts - bounced, bounced, sent24h });
  }
  /** EmailBison's status read live at run time, when it differs from the analytics copy. */
  liveStatus = new Map<number, string>();
  /** The slow reads (every lead, every inbox, the pool) the review made: none when a quick check already refused. */
  heavyReads: string[] = [];
  /** The old campaign's hand-set client mapping, and whether the new campaign is synced (its row exists) yet. */
  pin: ClientPin | null = null;
  pinRowsFor = new Set<number>();
  pinsApplied: Array<{ id: number; pin: ClientPin }> = [];
  /** The latest renewal as the audit log would show it: derived from the audit rows this fake recorded. */
  lastRenewal(sourceId: number): LastRenewal | null {
    const rows = this.audits.filter((a) => a.sourceId === sourceId);
    const startAt = rows.map((a) => a.stage).lastIndexOf("started");
    if (startAt === -1) return null;
    const run = rows.slice(startAt);
    const copied = run.find((a) => a.stage === "copied");
    const finished = run.find((a) => a.stage === "finished");
    return {
      at: "2026-11-19T16:00:00Z", actor: run[0].actor, finished: !!finished, ok: finished ? finished.ok : null,
      newCampaignId: finished ? finished.newCampaignId : copied?.newCampaignId ?? null,
      rolledBack: finished ? finished.detail.rolledBack === true : false,
    };
  }
  private hit(name: string) {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const f = this.fail[name];
    if (f && this.counts[name] === f.at) throw f.error;
  }
  /** Is the lead being sent a sequence by a campaign other than `except` (running or draft; paused doesn't count)? */
  busyElsewhere(leadId: number, except: number[]): boolean {
    for (const c of this.campaigns.values()) {
      if (except.includes(c.id)) continue;
      const m = c.leads.get(leadId);
      if (m && m.status === "in_sequence") return true;
    }
    return false;
  }
  rows(cid: number): CampaignLeadRow[] {
    const c = this.campaigns.get(cid)!;
    return [...c.leads.keys()].map((id) => ({
      id, email: this.leads.get(id)!.email, status: this.leads.get(id)!.status,
      lead_campaign_data: [...this.campaigns.values()].filter((x) => x.leads.has(id)).map((x) => ({ campaign_id: x.id, status: x.leads.get(id)!.status, status_reason: x.leads.get(id)!.reason })),
    }));
  }
  landMoves() { for (const m of this.pendingMoves) this.campaigns.get(m.to)!.leads.set(m.id, { status: "in_sequence", reason: null }); this.pendingMoves = []; }

  io(): RenewIO {
    const w = this;
    const store: LinkStore = {
      route: async () => w.links.portalRoute,
      saveRoute: async (cid) => { w.writes.push(`route ${cid}`); },
      picks: async () => [],
      setPick: async (_c, _m, from, to) => { w.writes.push(`pick ${from}->${to}`); return true; },
      setups: async () => [],
      setSetup: async (_c, _m, from, to) => { w.writes.push(`setup ${from}->${to}`); return true; },
    };
    return {
      campaign: async (id) => { const c = w.campaigns.get(id); return c ? { id: c.id, name: c.name, status: c.status, tags: c.tags, maxEmailsPerDay: c.maxE, maxNewLeadsPerDay: c.maxN } : null; },
      schedule: async () => ({ days: ["monday", "tuesday"], start: "08:00", end: "17:00", timezone: "America/New_York" }),
      stepCount: async (id) => w.campaigns.get(id)?.steps ?? 0,
      searchCampaigns: async (term) => [...w.campaigns.values()].filter((c) => c.name.includes(term)).map((c) => ({ id: c.id, name: c.name, status: c.status })),
      leadRows: async (id) => { w.heavyReads.push(`leadRows ${id}`); return w.rows(id); },
      leadCount: async (id) => { if (w.pendingMoves.length && --w.moveDelayReads <= 0) w.landMoves(); return w.campaigns.get(id)?.leads.size ?? 0; },
      inboxes: async (id) => { w.heavyReads.push(`inboxes ${id}`); return [...(w.campaigns.get(id)?.inboxes ?? [])].map((i) => w.inboxes.get(i)!); },
      inboxCount: async (id) => w.campaigns.get(id)?.inboxes.size ?? 0,
      poolInboxes: async () => { w.heavyReads.push("pool"); return [...w.inboxes.values()]; },
      liveInboxStatus: async (ids) => new Map(ids.map((i) => [i, w.liveStatus.get(i) ?? w.inboxes.get(i)?.status ?? null])),
      recentBounces: async (ids) => (w.bounces === "missing" ? "missing" : ids.map((i) => (w.bounces as Map<number, RecentBounces>).get(i) ?? { id: i, sent: 0, bounced: 0 })),
      links: async () => w.links,
      lastRenewal: async (id) => w.lastRenewal(id),
      clientPin: async () => w.pin,
      reservedInboxEmails: () => ["nicole.c@brokerstaffer.com"],
      applyClientPin: async (id, pin) => { if (!w.pinRowsFor.has(id)) return false; w.pinsApplied.push({ id, pin }); return true; },
      duplicate: async (id) => {
        w.hit("duplicate");
        const src = w.campaigns.get(id)!;
        const c = w.campaign({ id: w.nextId++, name: `Copy of ${src.name}`, status: "draft", steps: src.steps, maxE: src.maxE, maxN: src.maxN });
        w.writes.push(`duplicate ${id} -> ${c.id}`);
        return c.id;
      },
      rename: async (id, name) => { w.hit("rename"); w.campaigns.get(id)!.name = name; w.writes.push(`rename ${id} "${name}"`); },
      tag: async (id, tagIds) => { w.hit("tag"); for (const t of tagIds) w.campaigns.get(id)!.tags.push({ id: t, name: t === 100 ? "ZF" : t === 101 ? "NO-ZF" : String(t) }); w.writes.push(`tag ${id} ${tagIds}`); },
      attachInboxes: async (id, ids) => { w.hit("attachInboxes"); for (const i of ids) w.campaigns.get(id)!.inboxes.add(i); w.writes.push(`inboxes ${id} +${ids.length}`); },
      attachLeads: async (id, ids) => {
        w.hit("attachLeads");
        const c = w.campaigns.get(id)!;
        let added = 0;
        for (const l of ids) {
          if (["bounced", "unsubscribed"].includes(w.leads.get(l)!.status) || (w.ignoresParallel && w.busyElsewhere(l, [id])) || c.leads.has(l)) continue;
          c.leads.set(l, { status: c.status === "paused" ? "sending_paused" : "in_sequence", reason: null });
          added++;
        }
        w.writes.push(`attach ${id} ${added}/${ids.length}`);
        return added ? "added" : "refused";
      },
      moveLeads: async (from, to, ids) => {
        w.hit("moveLeads");
        for (const l of ids) {
          const m = w.campaigns.get(from)!.leads.get(l);
          if (!m) continue;
          if (w.ignoresParallel) {
            // as without the option: stopped here; and a lead another campaign is emailing is never added there
            m.status = "stopped";
            m.reason = "stopped_moved_another_campaign";
            if (w.busyElsewhere(l, [from, to])) continue;
          } // with the option (what renew sends): the old row is left as it is — a copy
          if (w.moveDelayReads > 0) w.pendingMoves.push({ to, id: l });
          else w.campaigns.get(to)!.leads.set(l, { status: "in_sequence", reason: null });
        }
        w.writes.push(`move ${from}->${to} ${ids.length}`);
      },
      stopLeads: async (id, ids) => {
        w.hit("stopLeads");
        w.writes.push(`stop ${id} ${ids.length}`);
        if (w.stopIgnored) return;
        for (const l of ids) {
          const m = w.campaigns.get(id)!.leads.get(l);
          if (m && (m.status === "in_sequence" || m.status === "sending_paused")) { m.status = "stopped"; m.reason = "stopped_manually"; }
        }
      },
      deleteCampaign: async (id) => { w.hit("deleteCampaign"); w.campaigns.delete(id); w.writes.push(`delete ${id}`); },
      moveLinks: (oldId, newId, newName, by, state) => moveLinks(oldId, newId, newName, by, state, store),
      audit: async (a) => { w.audits.push(a); },
      sleep: async (ms) => { w.clock += ms; },
      now: () => w.clock,
    };
  }
}

const OLD = 1277;
const NAME = "LIV Indy Realty + Indianapolis Metro + ZF NS4 (EST)";

/** LIV Indy as it stood on 19 Nov, in miniature: five earlier rounds, a running round, healthy and unhealthy inboxes. */
function liv() {
  const w = new World();
  for (let r = 1; r <= 5; r++) w.campaign({ id: 380 + r, name: `LIV Indy Realty ${r} + Indianapolis Metro + ZF NS4 (EST)`, status: "completed" });
  w.campaign({ id: 262, name: "LIV Indy Realty 1 + Indianapolis Metro + ZF NS1 (EST)", status: "completed" });
  const old = w.campaign({ id: OLD, name: NAME, status: "active", tags: [{ id: 100, name: "ZF" }, { id: 107, name: "COPY" }] });
  const other = w.campaign({ id: 900, name: "Other client + X", status: "active" });
  void other;
  w.inbox(1, {}, 500, 2); // 0.4% healthy
  w.inbox(2, {}, 40, 30); // too little to judge: added
  w.inbox(3, {}, 200, 6); // 3% warning
  w.inbox(4, {}, 200, 20); // 10% left out
  w.inbox(5, { status: "Not connected" }); // left out
  for (const i of [1, 2, 3, 4, 5]) old.inboxes.add(i);
  w.lead(11, [[OLD, "in_sequence"]]);
  w.lead(12, [[OLD, "in_sequence"]]);
  w.lead(13, [[OLD, "in_sequence"], [900, "in_sequence"]]); // busy elsewhere: must never be moved
  w.lead(21, [[OLD, "sequence_finished"]]);
  w.lead(22, [[OLD, "sequence_finished"], [385, "sequence_finished"]]);
  w.lead(23, [[OLD, "sequence_finished"], [900, "in_sequence"]]); // busy elsewhere: copy refused, left out up front
  w.lead(31, [[OLD, "replied"]]);
  w.lead(32, [[OLD, "stopped"]]);
  w.lead(33, [[OLD, "in_sequence"]], "bounced");
  return w;
}

test("review: every item the spec asks for, from the real-shaped campaign", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  assert.ok(!("error" in p));
  if ("error" in p) return;
  assert.deepEqual(p.blockers, []);
  assert.ok(p.names.ok);
  if (!p.names.ok) return;
  assert.equal(p.names.numberedName, "LIV Indy Realty 6 + Indianapolis Metro + ZF NS4 (EST)");
  assert.equal(p.names.newName, NAME);
  assert.deepEqual({ move: p.leads.move, copy: p.leads.copy, transfer: p.leads.transfer }, { move: 3, copy: 3, transfer: 6 }, "the busy ones (13, 23) included");
  assert.deepEqual({ move: p.leads.busy.move, copy: p.leads.busy.copy }, { move: 1, copy: 1 });
  assert.deepEqual(p.leads.left, { replied: 1, stopped: 1, bounced: 1 });
  const j = p.inboxes.judgement!;
  assert.deepEqual(j.add.map((v) => v.id).sort(), [1, 2]);
  assert.deepEqual(j.warn.map((v) => v.id), [3]);
  assert.deepEqual(j.leave.map((v) => v.id), [4, 5]);
  assert.deepEqual(p.tag.names, ["ZF"], "ZF only; the COPY tag is not carried");
  assert.deepEqual(p.limits, { maxEmailsPerDay: 3000, maxNewLeadsPerDay: 1500 });
  assert.deepEqual(p.schedule?.days, ["monday", "tuesday"]);
  assert.deepEqual({ portal: p.links.portal, picks: p.links.picks }, { portal: true, picks: 1 });
  assert.ok(p.warnings.some((x) => /2 of these leads are also being emailed by another campaign right now\. They are added anyway/.test(x)));
  assert.ok(p.warnings.some((x) => /still sending/.test(x)));
  assert.match(p.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(w.writes, [], "the review writes nothing");
});

test("run: the whole renewal, in order, and the old campaign's history kept", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const lines: string[] = [];
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io(), (_s, l) => lines.push(l));
  assert.equal(r.ok, true, r.error ?? "");
  const NEW = r.newCampaignId!;
  const copy = w.campaigns.get(NEW)!;
  const old = w.campaigns.get(OLD)!;
  // names
  assert.equal(copy.name, NAME);
  assert.equal(old.name, "LIV Indy Realty 6 + Indianapolis Metro + ZF NS4 (EST)");
  assert.equal(copy.status, "draft", "never started");
  // tag, inboxes
  assert.deepEqual(copy.tags.map((t) => t.name), ["ZF"]);
  assert.deepEqual([...copy.inboxes].sort(), [1, 2, 3]);
  assert.equal(r.inboxesAdded, 3);
  // leads: 3 moved, 3 copied — the ones another campaign is emailing (13, 23) included
  assert.deepEqual([...copy.leads.keys()].sort(), [11, 12, 13, 21, 22, 23]);
  assert.equal(r.leads.moved, 3);
  assert.equal(r.leads.copied, 3);
  assert.deepEqual(r.leads.notArrived, []);
  assert.equal(old.leads.get(11)!.reason, "stopped_manually", "moved: stopped on the old one once on the new one, row kept");
  assert.equal(r.leads.stoppedOnOld, 3);
  assert.equal(old.leads.get(21)!.status, "sequence_finished", "copied: still finished on the old one");
  assert.equal(old.leads.get(13)!.reason, "stopped_manually", "busy elsewhere: moved all the same, then stopped on the old one");
  assert.equal(w.campaigns.get(900)!.leads.get(13)!.status, "in_sequence", "and still on the other campaign (both sequences)");
  assert.equal(old.leads.get(23)!.status, "sequence_finished");
  assert.equal(old.leads.size, 9, "no lead removed from the old campaign");
  // order: copy → name → tag → inboxes → copies → move → old renamed → links
  const order = w.writes.map((x) => x.split(" ")[0]);
  assert.deepEqual(order, ["duplicate", "rename", "tag", "inboxes", "attach", "move", "stop", "rename", "route", "pick"]);
  assert.ok(w.writes[1].includes(`rename ${NEW}`) && w.writes[7].includes(`rename ${OLD}`), "the old campaign is renamed LAST");
  assert.deepEqual(r.links, { portal: "copied", picksMoved: 1, setupsMoved: 0, errors: [] });
  assert.deepEqual(w.audits.map((a) => a.stage), ["started", "copied", "finished"]);
  assert.deepEqual(w.audits.map((a) => a.ok), [true, true, true]);
  assert.ok(lines.some((l) => /draft and sends nothing/.test(l)));
});

test("refused when anything the review showed changed since (wrong token): nothing written", async () => {
  const w = liv();
  const r = await runRenew(OLD, "0".repeat(32), [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Something changed since the review/);
  assert.deepEqual(w.writes, []);
});

test("refused when a new round appeared since the review (the numbered name changed)", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.campaign({ id: 1300, name: "LIV Indy Realty 6 + Indianapolis Metro + ZF NS4 (EST)", status: "completed" });
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.deepEqual(w.writes, []);
});

test("refused when an inbox's health changed since the review", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  (w.bounces as Map<number, RecentBounces>).set(1, { id: 1, sent: 100, bounced: 50 });
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.deepEqual(w.writes, []);
});

test("blockers: a draft, an earlier round, analytics 098 not run, no healthy inbox, no leads, links unreadable", async () => {
  const cases: Array<[string, (w: World) => void, RegExp]> = [
    ["draft", (w) => { w.campaigns.get(OLD)!.status = "draft"; }, /draft/],
    ["archived", (w) => { w.campaigns.get(OLD)!.status = "archived"; }, /Only a running, paused or finished campaign/],
    ["098 missing", (w) => { w.bounces = "missing"; }, /098_os_inbox_recent_bounces/],
    ["no healthy inbox, none in the pool", (w) => { const c = w.campaigns.get(OLD)!; c.inboxes = new Set([4, 5]); for (const i of [1, 2, 3]) w.inboxes.delete(i); }, /None of this campaign's inboxes passes the health check and the wider pool has none to spare/],
    ["no inbox", (w) => { w.campaigns.get(OLD)!.inboxes = new Set(); }, /has no inboxes/],
    ["no leads", (w) => { const c = w.campaigns.get(OLD)!; for (const id of [11, 12, 13, 21, 22, 23]) c.leads.delete(id); }, /new campaign would be empty/],
    ["links unreadable", (w) => { w.links = { ready: false, error: "table missing", portalRoute: null, picks: [], setups: [] }; }, /could not be read.*table missing/],
  ];
  for (const [label, change, why] of cases) {
    const w = liv();
    change(w);
    const p = await previewRenew(OLD, w.io());
    if ("error" in p) throw new Error(p.error);
    assert.ok(p.blockers.some((b) => why.test(b)), `${label}: ${p.blockers.join(" | ")}`);
    const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
    assert.equal(r.ok, false, label);
    assert.deepEqual(w.writes, [], `${label}: nothing written`);
  }
  const w = liv();
  const p = await previewRenew(385, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.ok(p.blockers.some((b) => /round 5 of "LIV Indy Realty \+ Indianapolis Metro \+ ZF NS4 \(EST\)"/.test(b)), "renewing round 5 points at the current one");
});

test("a failure BEFORE any lead moves deletes the copy: nothing changed", async () => {
  for (const [name, at] of [["rename", 1], ["tag", 1], ["attachInboxes", 1], ["attachLeads", 1]] as const) {
    const w = liv();
    const p = await previewRenew(OLD, w.io());
    if ("error" in p) throw new Error(p.error);
    w.fail[name] = { at, error: new Error(`${name} broke`) };
    const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
    assert.equal(r.ok, false, name);
    assert.equal(r.rolledBack, true, name);
    assert.match(r.error ?? "", new RegExp(`${name} broke.*The copy was deleted again, so nothing changed`));
    assert.equal(w.campaigns.get(OLD)!.name, NAME, `${name}: old name untouched`);
    assert.ok(![...w.campaigns.values()].some((c) => c.id >= 2000), `${name}: no copy left`);
    assert.ok(!w.writes.some((x) => x.startsWith("move")), `${name}: no lead moved`);
    assert.equal(w.audits.at(-1)?.ok, false);
  }
});

test("the copy with a different number of emails is caught and deleted", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const dup = io.duplicate;
  io.duplicate = async (id) => { const n = await dup(id); w.campaigns.get(n)!.steps = 2; return n; };
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", io);
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.match(r.error ?? "", /The copy has 2 sequence steps, the campaign has 3/);
});

test("a failure DURING the move is never undone: it says where things are, the old campaign keeps its name", async () => {
  const w = liv();
  for (let i = 0; i < 1100; i++) w.lead(5000 + i, [[OLD, "in_sequence"]]);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.moveLeads = { at: 2, error: new Error("EmailBison 500") };
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.ok(r.newCampaignId && w.campaigns.has(r.newCampaignId), "the copy is kept");
  assert.match(r.error ?? "", new RegExp(`EmailBison 500 The new campaign \\(#${r.newCampaignId}\\) exists .* The old campaign was NOT renamed`));
  assert.equal(w.campaigns.get(OLD)!.name, NAME);
  assert.equal(w.counts.moveLeads, 2, "stopped at the failing chunk");
});

test("big campaigns go in chunks of 500 (1,103 to move = 3 moves)", async () => {
  const w = liv();
  for (let i = 0; i < 1100; i++) w.lead(5000 + i, [[OLD, "in_sequence"]]);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(w.counts.moveLeads, 3);
  assert.equal(r.leads.moved, 1103);
});

test("a PAUSED old campaign: its sending_paused leads are moved", async () => {
  const w = liv();
  const old = w.campaigns.get(OLD)!;
  old.status = "paused";
  for (const m of old.leads.values()) if (m.status === "in_sequence") m.status = "sending_paused";
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.leads.move, 3);
  assert.ok(!p.warnings.some((x) => /still sending/.test(x)), "no 'still sending' warning when paused");
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.leads.moved, 3);
});

test("a completed old campaign: nothing to move, the finished leads are copied", async () => {
  const w = liv();
  const old = w.campaigns.get(OLD)!;
  old.status = "completed";
  for (const m of old.leads.values()) if (m.status === "in_sequence") m.status = "sequence_finished";
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.leads.moved, 0);
  assert.ok(!w.writes.some((x) => x.startsWith("move")));
  assert.equal(r.leads.copied, 6, "every finished lead, the one another campaign is emailing included");
});

test("a move EmailBison takes its time over is waited for; one that never lands is named, not hidden", async () => {
  const w = liv();
  w.moveDelayReads = 3;
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true);
  assert.equal(r.leads.moved, 3, "landed after a few checks");

  const w2 = liv();
  w2.moveDelayReads = 10_000; // never lands
  const p2 = await previewRenew(OLD, w2.io());
  if ("error" in p2) throw new Error(p2.error);
  const r2 = await runRenew(OLD, p2.token, p2.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w2.io());
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.leads.notArrived.map((x) => x.email).sort(), ["l11@x.com", "l12@x.com"]);
  assert.deepEqual(r2.leads.lost.map((x) => x.email), ["l13@x.com"], "not on the new campaign, but another campaign is still emailing it");
  for (const id of [11, 12, 13]) assert.equal(w2.campaigns.get(OLD)!.leads.get(id)!.status, "in_sequence", `lead ${id} never arrived: NOT stopped on the old campaign`);
  assert.equal(r2.leads.stoppedOnOld, 0);
  assert.ok(r2.warnings.some((x) => /2 moved leads are not on the new campaign yet/.test(x)));
  assert.ok(w2.clock <= 8 * 60_000 + 10_000, "gave up waiting after about 8 minutes");
});

test("a lead that bounced since the review is left out by the run's own fresh read", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.leads.get(21)!.status = "bounced";
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true);
  assert.equal(r.leads.planned.copy, 2);
  assert.equal(r.leads.copied, 2);
  assert.equal(r.leads.copyRefused, 0);
});

test("copies EmailBison refuses at the moment of adding (a lead that bounced by then) are counted, not reported as copied", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const attach = io.attachLeads;
  io.attachLeads = async (id, ids) => { w.leads.get(21)!.status = "bounced"; return attach(id, ids); };
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", io);
  assert.equal(r.ok, true);
  assert.equal(r.leads.copied, 2);
  assert.equal(r.leads.copyRefused, 1);
});

test("a lead another campaign starts emailing at the moment of copying is still copied (allow_parallel_sending)", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const attach = io.attachLeads;
  io.attachLeads = async (id, ids) => { w.campaigns.get(900)!.leads.set(21, { status: "in_sequence", reason: null }); return attach(id, ids); };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.equal(r.leads.copied, 3);
  assert.equal(r.leads.copyRefused, 0);
});

test("every copy refused (EmailBison's 422) is counted, and the run carries on to the moves", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  io.attachLeads = async () => "refused";
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", io);
  assert.equal(r.ok, true);
  assert.equal(r.leads.copied, 0);
  assert.equal(r.leads.copyRefused, 3);
  assert.equal(r.leads.moved, 3);
});

test("renaming the old campaign failing at the end keeps the copy and says so", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.rename = { at: 2, error: new Error("name refused") };
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.equal(r.oldRenamed, false);
  assert.ok(w.campaigns.has(r.newCampaignId!));
  assert.match(r.error ?? "", /name refused .* The old campaign was NOT renamed/);
});

test("no ZF tag on the old campaign: none on the new one, said in the review", async () => {
  const w = liv();
  w.campaigns.get(OLD)!.tags = [];
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.ok(p.warnings.some((x) => /no ZF or NO-ZF tag/.test(x)));
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.equal(r.ok, true);
  assert.ok(!w.writes.some((x) => x.startsWith("tag")));
  w.campaigns.get(OLD)!.tags = [{ id: 101, name: "NO-ZF" }];
});

test("NO-ZF is carried as NO-ZF", async () => {
  const w = liv();
  w.campaigns.get(OLD)!.tags = [{ id: 101, name: "NO-ZF" }];
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, p.inboxes.pool?.picks.map((x) => x.id) ?? [], "amy@x.com", w.io());
  assert.deepEqual(w.campaigns.get(r.newCampaignId!)!.tags.map((t) => t.name), ["NO-ZF"]);
});

test("one renewal per campaign at a time: a second start is answered with the running one", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const a = startRenewJob(OLD, p.token, [], "amy@x.com", w.io());
  const b = startRenewJob(OLD, p.token, [], "eddy@x.com", w.io());
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal(b.job.id, a.job.id);
  for (let i = 0; i < 50 && !getJob(a.job.id)?.finishedAt; i++) await new Promise((r) => setTimeout(r, 10));
  const done = getJob(a.job.id)!;
  assert.equal(done.result?.ok, true, done.result?.error ?? "");
  assert.ok(done.log.length >= 5);
  assert.equal(w.counts.duplicate, 1, "one copy, not two");
});

/* ------------------------------------------------------------------------------------------- the wider pool --- */

/**
 * LIV Indy plus a wider pool. The kept inboxes (1, 2, 3) can send 25 + 25 + 25 = 75/day; the old campaign's own daily
 * limit is set per test. The pool is only asked for what 75/day falls short of that limit (the user, 19 Nov).
 */
function livWithPool(limit: number | null = 125) {
  const w = liv();
  w.campaigns.get(OLD)!.maxE = limit as number;
  w.inbox(61, {}, 500, 1, 0); // healthy, idle: 25 spare
  w.inbox(62, { dailyLimit: 30 }, 0, 0, 0); // never sent: 30 spare
  w.inbox(63, { tags: ["Dead"] }); // never picked
  w.inbox(64, {}, 500, 0, 25); // sent its whole limit today: no capacity
  w.inbox(65, {}, 1000, 30, 0); // 3%: never picked fresh
  w.inbox(66, { status: "Not connected" });
  w.inbox(67, {}, 500, 2, 20); // 5 spare
  return w;
}

test("pool: the kept inboxes (75/day) fall 50/day short of the campaign's 125/day: made up from the pool, most spare first", async () => {
  const w = livWithPool(125);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const pool = p.inboxes.pool!;
  assert.deepEqual(p.inboxes.capacity, { kept: 75, campaignLimit: 125 });
  assert.equal(pool.needed, 50);
  assert.deepEqual(pool.picks.map((x) => x.id), [62, 61], "30 spare (never sent) then 25: 55 covers 50");
  assert.equal(pool.shortfall, 0);
  assert.ok(!pool.picks.some((x) => [1, 2, 3, 4, 5, 63, 64, 65, 66].includes(x.id)), "never the old campaign's own, Dead, full, warning or not connected");
  const r = await runRenew(OLD, p.token, pool.picks.map((x) => x.id), "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual([...w.campaigns.get(r.newCampaignId!)!.inboxes].sort((a, b) => a - b), [1, 2, 3, 61, 62]);
  assert.deepEqual({ asked: r.pool.asked, added: r.pool.added, dropped: r.pool.dropped.length }, { asked: 2, added: 2, dropped: 0 });
  assert.equal(r.inboxesAdded, 5);
});

test("pool (the user, 19 Nov): kept inboxes that cover the campaign's limit get NO pool inboxes, however many were left out", async () => {
  // As C21 #363: 244 inboxes left out (bouncing or Not connected), yet the 143 kept can send more than its 3,000/day.
  const w = livWithPool(75);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.deepEqual(p.inboxes.judgement!.leave.map((v) => v.id).sort(), [4, 5], "inboxes were left out");
  assert.equal(p.inboxes.pool!.needed, 0);
  assert.deepEqual(p.inboxes.pool!.picks, []);
  assert.ok(!p.warnings.some((x) => /wider pool/.test(x)));
});

test("pool: a pick that used up its capacity since the review is dropped and named; the rest go on", async () => {
  const w = livWithPool(125);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  (w.bounces as Map<number, RecentBounces>).set(62, { id: 62, sent: 30, bounced: 0, sent24h: 30 });
  const r = await runRenew(OLD, p.token, p.inboxes.pool!.picks.map((x) => x.id), "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.pool.dropped.map((d) => d.id), [62]);
  assert.match(r.pool.dropped[0].why, /no longer healthy, connected or with capacity/);
  assert.deepEqual([...w.campaigns.get(r.newCampaignId!)!.inboxes].sort((a, b) => a - b), [1, 2, 3, 61]);
  assert.ok(r.warnings.some((x) => /1 pool inbox was left out at the last check/.test(x)));
});

test("pool: a pick EmailBison says is not connected right now is dropped (checked live before adding)", async () => {
  const w = livWithPool(125);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.liveStatus.set(61, "Not connected");
  const r = await runRenew(OLD, p.token, p.inboxes.pool!.picks.map((x) => x.id), "amy@x.com", w.io());
  assert.deepEqual(r.pool.dropped, [{ id: 61, email: "i61@send.com", why: "Not connected in EmailBison now" }]);
  assert.ok(!w.campaigns.get(r.newCampaignId!)!.inboxes.has(61));
});

test("pool: ids that were never eligible (the old campaign's own left-out inbox, a Dead one) are refused, not added", async () => {
  const w = livWithPool(125);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, [4, 63, 61], "amy@x.com", w.io());
  assert.deepEqual(r.pool.dropped.map((d) => d.id).sort(), [4, 63]);
  const inb = w.campaigns.get(r.newCampaignId!)!.inboxes;
  assert.ok(!inb.has(4) && !inb.has(63) && inb.has(61));
});

test("pool: when the pool cannot cover the shortfall, the review says how much it could add", async () => {
  const w = liv(); // the campaign's 3,000/day against 75/day kept, and no pool beyond its own inboxes
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.inboxes.pool!.shortfall, 2925);
  assert.ok(p.warnings.some((x) => /kept inboxes can send 75\/day, less than the campaign's 3000\/day, and the wider pool has healthy inboxes for only 0\/day more/.test(x)), p.warnings.join(" | "));
});

test("pool: an old campaign with no healthy inbox is still renewable when the pool can supply them", async () => {
  const w = livWithPool(125);
  w.campaigns.get(OLD)!.inboxes = new Set([4, 5]);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.inboxes.capacity.kept, 0);
  const r = await runRenew(OLD, p.token, p.inboxes.pool!.picks.map((x) => x.id), "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  // 125 needed: every healthy pool inbox with capacity (62: 30, 1/2/3: 25 each, 61: 25, 67: 5 = 135), most spare first
  assert.ok(w.campaigns.get(r.newCampaignId!)!.inboxes.size >= 5);
});

test("pool: a campaign with no daily limit set falls back to the left-out inboxes' capacity (25 + 25 = 50)", async () => {
  const w = livWithPool(null);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.inboxes.pool!.needed, 50);
  assert.deepEqual(p.inboxes.pool!.picks.map((x) => x.id), [62, 61]);
});

/* --------------------------------------------------------------------------- the independent review, 19 Nov --- */

test("review #1: a run that stopped part-way blocks the next review while its copy exists; deleting the copy unblocks", async () => {
  const w = liv();
  for (let i = 0; i < 1100; i++) w.lead(5000 + i, [[OLD, "in_sequence"]]);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.moveLeads = { at: 2, error: new Error("EmailBison 500") };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  w.fail = {};
  const p2 = await previewRenew(OLD, w.io());
  if ("error" in p2) throw new Error(p2.error);
  assert.ok(p2.blockers.some((b) => new RegExp(`did not finish, and its copy #${r.newCampaignId}`).test(b)), p2.blockers.join(" | "));
  const r2 = await runRenew(OLD, p2.token, [], "amy@x.com", w.io());
  assert.equal(r2.ok, false, "never a second copy");
  assert.equal([...w.campaigns.values()].filter((c) => c.name === NAME && c.status === "draft").length, 1, "one copy only: the first run's");
  // the person deletes the copy: renewable again
  w.campaigns.delete(r.newCampaignId!);
  const p3 = await previewRenew(OLD, w.io());
  if ("error" in p3) throw new Error(p3.error);
  assert.ok(!p3.blockers.some((b) => /did not finish/.test(b)));
});

test("review #1: a run cut off by a restart (started + copied rows, no finished row) blocks while its copy exists", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  io.attachInboxes = async () => { throw new Error("process restarted"); }; // stands in for the process dying mid-run…
  io.deleteCampaign = async () => { throw new Error("process restarted"); }; // …so nothing is rolled back either
  io.audit = async (a) => { if (a.stage !== "finished") w.audits.push(a); }; // and no finished row is ever written
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.ok(r.newCampaignId && w.campaigns.has(r.newCampaignId));
  const p2 = await previewRenew(OLD, w.io());
  if ("error" in p2) throw new Error(p2.error);
  assert.ok(p2.blockers.some((b) => /did not finish/.test(b)), p2.blockers.join(" | "));
});

test("review #1: a rolled-back run (copy deleted) does not block", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.tag = { at: 1, error: new Error("tag broke") };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.rolledBack, true);
  w.fail = {};
  const p2 = await previewRenew(OLD, w.io());
  if ("error" in p2) throw new Error(p2.error);
  assert.deepEqual(p2.blockers, []);
});

test("review #2: a failure part-way through the move reports what is really on the copy", async () => {
  const w = liv();
  for (let i = 0; i < 1100; i++) w.lead(5000 + i, [[OLD, "in_sequence"]]);
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.moveLeads = { at: 2, error: new Error("EmailBison 500") };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.leads.moved, 500);
  assert.match(r.error ?? "", /500 of 1103 In Sequence leads are on it \(500 were sent to EmailBison's move; 0 stopped on the old campaign\)/);
});

test("a lead another campaign takes after the review (paused old campaign) is still moved (allow_parallel_sending)", async () => {
  const w = liv();
  const old = w.campaigns.get(OLD)!;
  old.status = "paused";
  for (const m of old.leads.values()) if (m.status === "in_sequence") m.status = "sending_paused";
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const attach = io.attachInboxes;
  io.attachInboxes = async (id, ids) => { await attach(id, ids); w.campaigns.get(900)!.leads.set(11, { status: "in_sequence", reason: null }); };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.leads.skippedAtMove, 0);
  assert.equal(r.leads.moved, 3);
  assert.ok(w.campaigns.get(r.newCampaignId!)!.leads.has(11));
  assert.deepEqual(r.leads.lost, []);
});

test("a lead that replied or was stopped since the review is NOT moved: re-checked just before the move", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const attach = io.attachInboxes;
  io.attachInboxes = async (id, ids) => { await attach(id, ids); w.campaigns.get(OLD)!.leads.set(11, { status: "replied", reason: null }); };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.equal(r.leads.skippedAtMove, 1);
  assert.equal(r.leads.moved, 2);
  assert.equal(w.campaigns.get(OLD)!.leads.get(11)!.status, "replied", "left as it is");
  assert.ok(r.warnings.some((x) => /1 lead was left on the old campaign at the last check: no longer In Sequence/.test(x)));
});

test("safety net: if EmailBison ever ignored allow_parallel_sending, a dropped lead is named LOST, not 'still moving'", async () => {
  const w = liv();
  w.ignoresParallel = true;
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.deepEqual(r.leads.lost, [{ id: 13, email: "l13@x.com", campaignIds: [900] }]);
  assert.deepEqual(r.leads.notArrived, []);
  assert.equal(r.leads.moved, 2);
});

test("review #7: a hand-set client follows the new campaign: pending until it is synced, then applied by the job", async () => {
  const w = liv();
  w.pin = { clientId: "client-hetherington" };
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.links.clientPinned, true);
  assert.ok(p.warnings.some((x) => /client is pinned by hand/.test(x)));
  const timers: Array<() => void> = [];
  const { job } = startRenewJob(OLD, p.token, [], "amy@x.com", w.io(), { pinEveryMs: 1, pinForMs: 60_000, later: (fn) => { timers.push(fn); } });
  for (let i = 0; i < 100 && !getJob(job.id)?.finishedAt; i++) await new Promise((r) => setTimeout(r, 5));
  const r = getJob(job.id)!.result!;
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.pinPending, w.pin, "not synced yet: pending");
  w.pinRowsFor.add(r.newCampaignId!); // the analytics sync lists the new campaign
  timers.shift()!();
  for (let i = 0; i < 50 && r.pinPending; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.pinPending, null);
  assert.deepEqual(w.pinsApplied, [{ id: r.newCampaignId, pin: w.pin }]);
  assert.ok(getJob(job.id)!.log.some((l) => /now has the old one's client setting/.test(l)));
});

test("review #7: already synced: the client setting is applied in the run itself", async () => {
  const w = liv();
  w.pin = { clientId: "client-x" };
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const dup = io.duplicate;
  io.duplicate = async (id) => { const n = await dup(id); w.pinRowsFor.add(n); return n; };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.equal(r.pinPending, null);
  assert.equal(w.pinsApplied.length, 1);
});

test("review #10: a leftover 'Copy of …' draft is pointed out; a lost Duplicate answer says to look for one", async () => {
  const w = liv();
  w.campaign({ id: 1999, name: `Copy of ${NAME}`, status: "draft" });
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.ok(p.warnings.some((x) => /"Copy of LIV Indy Realty \+ Indianapolis Metro \+ ZF NS4 \(EST\)" \(#1999, draft\) exists/.test(x)), p.warnings.join(" | "));
  const w2 = liv();
  const p2 = await previewRenew(OLD, w2.io());
  if ("error" in p2) throw new Error(p2.error);
  w2.fail.duplicate = { at: 1, error: new Error("socket hang up") };
  const r = await runRenew(OLD, p2.token, [], "amy@x.com", w2.io());
  assert.match(r.error ?? "", /socket hang up If EmailBison made the copy before its answer was lost, a draft named "Copy of LIV Indy/);
});

test("review: every audit row of a run belongs to the OLD campaign, with started → copied → finished", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.deepEqual(w.audits.map((a) => [a.stage, a.sourceId]), [["started", OLD], ["copied", OLD], ["finished", OLD]]);
  assert.equal(w.audits[1].newCampaignId, r.newCampaignId);
});

/* ------------------------------------------------- quick refusals (user, 19 Nov: "show ... a little faster") --- */

test("quick: an earlier round is refused WITHOUT reading any lead, inbox or the pool, and names the campaign to open", async () => {
  const w = liv();
  const p = await previewRenew(385, w.io()); // "LIV Indy Realty 5 + …" in this fake
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.checked, "quick");
  assert.ok(p.blockers.some((b) => /round 5 of "LIV Indy Realty \+ Indianapolis Metro \+ ZF NS4 \(EST\)"/.test(b)));
  assert.equal(!p.names.ok && p.names.currentId, OLD, "the current campaign's id, for the Open link");
  assert.deepEqual(w.heavyReads, [], "no slow read at all");
  const r = await runRenew(385, p.token, [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.deepEqual(w.writes, []);
});

test("quick: a draft, an archived campaign, one with no emails, and an unfinished renewal — all without the slow reads", async () => {
  const cases: Array<[string, (w: World) => void, RegExp]> = [
    ["draft", (w) => { w.campaigns.get(OLD)!.status = "draft"; }, /draft/],
    ["archived", (w) => { w.campaigns.get(OLD)!.status = "archived"; }, /archived/],
    ["no emails", (w) => { w.campaigns.get(OLD)!.steps = 0; }, /no emails in its sequence/],
    ["unfinished renewal", (w) => {
      w.campaign({ id: 3000, name: NAME, status: "draft" });
      w.audits.push({ stage: "started", sourceId: OLD, sourceName: NAME, newCampaignId: null, ok: true, actor: "amy@x.com", detail: {}, error: null });
      w.audits.push({ stage: "copied", sourceId: OLD, sourceName: NAME, newCampaignId: 3000, ok: true, actor: "amy@x.com", detail: {}, error: null });
    }, /did not finish, and its copy #3000/],
  ];
  for (const [label, change, why] of cases) {
    const w = liv();
    change(w);
    const p = await previewRenew(OLD, w.io());
    if ("error" in p) throw new Error(p.error);
    assert.equal(p.checked, "quick", label);
    assert.ok(p.blockers.some((b) => why.test(b)), `${label}: ${p.blockers.join(" | ")}`);
    assert.deepEqual(w.heavyReads, [], `${label}: no slow read`);
  }
});

test("full: a renewable campaign is read in full (checked = full)", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.checked, "full");
  assert.ok(w.heavyReads.includes(`leadRows ${OLD}`) && w.heavyReads.includes(`inboxes ${OLD}`) && w.heavyReads.includes("pool"));
});

/* ------------------------------------------- the user, 19 Nov: every lead goes, even one another campaign emails --- */

test("parallel-sending move: every arrived lead is stopped on the old campaign (the move alone would leave it there)", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.ok, true, r.error ?? "");
  const old = w.campaigns.get(OLD)!;
  for (const id of [11, 12, 13]) {
    assert.equal(old.leads.get(id)!.status, "stopped", `${id} stopped on the old campaign`);
    assert.ok(w.campaigns.get(r.newCampaignId!)!.leads.has(id), `${id} on the new one`);
  }
  assert.equal(w.campaigns.get(900)!.leads.get(13)!.status, "in_sequence", "13 still on its other campaign (both sequences, as chosen)");
  assert.equal(r.leads.stoppedOnOld, 3);
});

test("a stop that does not take at first is tried again; if the old campaign still emails them, the run stops BEFORE renaming and names them", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.stopIgnored = true;
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.equal(w.counts.stopLeads, 2, "stopped, checked, stopped again");
  assert.match(r.error ?? "", /3 moved leads are on the new campaign but the old campaign is still emailing them \(l11@x\.com, l12@x\.com, l13@x\.com\): stop them on the old campaign in EmailBison/);
  assert.match(r.error ?? "", /The old campaign was NOT renamed/);
  assert.equal(w.campaigns.get(OLD)!.name, NAME);
  assert.ok(w.campaigns.has(r.newCampaignId!), "the new campaign is kept");
});

test("a stop the old campaign takes only on the second try still finishes", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  const io = w.io();
  const stop = io.stopLeads;
  let n = 0;
  io.stopLeads = async (id, ids) => { n++; if (n === 1) { w.writes.push("stop ignored"); return; } return stop(id, ids); };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", io);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(n, 2);
  assert.equal(r.leads.stoppedOnOld, 3);
});

test("a stop call that fails outright stops the run before renaming, nothing undone", async () => {
  const w = liv();
  const p = await previewRenew(OLD, w.io());
  if ("error" in p) throw new Error(p.error);
  w.fail.stopLeads = { at: 1, error: new Error("EmailBison 500 on stop") };
  const r = await runRenew(OLD, p.token, [], "amy@x.com", w.io());
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /EmailBison 500 on stop .*The old campaign was NOT renamed/);
  assert.equal(r.rolledBack, false);
});
