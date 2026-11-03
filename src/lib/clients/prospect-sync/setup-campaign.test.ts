import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
configureFakeEnvironment("ANALYTICS_");
process.env.ANALYTICS_TEAM_ID = "7";
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { ensureSetupCampaign, loadTemplate, saveTemplate } = await import("./setup-campaign.ts");

const NOW = new Date("2026-11-03T15:00:00.000Z");
const client = { osClientId: "os-homebase", portalId: "portal-homebase", name: "Homebase", aliases: [], areas: ["Greater Denver"], mls: ["REcolorado"], timeZone: "America/Denver", analyticsClientId: "an-homebase" };

/** A fake EmailBison: a template with a {CLIENT_AREA} step and two inboxes; every call recorded. */
function fakeEb(o: { failAt?: string } = {}) {
  const calls: Array<{ what: string; args: unknown[] }> = [];
  const call = (what: string, out: unknown) => async (...args: unknown[]) => {
    calls.push({ what, args });
    if (o.failAt === what) throw new Error(`EmailBison refused ${what}`);
    return out;
  };
  return {
    calls,
    eb: {
      getCampaign: call("getCampaign", { id: 42, name: "Prospects Template (EST)" }),
      duplicateCampaign: call("duplicate", { data: { id: 901 } }),
      createCampaign: call("create", { data: { id: 902 } }),
      updateCampaign: call("rename", { data: { id: 901 } }),
      getCampaignSequenceSteps: call("steps", { data: { sequence_id: 55, sequence_steps: [{ id: 1, email_subject: "Hi", email_body: "Agents in {CLIENT_AREA}", order: 1, wait_in_days: 0, thread_reply: false, variant: false }] } }),
      updateSequenceSteps: call("fill", { data: {} }),
      getCampaignSenderEmails: call("senders", [{ id: 7 }, { id: 8 }]),
      attachSenderEmails: call("inboxes", { data: {} }),
    },
  };
}

function seed(template = true) {
  db.reset();
  db.seed("os_setup_campaigns", []);
  db.seed("os_campaign_list_clients", []);
  db.seed("os_prospect_sync_settings", template ? [{ id: "default", template_campaign_id: "42", template_campaign_name: "Prospects Template (EST)" }] : []);
  db.seed("campaigns", []);
  db.seed("campaign_clients", []);
  db.seed("campaign_audit_log", []);
}

test("no template set: a BLANK draft under the client's name, sent once — no emails, inboxes or start; the team is told; made once", async () => {
  seed(false);
  assert.equal(await loadTemplate(), null);
  const { eb, calls } = fakeEb();
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: false, now: NOW, eb: eb as never });
  assert.deepEqual(out, { kind: "ready", campaignId: "902", campaignName: "Homebase + Greater Denver + Prospects (MST)", created: true, note: "Created blank (no template is set): add its emails, schedule and sending inboxes before launching it.", blank: true });
  assert.deepEqual(calls.map((c) => c.what), ["create"], "nothing copied, renamed, filled or attached — and never started");
  assert.deepEqual(calls[0].args, ["Homebase + Greater Denver + Prospects (MST)", { retry: false }], "asked ONCE — a retried create could make two");
  assert.deepEqual(db.rows("os_setup_campaigns").map((r) => [r.status, r.campaign_id, r.template_campaign_id, r.mls_code]), [["ready", "902", "", ""]]);
  assert.deepEqual(db.rows("os_campaign_list_clients").map((r) => [r.os_client_id, r.prospects_campaign_id]), [["os-homebase", "902"]], "it is the client's Prospects campaign");
  assert.deepEqual(db.rows("campaign_clients").map((r) => [r.campaign_id, r.client_id]), [[902, "an-homebase"]]);
  assert.equal(db.rows("campaign_audit_log")[0].before_state && (db.rows("campaign_audit_log")[0].before_state as { source_campaign_id: unknown }).source_campaign_id, null);
  const again = await ensureSetupCampaign(client, { by: "portal prospects", test: false, now: NOW, eb: eb as never });
  assert.deepEqual(again, { kind: "ready", campaignId: "902", campaignName: "Homebase + Greater Denver + Prospects (MST)", created: false, note: null });
  assert.equal(calls.filter((c) => c.what === "create").length, 1, "never a second");
  // A client with several MLSs: one for each.
  seed(false);
  let next = 910;
  const two = fakeEb();
  two.eb.createCampaign = async (...args: unknown[]) => { two.calls.push({ what: "create", args }); return { data: { id: next++ } }; };
  const a = await ensureSetupCampaign({ ...client, mlsCode: "MLSPIN" }, { by: "portal prospects", test: false, now: NOW, eb: two.eb as never });
  const b = await ensureSetupCampaign({ ...client, mlsCode: "SOCAL" }, { by: "portal prospects", test: false, now: NOW, eb: two.eb as never });
  assert.deepEqual([a.kind === "ready" && a.campaignName, b.kind === "ready" && b.campaignName], ["Homebase + MLSPIN + Prospects (MST)", "Homebase + SOCAL + Prospects (MST)"]);
});

test("the template can't be read: stopped and tried again — never taken as 'no template' (which would make a blank draft over a chosen template)", async () => {
  seed();
  const { eb, calls } = fakeEb();
  db.failWhen = (c) => c.method === "GET" && c.table === "os_prospect_sync_settings";
  await assert.rejects(ensureSetupCampaign(client, { by: "portal prospects", test: false, now: NOW, eb: eb as never }), /os_prospect_sync_settings/);
  db.failWhen = null;
  assert.equal(calls.length, 0);
  assert.equal(db.rows("os_setup_campaigns").length, 0, "nothing claimed");
});

test("EmailBison doesn't answer the blank create: never asked again — failed, saying exactly what to look for", async () => {
  seed(false);
  const { eb, calls } = fakeEb({ failAt: "create" });
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: false, now: NOW, eb: eb as never });
  assert.equal(out.kind, "failed");
  assert.match(out.kind === "failed" ? out.reason : "", /may still have made it\. Look in EmailBison for "Homebase \+ Greater Denver \+ Prospects \(MST\)"/);
  assert.equal((await ensureSetupCampaign(client, { by: "portal prospects", test: false, now: NOW, eb: eb as never })).kind, "failed");
  assert.equal(calls.filter((c) => c.what === "create").length, 1);
});

test("the template: set from a campaign that exists in EmailBison", async () => {
  seed(false);
  const { eb } = fakeEb();
  const t = await saveTemplate(42, "eddy@brokerstaffer.com", eb as never);
  assert.deepEqual([t.campaignId, t.campaignName], ["42", "Prospects Template (EST)"]);
  assert.equal((await loadTemplate())?.campaignId, "42");
});

test("made once: a draft copy of the template, renamed, its client fields filled, the template's inboxes, linked in Analytics, the client's Prospects campaign — never started", async () => {
  seed();
  const { eb, calls } = fakeEb();
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.deepEqual(out, { kind: "ready", campaignId: "901", campaignName: "Homebase + Greater Denver + Prospects (MST)", created: true, note: null });
  assert.deepEqual(calls.map((c) => c.what), ["duplicate", "rename", "steps", "fill", "senders", "inboxes"]);
  assert.deepEqual(calls[0].args, [42, { retry: false }], "the copy is asked for ONCE — a retried copy could make two");
  assert.deepEqual(calls[1].args, [901, { name: "Homebase + Greater Denver + Prospects (MST)" }]);
  assert.match(JSON.stringify(calls[3].args), /Agents in Greater Denver/);
  assert.deepEqual(calls[5].args, [901, [7, 8]]);
  assert.ok(!calls.some((c) => /resume|launch|status/i.test(c.what)), "never started");
  assert.deepEqual(db.rows("os_setup_campaigns").map((r) => [r.status, r.campaign_id, r.template_campaign_id, r.test]), [["ready", "901", "42", true]]);
  assert.deepEqual(db.rows("os_campaign_list_clients").map((r) => [r.os_client_id, r.prospects_campaign_id]), [["os-homebase", "901"]]);
  assert.deepEqual(db.rows("campaigns").map((r) => [r.id, r.status, r.team_id]), [[901, "draft", 7]]);
  assert.deepEqual(db.rows("campaign_clients").map((r) => [r.campaign_id, r.client_id, r.match_method]), [[901, "an-homebase", "manual"]]);
  // Asked again (another run, a later day): the same campaign — never a second.
  const again = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.deepEqual(again, { kind: "ready", campaignId: "901", campaignName: "Homebase + Greater Denver + Prospects (MST)", created: false, note: null });
  assert.equal(calls.filter((c) => c.what === "duplicate").length, 1);
});

test("the team's own Prospects campaign choice is never overwritten by the new campaign", async () => {
  seed();
  db.seed("os_campaign_list_clients", [{ os_client_id: "os-homebase", prospects_campaign_id: "640", prospects_campaign_name: "Homebase + Chosen (MST)", remove_enabled: false }]);
  const { eb } = fakeEb();
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.equal(out.kind, "ready");
  assert.deepEqual(db.rows("os_campaign_list_clients").map((r) => r.prospects_campaign_id), ["640"]);
});

test("EmailBison doesn't answer the copy: never asked again — failed, saying exactly what to look for", async () => {
  seed();
  const { eb, calls } = fakeEb({ failAt: "duplicate" });
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.equal(out.kind, "failed");
  assert.match(out.kind === "failed" ? out.reason : "", /may still have made the copy\. Look in EmailBison for "Copy of Prospects Template \(EST\)"/);
  assert.equal((await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never })).kind, "failed");
  assert.equal(calls.filter((c) => c.what === "duplicate").length, 1);
});

test("a client with no Analytics record: made all the same, nothing written to Analytics", async () => {
  seed();
  const { eb } = fakeEb();
  const out = await ensureSetupCampaign({ ...client, analyticsClientId: null }, { by: "portal prospects", test: false, now: NOW, eb: eb as never });
  assert.equal(out.kind, "ready");
  assert.equal(db.rows("campaigns").length + db.rows("campaign_clients").length, 0);
});

test("it fails part-way: the campaign made is written down (to find it), the claim is failed — and NEVER tried again by itself", async () => {
  seed();
  const { eb, calls } = fakeEb({ failAt: "inboxes" });
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.equal(out.kind, "failed");
  assert.match(out.kind === "failed" ? out.reason : "", /EmailBison campaign 901 was made — check it there/);
  assert.deepEqual(db.rows("os_setup_campaigns").map((r) => [r.status, r.campaign_id]), [["failed", "901"]]);
  const again = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.equal(again.kind, "failed");
  assert.equal(calls.filter((c) => c.what === "duplicate").length, 1, "no second campaign");
});

test("two runs at once: one makes it, the other waits (the claim is the client's one row)", async () => {
  seed();
  db.seed("os_setup_campaigns", [{ os_client_id: "os-homebase", mls_code: "", portal_id: "portal-homebase", status: "creating", template_campaign_id: "42", created_by: "x", created_at: new Date(NOW.getTime() - 60_000).toISOString() }]);
  const { eb, calls } = fakeEb();
  const out = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.deepEqual(out, { kind: "waiting", reason: "Its first campaign is being made." });
  // Stuck for over 15 minutes (its run died): reported, not made again.
  const late = await ensureSetupCampaign(client, { by: "portal prospects", test: true, now: new Date(NOW.getTime() + 20 * 60_000), eb: eb as never });
  assert.equal(late.kind, "failed");
  assert.equal(calls.length, 0);
});

test("a client with several MLSs: one draft per MLS, each claimed on its own — named for its MLS, its area left for the team (said), nothing set as the client's one Prospects campaign", async () => {
  seed();
  let next = 950;
  const { eb, calls } = fakeEb();
  eb.duplicateCampaign = async (...args: unknown[]) => { calls.push({ what: "duplicate", args }); return { data: { id: next++ } }; };
  const two = { ...client, areas: ["Boston", "San Diego County"], mls: ["MLSPIN", "SOCAL"] };
  const a = await ensureSetupCampaign({ ...two, mlsCode: "MLSPIN" }, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  const b = await ensureSetupCampaign({ ...two, mlsCode: "SOCAL" }, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.deepEqual([a.kind === "ready" && a.campaignName, b.kind === "ready" && b.campaignName], ["Homebase + MLSPIN + Prospects (MST)", "Homebase + SOCAL + Prospects (MST)"]);
  assert.deepEqual([a.kind === "ready" && a.campaignId, b.kind === "ready" && b.campaignId], ["950", "951"]);
  assert.match(a.kind === "ready" ? String(a.note) : "", /Client fields not filled/, "{CLIENT_AREA}: which area an MLS covers is not recorded — left for the team, and said");
  assert.doesNotMatch(JSON.stringify(calls.filter((c) => c.what === "fill")), /Boston/, "never the client's other market's area");
  assert.deepEqual(db.rows("os_setup_campaigns").map((r) => [r.mls_code, r.status, r.campaign_id]).sort(), [["MLSPIN", "ready", "950"], ["SOCAL", "ready", "951"]]);
  assert.equal(db.rows("os_campaign_list_clients").length, 0, "shown per MLS on the Campaigns tab — never written over the client's one pick");
  // Asked again for one: the same campaign, never a second.
  const again = await ensureSetupCampaign({ ...two, mlsCode: "SOCAL" }, { by: "portal prospects", test: true, now: NOW, eb: eb as never });
  assert.deepEqual(again.kind === "ready" && [again.campaignId, again.created], ["951", false]);
  assert.equal(calls.filter((c) => c.what === "duplicate").length, 2);
});
