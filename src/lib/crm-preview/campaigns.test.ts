import { test } from "node:test";
import assert from "node:assert/strict";

import { campaignLabels, campaignsOn, DEMO_SAMPLES, listCampaigns, liveStepOf, marketOf, onPortal, readCampaign, saveCampaign, slackText, stateOf, type AuditRow, type CampaignDeps, type DemoRow } from "./campaigns";
import { copyModel, type LiveStep, type SaveInput, type StepWrite } from "./campaign-copy";
import { DEMO_PORTAL_ID } from "./demo";

const PORTAL = "11111111-2222-3333-4444-555555555555";

function steps(): LiveStep[] {
  return [
    { id: 10, order: 1, subject: "Hello {FIRST_NAME}", body: "<p>Hi {FIRST_NAME},</p><p>Open to more deals?</p>", wait: 2, variant: false, parentId: null, threadReply: false, active: true },
    { id: 11, order: 2, subject: "Re: Hello {FIRST_NAME}", body: "<p>Following up.</p>", wait: 3, variant: false, parentId: null, threadReply: true, active: true },
    { id: 12, order: 3, subject: "Re: Hello {FIRST_NAME}", body: "<p>Last one.</p>", wait: 1, variant: false, parentId: null, threadReply: true, active: true },
  ];
}

/** A fake EmailBison and everything around it, recording every call. */
function fake(o: { status?: string; own?: Array<{ id: string; name: string; status: string }> | null; sent?: Map<number, number>; failOn?: "delete" | "update" | "add"; failMessage?: string } = {}) {
  let live = steps();
  let nextId = 100;
  const calls: string[] = [];
  const sent: StepWrite[] = [];
  const audits: AuditRow[] = [];
  const posts: string[] = [];
  const demo = new Map<string, DemoRow>();
  const deps: CampaignDeps = {
    ownCampaigns: async () => (o.own === undefined ? [{ id: "77", name: "Acme + Austin + Prospects (CST)", status: o.status ?? "active" }, { id: "78", name: "Old one", status: "archived" }] : o.own),
    liveCampaign: async () => ({ name: "Acme + Austin + Prospects (CST)", status: o.status ?? "active" }),
    liveSequence: async () => ({ sequenceId: 555, steps: live.map((s) => ({ ...s })) }),
    sentPerStep: async () => o.sent ?? new Map(),
    deleteStep: async (id) => {
      calls.push(`delete ${id}`);
      if (o.failOn === "delete") throw new Error(o.failMessage ?? "This step cannot be deleted because emails were sent");
      const gone = live.find((s) => s.id === id)!;
      live = live.filter((s) => s.id !== id);
      // As EmailBison does (checked live, 17 Nov): the main emails after a deleted one move up.
      if (!gone.variant) for (const s of live) if (!s.variant && s.order !== null && gone.order !== null && s.order > gone.order) s.order -= 1;
    },
    updateSteps: async (seq, _t, ws: StepWrite[]) => {
      calls.push(`update ${seq}: ${ws.map((w) => w.id).join(",")}`);
      sent.push(...ws);
      if (o.failOn === "update") throw new Error("EmailBison 500");
      for (const w of ws) {
        const s = live.find((x) => x.id === w.id)!;
        Object.assign(s, { subject: w.thread_reply ? `Re: ${w.email_subject}` : w.email_subject, body: w.email_body, order: w.order, wait: w.wait_in_days, threadReply: w.thread_reply });
      }
    },
    addSteps: async (cid, _t, ws: StepWrite[]) => {
      calls.push(`add ${cid}: ${ws.length}`);
      if (o.failOn === "add") throw new Error("EmailBison 500");
      for (const w of ws) live.push({ id: nextId++, order: w.order, subject: w.thread_reply ? `Re: ${w.email_subject}` : w.email_subject, body: w.email_body, wait: w.wait_in_days, variant: false, parentId: null, threadReply: w.thread_reply, active: true });
    },
    audit: async (a) => { audits.push(a); },
    slack: async (t) => { posts.push(t); },
    demoRows: async (portalId) => {
      if (!demo.size) for (const s of DEMO_SAMPLES) demo.set(s.campaign_id, { ...structuredClone(s), updated_at: "t0" });
      return portalId === DEMO_PORTAL_ID ? [...demo.values()].map((r) => structuredClone(r)) : [];
    },
    demoWrite: async (_p, id, ss, at, who) => {
      const r = demo.get(id)!;
      if (r.updated_at !== at) return false;
      demo.set(id, { ...r, steps: ss, updated_at: `t-${who}-${Date.now()}` });
      return true;
    },
    osOrigin: () => "https://os.example.com",
    clientName: async () => "Acme",
  };
  return { deps, calls, audits, posts, demo, sent, live: () => live };
}

function input(live: LiveStep[], sent = new Map<number, number>()): SaveInput {
  const m = copyModel(live, sent);
  return { version: m.version, emails: m.emails.map((e) => ({ id: e.id, waitBefore: e.waitBefore, threadReply: e.threadReply, versions: e.versions.map((v) => ({ ...v })) })) };
}

test("on for the Demo Portal always; a real portal only by OS_PORTAL_CAMPAIGNS", () => {
  assert.equal(campaignsOn(DEMO_PORTAL_ID, {}), true);
  assert.equal(campaignsOn(PORTAL, {}), false);
  assert.equal(campaignsOn(PORTAL, { OS_PORTAL_CAMPAIGNS: "" }), false);
  assert.equal(campaignsOn(PORTAL, { OS_PORTAL_CAMPAIGNS: "all" }), true);
  assert.equal(campaignsOn(PORTAL, { OS_PORTAL_CAMPAIGNS: `x, ${PORTAL}` }), true);
  assert.equal(campaignsOn(PORTAL, { OS_PORTAL_CAMPAIGNS: "someone-else" }), false);
});

test("EmailBison's statuses as the page says them; archived and deleted ones aren't shown", () => {
  assert.deepEqual(["active", "queued", "launching", "paused", "draft", "completed", "stopped", "archived", "pending deletion", "", null].map(stateOf), ["sending", "sending", "sending", "paused", "draft", "finished", "finished", null, null, null, null]);
});

test("a step as EmailBison returns it", () => {
  assert.deepEqual(liveStepOf({ id: 5, order: "2", email_subject: null, email_body: "<p>x</p>", wait_in_days: null, variant: true, variant_from_step_id: 4, thread_reply: null, active: false }), { id: 5, order: 2, subject: "", body: "<p>x</p>", wait: 0, variant: true, parentId: 4, threadReply: false, active: false });
  assert.equal(liveStepOf({ id: 6, order: null, email_subject: "s", email_body: "", wait_in_days: 1, variant: false, variant_from_step_id: null, thread_reply: false }).order, null);
});

test("the list: only the client's campaigns that are sending (24 Nov); paused, draft, finished and archived left out", async () => {
  const f = fake({ own: [{ id: "1", name: "B", status: "paused" }, { id: "2", name: "A", status: "active" }, { id: "3", name: "C", status: "archived" }, { id: "4", name: "D", status: "completed" }, { id: "5", name: "E", status: "draft" }, { id: "6", name: "F", status: "queued" }, { id: "7", name: "G", status: "stopped" }, { id: "8", name: "H", status: "launching" }] });
  const r = await listCampaigns(PORTAL, f.deps);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((c) => [c.id, c.state]), [["2", "sending"], ["6", "sending"], ["8", "sending"]]);
  for (const st of ["paused", "draft", "completed", "stopped", "archived", "", null]) assert.equal(onPortal(st), false, String(st));
  for (const st of ["active", "queued", "launching", "ACTIVE"]) assert.equal(onPortal(st), true, st);
  assert.deepEqual(await listCampaigns(PORTAL, fake({ own: null }).deps), { ok: true, value: [] });
  const none = await listCampaigns(PORTAL, { ...fake().deps, ownCampaigns: async () => undefined });
  assert.equal(none.ok, false);
});

test("a campaign that isn't the client's is never read or saved", async () => {
  const f = fake();
  for (const id of ["999", "78", "abc", "1; drop"]) {
    const r = await readCampaign(PORTAL, id, f.deps);
    assert.equal(r.ok, false, id);
    assert.equal((r as { status: number }).status, 404);
    const s = await saveCampaign(PORTAL, id, input(steps()), "x@y.com", f.deps);
    assert.equal(s.ok, false, id);
  }
  assert.deepEqual(f.calls, []);
});

test("reading: live emails of a sending campaign; a paused, draft or finished one can't be opened, even by its id", async () => {
  const r = await readCampaign(PORTAL, "77", fake().deps);
  assert.ok(r.ok);
  assert.equal(r.value.state, "sending");
  assert.equal(r.value.editable, true);
  assert.deepEqual(r.value.emails.map((e) => e.versions[0].text), ["Hi {FIRST_NAME},\n\nOpen to more deals?", "Following up.", "Last one."]);
  for (const status of ["completed", "paused", "draft", "stopped"]) {
    // Not sending on the list…
    const f = fake({ status, own: [{ id: "77", name: "x", status }] });
    const listed = await readCampaign(PORTAL, "77", f.deps);
    assert.equal(listed.ok, false, status);
    assert.equal((listed as { status: number }).status, 404);
    assert.match((listed as { error: string }).error, /isn't sending right now/);
    assert.equal("view" in listed, false, "nothing of it is sent back");
    // …or only live (the list's copy not caught up yet).
    const live = await readCampaign(PORTAL, "77", fake({ status, own: [{ id: "77", name: "x", status: "active" }] }).deps);
    assert.equal(live.ok, false, status);
    assert.match((live as { error: string }).error, /isn't sending right now/);
    assert.deepEqual(f.calls, []);
  }
});

test("a save goes to EmailBison, is read back, written to the history and posted to #portal-update", async () => {
  const f = fake();
  const i = input(steps());
  i.emails[1].versions[0].text = "A better follow-up, {FIRST_NAME}.";
  i.emails.push({ id: null, waitBefore: 2, threadReply: true, versions: [{ id: null, subject: "", text: "One more." }] });
  const r = await saveCampaign(PORTAL, "77", i, "client@acme.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(f.calls, ["update 555: 11,12", "add 77: 1"]);
  assert.deepEqual(r.value.view.emails.map((e) => e.versions[0].text), ["Hi {FIRST_NAME},\n\nOpen to more deals?", "A better follow-up, {FIRST_NAME}.", "Last one.", "One more."]);
  assert.deepEqual(r.value.summary, ["Email 2: wording changed", "Added email 4, 2 days after email 3, as a reply in the same thread"]);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].ok, true);
  assert.equal(f.audits[0].who, "client@acme.com");
  assert.deepEqual(f.audits[0].applied, { deleted: 0, updated: 2, added: 1 });
  assert.equal(f.audits[0].before.length, 3);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0], /^\*Emails changed · Acme\*/);
  assert.match(f.posts[0], /<https:\/\/os\.example\.com\/analytics\/campaigns\/77\|Acme \+ Austin \+ Prospects \(CST\)>/);
  assert.match(f.posts[0], /• Email 2: wording changed/);
  assert.match(f.posts[0], /_by client@acme\.com, live now_/);
});

test("a save that changes nothing writes nothing and posts nothing", async () => {
  const f = fake();
  const r = await saveCampaign(PORTAL, "77", input(steps()), "x@y.com", f.deps);
  assert.ok(r.ok);
  assert.deepEqual([f.calls, f.audits, f.posts], [[], [], []]);
});

test("rule breaks are refused with every problem, before anything is written", async () => {
  const f = fake();
  const i = input(steps());
  i.emails[0].versions[0].text = "Visit www.acme.com";
  i.emails[2].waitBefore = 45;
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps);
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 422);
  assert.equal((r as { problems: unknown[] }).problems.length, 2);
  assert.deepEqual([f.calls, f.audits, f.posts], [[], [], []]);
});

test("a campaign that stopped sending, and a stale page, are refused before anything is written", async () => {
  const f = fake({ status: "completed", own: [{ id: "77", name: "x", status: "active" }] });
  const r = await saveCampaign(PORTAL, "77", input(steps()), "x@y.com", f.deps);
  assert.equal((r as { status: number }).status, 409);
  for (const [listed, live] of [["active", "paused"], ["paused", "paused"], ["paused", "active"], ["draft", "draft"]]) {
    const p = fake({ status: live, own: [{ id: "77", name: "x", status: listed }] });
    const i = input(steps());
    i.emails[0].versions[0].text = "Changed.";
    const out = await saveCampaign(PORTAL, "77", i, "x@y.com", p.deps);
    assert.equal(out.ok, false, `${listed}/${live}`);
    assert.equal((out as { code?: string }).code, "not-sending");
    assert.match((out as { error: string }).error, /stopped sending.*Nothing was saved/);
    assert.deepEqual([p.calls, p.audits, p.posts], [[], [], []]);
  }
  const g = fake();
  const i = input(steps());
  i.version = "not-it";
  const s = await saveCampaign(PORTAL, "77", i, "x@y.com", g.deps);
  assert.equal((s as { status: number }).status, 409);
  assert.deepEqual([f.calls, g.calls], [[], []]);
});

test("removals go first: one EmailBison refuses stops the save with nothing changed", async () => {
  const f = fake({ failOn: "delete" });
  const i = input(steps());
  i.emails.splice(1, 1);
  i.emails[1].versions[0].text = "Edited last.";
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /already gone out, so it can't be removed\. Nothing was changed/);
  assert.deepEqual(f.calls, ["delete 11"]);
  assert.equal(f.audits[0].ok, false);
  assert.deepEqual(f.posts, []); // nothing changed, nothing to tell
});

test("a failure part way says so, posts what happened, and returns what EmailBison holds now", async () => {
  const f = fake({ failOn: "add" });
  const i = input(steps());
  i.emails[0].versions[0].text = "Changed first.";
  i.emails.push({ id: null, waitBefore: 1, threadReply: true, versions: [{ id: null, subject: "", text: "New." }] });
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps) as { ok: false; status: number; error: string; view?: { emails: Array<{ versions: Array<{ text: string }> }> } };
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.error, /Only part of your change was saved/);
  assert.equal(r.view!.emails[0].versions[0].text, "Changed first.");
  assert.equal(r.view!.emails.length, 3);
  assert.equal(f.audits[0].ok, false);
  assert.match(f.posts[0], /partly changed/);
  assert.match(f.posts[0], /EmailBison stopped part way/);
});

test("removing an unsent email deletes it first; EmailBison renumbers, so only the changed gap is sent", async () => {
  const f = fake();
  const i = input(steps());
  i.emails.splice(1, 1);
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  // Email 3 moved to 2 by itself: no write for its number. Email 1 carries the new gap (email 2's old wait).
  assert.deepEqual(f.calls, ["delete 11", "update 555: 10"]);
  assert.deepEqual(r.value.view.emails.map((e) => e.id), [10, 12]);
  assert.deepEqual(f.live().map((s) => [s.id, s.order]), [[10, 1], [12, 2]]);
  assert.ok(f.sent.every((w) => !("orderOnly" in w)), "the internal mark never goes to EmailBison");
});

test("if EmailBison hadn't renumbered after a delete, the save puts the email in its place", async () => {
  const f = fake();
  const keep = f.deps.deleteStep;
  // An EmailBison that leaves a gap.
  f.deps.deleteStep = async (id) => { const before = f.live().map((s) => ({ ...s })); await keep(id); for (const s of f.live()) s.order = before.find((b) => b.id === s.id)!.order; };
  const i = input(steps());
  i.emails.splice(1, 1);
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(f.calls, ["delete 11", "update 555: 10,12"]);
  assert.deepEqual(f.live().map((s) => [s.id, s.order]), [[10, 1], [12, 2]]);
  assert.ok(f.sent.every((w) => !("orderOnly" in w)));
});

test("saves to one campaign run one at a time; the second sees the first's result", async () => {
  const f = fake();
  const a = input(steps());
  a.emails[1].versions[0].text = "First save.";
  const b = input(steps());
  b.emails[2].versions[0].text = "Second save.";
  const [ra, rb] = await Promise.all([saveCampaign(PORTAL, "77", a, "a@x.com", f.deps), saveCampaign(PORTAL, "77", b, "b@x.com", f.deps)]);
  assert.equal(ra.ok, true);
  // b was made from the page before a's save: refused as stale rather than overwriting it.
  assert.equal((rb as { status: number }).status, 409);
  assert.equal(f.live().find((s) => s.id === 11)!.body, "<p>First save.</p>");
});

test("the Demo Portal: its own samples, saved to its own rows, nothing to EmailBison or Slack", async () => {
  const f = fake();
  const list = await listCampaigns(DEMO_PORTAL_ID, f.deps);
  assert.ok(list.ok);
  assert.deepEqual(list.value.map((c) => [c.id, c.state]), [["1", "sending"]], "its paused sample isn't shown");
  assert.equal((await readCampaign(DEMO_PORTAL_ID, "2", f.deps)).ok, false);
  const paused = await saveCampaign(DEMO_PORTAL_ID, "2", { version: "x", emails: [] }, "x@y.com", f.deps);
  assert.equal((paused as { code?: string }).code, "not-sending");
  const one = await readCampaign(DEMO_PORTAL_ID, "1", f.deps);
  assert.ok(one.ok);
  assert.equal(one.value.emails.length, 3);
  assert.equal(one.value.emails[0].versions.length, 2);
  assert.equal(one.value.emails[0].sent, 412);
  const i = { version: one.value.version, emails: one.value.emails.map((e) => ({ id: e.id, waitBefore: e.waitBefore, threadReply: e.threadReply, versions: e.versions.map((v) => ({ ...v })) })) };
  i.emails[2].versions[0].text = "Last note from me, {FIRST_NAME}.";
  i.emails.push({ id: null, waitBefore: 3, threadReply: true, versions: [{ id: null, subject: "", text: "Bonus." }] });
  const r = await saveCampaign(DEMO_PORTAL_ID, "1", i, "eddy@brokerstaffer.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.view.emails.map((e) => e.versions[0].text).slice(2), ["Last note from me, {FIRST_NAME}.", "Bonus."]);
  assert.deepEqual([f.calls, f.audits, f.posts], [[], [], []]);
  const again = await readCampaign(DEMO_PORTAL_ID, "1", f.deps);
  assert.ok(again.ok);
  assert.equal(again.value.emails.length, 4);
  // A sent email can't be removed on the Demo either.
  const j = { version: again.value.version, emails: again.value.emails.filter((e) => e.id !== 102).map((e) => ({ id: e.id, waitBefore: e.waitBefore, threadReply: e.threadReply, versions: e.versions.map((v) => ({ ...v })) })) };
  const refused = await saveCampaign(DEMO_PORTAL_ID, "1", j, "x@y.com", f.deps);
  assert.match((refused as { error: string }).error, /already been sent to 96 agents/);
});

test("the Demo samples fit every rule (so a client's first save of them only checks what they change)", async () => {
  const { copyProblem, allowedFields, htmlToText, bareSubject } = await import("./campaign-copy");
  for (const c of DEMO_SAMPLES) {
    const fields = new Set(allowedFields(c.steps));
    for (const s of c.steps) {
      assert.equal(copyProblem(htmlToText(s.body), "text", fields), null, `${c.name} ${s.id} body`);
      if (!s.threadReply) assert.equal(copyProblem(bareSubject(s.subject, s.threadReply), "subject", fields), null, `${c.name} ${s.id} subject`);
    }
  }
});

test("the Slack post names the client, the campaign (linked) and who, never anything else", () => {
  const t = slackText({ client: "Acme", campaign: "A <b>|c", campaignId: 9, who: "amy@x.com", summary: ["Email 1: wording changed"], failed: null, origin: "https://os.brokerstaffer.com" });
  assert.equal(t, "*Emails changed · Acme*\n<https://os.brokerstaffer.com/analytics/campaigns/9|A bc>\n• Email 1: wording changed\n_by amy@x.com, live now_");
});

test("a save that fails with nothing written keeps the client's edits (no campaign sent back to replace them)", async () => {
  const f = fake({ failOn: "update" });
  const i = input(steps());
  i.emails[1].versions[0].text = "Edited.";
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps) as { ok: false; error: string; view?: unknown };
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing was changed/);
  assert.equal(r.view, undefined);
  assert.deepEqual(f.posts, []);
});

test("refusals carry a code: not-sending, stale", async () => {
  const f = fake({ status: "completed", own: [{ id: "77", name: "x", status: "active" }] });
  assert.equal(((await saveCampaign(PORTAL, "77", input(steps()), "x@y.com", f.deps)) as { code?: string }).code, "not-sending");
  const g = fake();
  const i = input(steps());
  i.version = "old";
  assert.equal(((await saveCampaign(PORTAL, "77", i, "x@y.com", g.deps)) as { code?: string }).code, "stale");
});

test("after a removal, a version's update is sent with the number it has now", async () => {
  const f = fake();
  // A version of email 1 numbered 9; EmailBison moves it to 7 when email 2 goes (if it ever did).
  f.live().push({ id: 20, order: 9, subject: "B", body: "<p>B</p>", wait: 1, variant: true, parentId: 10, threadReply: false, active: true });
  const keep = f.deps.deleteStep;
  f.deps.deleteStep = async (id) => { await keep(id); const v = f.live().find((s) => s.id === 20)!; v.order = 7; };
  const i = input(f.live());
  i.emails.splice(1, 1);
  i.emails[0].versions[1].text = "B edited.";
  const r = await saveCampaign(PORTAL, "77", i, "x@y.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(f.sent.find((w) => w.id === 20)!.order, 7);
});

/* ------------------------------------------------------------------------------- names (23 + 24 Nov) --- */
// 23 Nov, the user: "client should not see the campaign names in the campaign page in new portals". 24 Nov, BrokerStaffer:
// "Campaigns shouldn't say 53, 54 etc." and the user picked the market name. A client gets the campaign's market and never
// EmailBison's name, in the list, one campaign, or a save's answer; our team also gets the real name as internalName.
// The history row and the #portal-update post keep the real name.

const OWN = [
  { id: "905", name: "Acme 2 + Austin + ZF NS4 (CST)", status: "completed" },
  { id: "77", name: "Acme 1 + Austin + ZF NS1 (CST)", status: "active" },
  { id: "1203", name: "Acme + Round Rock, TX + Acme Copy (CST)", status: "active" },
  { id: "1300", name: "Acme + Austin + ZF NS4 (CST)", status: "queued" },
  { id: "88", name: "Acme old + Nicole + ARMLS", status: "archived" },
  { id: "1400", name: "Acme + Waco + ZF NS1 (CST)", status: "paused" },
];
const leaks = (v: unknown, names: string[]) => names.filter((n) => JSON.stringify(v).includes(n));

test("names: the market out of EmailBison's names, as they are today (23 Nov audit of every portal)", () => {
  const cases: Array<[string, string | null]> = [
    ["Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)", "Charleston, SC"],
    ["Jeff Cook Real Estate + Charlotte–Triad, NC + Jeff Copy (EST)", "Charlotte–Triad, NC"],
    ["Jeff Cook Real Estate 7 + Greenville, SC + ZF NS1 (EST)", "Greenville, SC"],
    ["Douglas Elliman New York + New York OneKey (EST)", "New York OneKey"],
    ["Momentum Realty + San Gabriel Valley & Inland Empire + ZF NS4 (PST)", "San Gabriel Valley & Inland Empire"],
    ["C21 Results - Elite Team + Atlanta + ZF NS4 (EST) PREWARMED", "Atlanta"],
    ["Cain Realty Group + Austin + Custom Copy + N-CI (CST)", "Austin"],
    ["Douglas Elliman Los Angeles + Nicole + Beverly Hills + Elliman Copy (PST)", "Beverly Hills"],
    ["Kelly + Co + Nicole + Baltimore (PST)", "Baltimore"],
    ["Douglas Elliman NYC 1 + Nicole +REBNY", "REBNY"],
    ["Properties & Estates REMAX + Boston + ZF NS4 (EST)", "Boston"],
    ["SERHANT. NJ + Monmouth County + SERHANT. Copy (EST)", "Monmouth County"],
    ["Test Real Estate + Los Angeles + Prospects", "Los Angeles"],
    ["Copy of Wagner Real Estate Group 2", null],
    ["The Keyes Company - Beaches East", null],
    ["Acme + ZF NS1 (EST)", null],
    ["Acme + 2 + (EST)", null],
    ["", null],
  ];
  for (const [name, market] of cases) assert.equal(marketOf(name), market, name);
});

test("names: the same market twice is told apart, oldest first; no market reads 'Your campaign'", () => {
  const labels = campaignLabels([
    { id: "1378", name: "Jeff Cook Real Estate 8 + Charleston, SC + ZF NS1 (EST)", status: "active" },
    { id: "1377", name: "Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)", status: "active" },
    { id: "1376", name: "Jeff Cook Real Estate + Myrtle Beach, SC + ZF NS1 (EST)", status: "paused" },
    { id: "12", name: "Copy of Acme 2", status: "active" },
    { id: "13", name: "Acme", status: "active" },
  ]);
  assert.deepEqual([...labels.entries()].sort(), [["12", "Your campaign"], ["13", "Your campaign (2)"], ["1377", "Charleston, SC"], ["1378", "Charleston, SC (2)"]].sort());
  assert.equal(labels.has("1376"), false, "a paused campaign gets no label: it isn't shown");
});

test("names: a client's list says each market (A to Z), only sending ones, and carries no EmailBison name", async () => {
  const f = fake({ own: OWN });
  const r = await listCampaigns(PORTAL, f.deps);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((c) => [c.id, c.name, c.state]), [["77", "Austin", "sending"], ["1300", "Austin (2)", "sending"], ["1203", "Round Rock, TX", "sending"]]);
  assert.deepEqual(leaks(r.value, OWN.map((o) => o.name)), []);
  assert.ok(r.value.every((c) => !("internalName" in c)));
  assert.doesNotMatch(JSON.stringify(r.value), /ZF|NS\d|Nicole|Copy|Acme|Waco|\(CST\)|Campaign \d/);
});

test("names: our team's list is the same list, with EmailBison's name added", async () => {
  const r = await listCampaigns(PORTAL, fake({ own: OWN }).deps, { staff: true });
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((c) => [c.name, c.internalName]), [["Austin", "Acme 1 + Austin + ZF NS1 (CST)"], ["Austin (2)", "Acme + Austin + ZF NS4 (CST)"], ["Round Rock, TX", "Acme + Round Rock, TX + Acme Copy (CST)"]]);
});

test("names: one campaign, opened by a client, is its market with no EmailBison name; by our team, both", async () => {
  const f = fake();
  const c = await readCampaign(PORTAL, "77", f.deps);
  assert.ok(c.ok);
  assert.equal(c.value.name, "Austin");
  assert.ok(!("internalName" in c.value));
  assert.deepEqual(leaks(c.value, ["Acme + Austin + Prospects (CST)"]), []);
  const s = await readCampaign(PORTAL, "77", f.deps, { staff: true });
  assert.ok(s.ok);
  assert.equal(s.value.name, "Austin");
  assert.equal(s.value.internalName, "Acme + Austin + Prospects (CST)");
});

test("names: a client's save answers with the market; the history and #portal-update keep the real name", async () => {
  const f = fake();
  const i = input(f.live());
  i.emails[2].versions[0].text = "Last one, {FIRST_NAME}.";
  const r = await saveCampaign(PORTAL, "77", i, "client@acme.com", f.deps);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.view.name, "Austin");
  assert.deepEqual(leaks(r.value, ["Acme + Austin + Prospects (CST)"]), []);
  assert.equal(f.audits[0].campaignName, "Acme + Austin + Prospects (CST)", "the campaign's history is ours");
  assert.match(f.posts[0], /Acme \+ Austin \+ Prospects \(CST\)/, "the Slack post is ours");
});

test("names: a save that stops part way sends back the campaign as it is, still by its market", async () => {
  const f = fake({ failOn: "add" });
  const i = input(f.live());
  i.emails[0].versions[0].text = "Hi {FIRST_NAME}, changed.";
  i.emails.push({ id: null, waitBefore: 2, threadReply: true, versions: [{ id: null, subject: "", text: "One more." }] });
  const r = await saveCampaign(PORTAL, "77", i, "client@acme.com", f.deps);
  assert.ok(!r.ok);
  assert.ok(r.view, "part landed, so the page gets the campaign as it is now");
  assert.equal(r.view!.name, "Austin");
  assert.deepEqual(leaks(r, ["Acme + Austin + Prospects (CST)"]), []);
  const staff = await saveCampaign(PORTAL, "77", input(fake({ failOn: "add" }).live()), "staff@os", fake({ failOn: "add" }).deps, { staff: true });
  assert.ok(staff.ok, "nothing to change is a plain ok");
  assert.equal(staff.value.view.internalName, "Acme + Austin + Prospects (CST)");
});

test("names: the Demo Portal too — its sending sample by market for a client, the sample name only for our team", async () => {
  const f = fake();
  const r = await listCampaigns(DEMO_PORTAL_ID, f.deps);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((c) => c.name), ["Atlanta"]);
  assert.deepEqual(leaks(r.value, DEMO_SAMPLES.map((s) => s.name)), []);
  const one = await readCampaign(DEMO_PORTAL_ID, DEMO_SAMPLES[0].campaign_id, f.deps);
  assert.ok(one.ok);
  assert.equal(one.value.name, "Atlanta");
  assert.deepEqual(leaks(one.value, DEMO_SAMPLES.map((s) => s.name)), []);
  const s = await listCampaigns(DEMO_PORTAL_ID, f.deps, { staff: true });
  assert.ok(s.ok);
  assert.deepEqual(s.value.map((c) => c.internalName), [DEMO_SAMPLES[0].name]);
});

test("names: the routes ask for EmailBison's name only for staff; the page and the chat never send a lead's campaign name", async () => {
  const { readFileSync } = await import("node:fs");
  const list = readFileSync("src/app/api/crm-preview/campaigns/route.ts", "utf8");
  const save = readFileSync("src/app/api/crm-preview/campaign-save/route.ts", "utf8");
  assert.match(list, /readCampaign\(client, campaign, undefined, \{ staff: viewer\.kind === "staff" \}\)/);
  assert.match(list, /listCampaigns\(client, undefined, \{ staff: viewer\.kind === "staff" \}\)/);
  assert.match(save, /saveCampaign\(portal, parsed\.data\.campaign, parsed\.data\.save, who, undefined, \{ staff: viewer\.kind === "staff" \}\)/);
  const page = readFileSync("src/app/crm-preview/page.tsx", "utf8");
  assert.match(page, /entries=\{entries\.map\(\(e\) => \(\{ \.\.\.e, campaign_name: null \}\)\)\}/);
  assert.doesNotMatch(readFileSync("src/lib/crm-preview/chat-tools.ts", "utf8"), /campaign_name/);
  assert.doesNotMatch(readFileSync("src/components/crm-preview/campaigns.tsx", "utf8"), /campaign_name/);
});
