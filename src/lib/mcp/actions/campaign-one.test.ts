/*
 * The one-campaign actions (27 Nov) through runAction, against stand-ins for Campaign Analytics' cache, EmailBison and
 * the screens' own functions (recorded, not run): a campaign is found only when it is certain which; the preview
 * changes nothing; confirm runs the screen's own code, named "<email> via Claude"; every refusal says why.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Row = { id: string; name: string; status: string; platform: string; team_id: number };
const world = {
  campaigns: [] as Row[],
  live: new Map<number, string>(),
  facts: null as null | { name: string; facts: Record<string, unknown> },
  launchOk: true,
  settings: null as null | Record<string, unknown>,
  clients: [] as Array<{ name: string; aliases: string[] | null; status: string }>,
  inboxes: [] as Array<{ id: number; email: string; tags: unknown; team_id: number; archived_at: string | null }>,
  unhealthy: new Map<number, string>(),
  onCampaign: 12,
  addResult: { ok: true, outcome: "added", added: 0, alreadyOn: 0, before: 12, after: 0, dropped: 0 } as Record<string, unknown>,
  seq: [] as Array<{ id: number; order: number | null; subject: string; body: string; wait: number; variant: boolean; parentId: number | null; threadReply: boolean; active: boolean }>,
  seqStatus: "active",
  fields: { clientName: "Howe Realty Group", area: "Atlanta" as string | null, alias: "Howe" as string | null },
  updateFails: false,
};
const calls: string[] = [];

function likeToRegex(p: string): RegExp {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\" && i + 1 < p.length) { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    out += ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}
function analyticsDb() {
  return {
    from(table: string) {
      if (table === "campaign_audit_log") {
        return { insert: async (r: Record<string, unknown>) => { calls.push(`audit ${r.action} ${r.status} by ${r.actor}`); return { error: null }; } };
      }
      if (table === "sender_emails") {
        const q = { eq: {} as Record<string, unknown>, nullCol: "" };
        const c: Record<string, unknown> = {
          select: () => c,
          eq: (k: string, v: unknown) => { q.eq[k] = v; return c; },
          is: (k: string) => { q.nullCol = k; return c; },
          order: () => c,
          range: async (a: number, z: number) => {
            const rows = world.inboxes.filter((r) => r.team_id === q.eq.team_id && (q.nullCol !== "archived_at" || r.archived_at === null)).sort((x, y) => x.id - y.id);
            return { data: rows.slice(a, z + 1), error: null };
          },
        };
        return c;
      }
      assert.equal(table, "campaigns_unified");
      const eqs: Record<string, unknown> = {};
      const likes: RegExp[] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { eqs[c] = v; return b; },
        ilike: (_c: string, p: string) => { likes.push(likeToRegex(p)); return b; },
        limit: (n: number) => b && Object.assign(b, { _limit: n }),
        then: (res: (v: unknown) => unknown) => {
          const rows = world.campaigns.filter((r) => Object.entries(eqs).every(([k, v]) => String((r as Record<string, unknown>)[k]) === String(v)) && likes.every((re) => re.test(r.name)));
          return Promise.resolve({ data: rows.slice(0, Number((b as { _limit?: number })._limit ?? 1000)), error: null }).then(res);
        },
      };
      return b;
    },
  };
}

let mod: typeof import("./campaign-one.ts");
let inb: typeof import("./campaign-inboxes.ts");
let edit: typeof import("./campaign-edit.ts");
let core: typeof import("./core.ts");
const EDDY = { email: "eddy@brokerstaffer.com", admin: true, grants: [] as string[] };

async function load() {
  if (mod) return;
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { getAnalyticsSupabase: analyticsDb, analyticsTeamId: () => 7 } });
  mock.module("@/lib/clients/os-db", { namedExports: { osTable: () => ({ select: async () => ({ data: world.clients, error: null }) }) } });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", { namedExports: { createEmailBisonClient: () => ({ getCampaign: async (id: number) => ({ id, status: world.live.get(id) ?? "draft" }), getCampaignSenderEmailCount: async () => world.onCampaign }) } });
  mock.module("@/lib/tools/analytics/campaigns/attach-health-io", {
    namedExports: {
      readAttachHealth: async (ids: number[]) => {
        const leftOut = ids.filter((id) => world.unhealthy.has(id)).map((id) => ({ id, email: `#${id}`, reasons: [world.unhealthy.get(id)!], kinds: [world.unhealthy.get(id) === "Bounce rate 4%" ? "bounce" : "warm-up"] }));
        const counts = { "not connected": 0, Dead: 0, bounce: leftOut.filter((x) => x.kinds[0] === "bounce").length, "warm-up": leftOut.filter((x) => x.kinds[0] === "warm-up").length, "not found": 0 };
        return { ok: true, health: { healthy: ids.filter((id) => !world.unhealthy.has(id)), leftOut, counts, unjudged: 0 } };
      },
    },
  });
  mock.module("@/lib/crm-preview/campaigns", {
    namedExports: {
      stateOf: (status: string) => {
        const st = String(status ?? "").toLowerCase();
        return ["active", "queued", "launching"].includes(st) ? "sending" : st === "paused" ? "paused" : st === "draft" ? "draft" : ["completed", "stopped"].includes(st) ? "finished" : null;
      },
      realDeps: () => ({
        liveCampaign: async () => ({ name: "Howe 1 + Nicole + Atlanta", status: world.seqStatus }),
        liveSequence: async () => ({ sequenceId: 55, steps: world.seq.map((x) => ({ ...x })) }),
        sentPerStep: async () => new Map([[101, 340]]),
        updateSteps: async (sequenceId: number, title: string, writes: Array<{ id: number; email_subject: string; email_body: string }>) => {
          calls.push(`update seq ${sequenceId} "${title}" ${JSON.stringify(writes.map((w) => [w.id, w.email_subject, w.email_body]))}`);
          if (world.updateFails) throw new Error("EmailBison: step locked");
          for (const w of writes) { const st = world.seq.find((x) => x.id === w.id)!; st.subject = w.email_subject; st.body = w.email_body; }
        },
      }),
    },
  });
  mock.module("@/lib/tools/analytics/campaigns/client-fields-load", { namedExports: { clientFieldValuesForCampaign: async () => world.fields } });
  mock.module("@/lib/tools/analytics/campaigns/inbox-add-run", {
    namedExports: {
      runInboxAdd: async (i: { campaignId: number; inboxIds: number[]; actor: string; from: string }) => {
        calls.push(`add ${i.campaignId} ${JSON.stringify(i.inboxIds)} by ${i.actor} from ${i.from}`);
        return { status: 200, body: { ...world.addResult, added: i.inboxIds.length, after: 12 + i.inboxIds.length, name: "Howe 1" } };
      },
    },
  });
  mock.module("@/lib/tools/analytics/campaigns/actions.ts", {
    namedExports: {
      applyCampaignAction: async (action: string, targets: unknown, actor: string, team: number) => {
        calls.push(`${action} ${JSON.stringify(targets)} by ${actor} team ${team}`);
        return { batchId: "b", results: [{ campaignId: "1", platform: "emailbison", name: "Howe 1", ok: true, status: "paused" }] };
      },
    },
  });
  mock.module("@/lib/tools/analytics/campaigns/launch-load", {
    namedExports: {
      launchFacts: async () => world.facts,
      launchCampaign: async (id: number, actor: string, team: number) => {
        calls.push(`launch ${id} by ${actor} team ${team}`);
        return world.launchOk ? { ok: true, status: "queued" } : { ok: false, error: "EmailBison said no" };
      },
    },
  });
  mock.module("@/lib/tools/analytics/campaigns/settings-update.ts", {
    namedExports: {
      readSettings: async () => world.settings,
      applySettings: async (id: number, _before: unknown, changed: unknown, actor: string) => { calls.push(`settings ${id} ${JSON.stringify(changed)} by ${actor}`); return { ok: true, changed }; },
    },
  });
  core = await import("./core.ts");
  mod = await import("./campaign-one.ts");
  inb = await import("./campaign-inboxes.ts");
  edit = await import("./campaign-edit.ts");
}

function deps() {
  const claimed = new Set<string>(); let i = 0;
  return {
    sign: async (c: Record<string, unknown>) => Buffer.from(JSON.stringify(c)).toString("base64url"),
    verify: async (t: string) => JSON.parse(Buffer.from(t, "base64url").toString()) as Record<string, unknown>,
    audit: { used: async (n: string) => claimed.has(n), claim: async (r: { nonce: string }) => (claimed.has(r.nonce) ? false : (claimed.add(r.nonce), true)), finish: async () => {} },
    nonce: () => `n${++i}`,
  };
}
const run = (spec: unknown, args: Record<string, unknown>, d = deps()) => core.runAction(spec as never, args, EDDY, d as never);
const goodFacts = (extra: Record<string, unknown> = {}) => ({
  name: "Howe 1", facts: { status: "draft", steps: 3, leads: 120, inboxes: 5, unfilled: [], clientName: "Howe Realty Group", excluded: false, dailyLimit: 500, newLeadsPerDay: 50, ...extra },
});
function reset() {
  calls.length = 0;
  world.campaigns = [
    { id: "1", name: "Howe 1 + Nicole + Atlanta", status: "active", platform: "emailbison", team_id: 7 },
    { id: "2", name: "Howe 2 + Nicole + Atlanta", status: "paused", platform: "emailbison", team_id: 7 },
    { id: "3", name: "Keyes 100% Club", status: "draft", platform: "emailbison", team_id: 7 },
    { id: "9f1c-uuid", name: "Howe 1 + Nicole + Atlanta (Instantly)", status: "active", platform: "instantly", team_id: 7 },
    { id: "4", name: "Other team's Howe", status: "active", platform: "emailbison", team_id: 8 },
  ];
  world.live = new Map([[1, "active"], [2, "paused"], [3, "draft"]]);
  world.facts = goodFacts();
  world.launchOk = true;
  world.settings = { id: 1, name: "Howe 1", max_emails_per_day: 500, max_new_leads_per_day: 100 };
  world.clients = [{ name: "Howe Realty Group", aliases: null, status: "active" }];
  world.inboxes = [
    { id: 11, email: "a@pool12.co", tags: ["Pool 12", "Nicole"], team_id: 7, archived_at: null },
    { id: 12, email: "b@pool12.co", tags: [{ name: "Pool 12" }], team_id: 7, archived_at: null },
    { id: 13, email: "c@pool12.co", tags: ["pool 12"], team_id: 7, archived_at: null },
    { id: 14, email: "d@pool12.co", tags: ["Pool 12"], team_id: 7, archived_at: "2026-11-20" },
    { id: 15, email: "e@other.co", tags: ["Pool 13"], team_id: 7, archived_at: null },
    { id: 16, email: "f@pool12.co", tags: ["Pool 12"], team_id: 8, archived_at: null },
  ];
  world.unhealthy = new Map();
  world.onCampaign = 12;
  world.seq = [
    { id: 101, order: 1, subject: "Quick question", body: "<p>Hi {FIRST_NAME},</p><p>Are you open to a move this year?</p>", wait: 0, variant: false, parentId: null, threadReply: false, active: true },
    { id: 102, order: 1, subject: "Quick q", body: "<p>Hi {FIRST_NAME}, open to a move?</p>", wait: 0, variant: true, parentId: 101, threadReply: false, active: true },
    { id: 103, order: 2, subject: "Re: Quick question", body: "<p>Following up, {FIRST_NAME}.</p>", wait: 3, variant: false, parentId: null, threadReply: true, active: true },
  ];
  world.seqStatus = "active";
  world.fields = { clientName: "Howe Realty Group", area: "Atlanta", alias: "Howe" };
  world.updateFails = false;
}

test("finding a campaign: by number, exact name, one match — several or none are said, never guessed; Instantly and other teams never", { skip }, async () => {
  await load(); reset();
  assert.deepEqual(await mod.resolveEbCampaign("#2"), { id: 2, name: "Howe 2 + Nicole + Atlanta", status: "paused" });
  assert.deepEqual(await mod.resolveEbCampaign("howe 1 + nicole + atlanta"), { id: 1, name: "Howe 1 + Nicole + Atlanta", status: "active" });
  assert.equal((await mod.resolveEbCampaign("100% club") as { id: number }).id, 3, "a % in the name is a %, not a wildcard");
  const several = await mod.resolveEbCampaign("howe atlanta") as { error: string };
  assert.match(several.error, /matches 2 campaigns: Howe 1 \+ Nicole \+ Atlanta \(#1, active\); Howe 2 \+ Nicole \+ Atlanta \(#2, paused\)\. Which one\? Give its number\./);
  assert.match((await mod.resolveEbCampaign("Zillow")) && ((await mod.resolveEbCampaign("Zillow")) as { error: string }).error, /No EmailBison campaign called "Zillow"/);
  assert.match(((await mod.resolveEbCampaign("9f1c-uuid")) as { error: string }).error, /No EmailBison campaign/);
  assert.match(((await mod.resolveEbCampaign("#4")) as { error: string }).error, /No EmailBison campaign #4/);
});

test("pause: the preview names the campaign and its LIVE status; confirm runs Campaign Analytics' Pause in the person's name; not sending — refused", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(mod.campaignPause, { campaign: "#1" }, d);
  assert.equal(p.preview, `Pause "Howe 1 + Nicole + Atlanta" (#1, active now). Its emails stop going out until it is started again.`);
  assert.deepEqual(calls, [], "the preview changed nothing");
  const done = await run(mod.campaignPause, { campaign: "#1", confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`pause [{"platform":"emailbison","id":"1"}] by eddy@brokerstaffer.com via Claude team 7`]);
  // Already paused (live): refused, nothing sent.
  reset();
  assert.match(String((await run(mod.campaignPause, { campaign: "#2" })).refused), /can't be paused: A paused campaign is not sending/);
  // It stopped sending between preview and confirm: nothing done, a fresh look.
  reset();
  const d2 = deps();
  const p2 = await run(mod.campaignPause, { campaign: "#1" }, d2);
  world.live.set(1, "queued");
  const r2 = await run(mod.campaignPause, { campaign: "#1", confirm: p2.confirm }, d2);
  assert.match(String(r2.refused), /Things changed since the preview/);
  assert.deepEqual(calls, []);
});

test("start: the Launch tab's summary and checks are the preview; confirm launches in the person's name; anything missing — refused with the checks", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(mod.campaignStart, { campaign: "Keyes 100% Club" }, d);
  assert.match(String(p.preview), /^Launching queues "Howe 1" \(#3\) to send to 120 leads from 5 inboxes at up to 500 emails a day\. It cannot be undone — only paused\. Checks — Sequence: 3 steps; /);
  assert.ok(!/Note:/.test(String(p.preview)), "an active client: no note");
  const done = await run(mod.campaignStart, { campaign: "Keyes 100% Club", confirm: p.confirm }, d);
  assert.deepEqual([done.done, calls], [true, ["launch 3 by eddy@brokerstaffer.com via Claude team 7"]]);
  // No leads: refused, said which check.
  reset(); world.facts = goodFacts({ leads: 0 });
  const r = await run(mod.campaignStart, { campaign: "#3" });
  assert.match(String(r.refused), /can't be started: Not ready: leads\. Checks — .*Leads: No leads attached — nobody to send to\. \(missing\)/);
  // Already sending: refused.
  reset(); world.facts = goodFacts({ status: "active" });
  assert.match(String((await run(mod.campaignStart, { campaign: "#3" })).refused), /already sending/);
  // A churned client's campaign: said, not blocked (the screen doesn't block it either).
  reset(); world.clients = [{ name: "Howe Realty Group", aliases: null, status: "churned" }];
  assert.match(String((await run(mod.campaignStart, { campaign: "#3" })).preview), /Note: Howe Realty Group is churned in the OS\.$/);
  // EmailBison refuses: nothing claimed as done.
  reset(); world.launchOk = false;
  const d3 = deps();
  const p3 = await run(mod.campaignStart, { campaign: "#3" }, d3);
  const f = await run(mod.campaignStart, { campaign: "#3", confirm: p3.confirm }, d3);
  assert.deepEqual([f.done, f.failed], [false, "EmailBison said no"]);
  // Leads removed between preview and confirm: nothing launched.
  reset();
  const d4 = deps();
  const p4 = await run(mod.campaignStart, { campaign: "#3" }, d4);
  world.facts = goodFacts({ leads: 80 });
  assert.match(String((await run(mod.campaignStart, { campaign: "#3", confirm: p4.confirm }, d4)).refused), /Things changed/);
  assert.equal(calls.length, 0);
});

test("limits: before → after in the preview, the untouched limit sent with it (the Settings tab's rule); a send limit under new leads, or no change, refused", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(mod.campaignLimits, { campaign: "#1", daily_limit: 800 }, d);
  assert.equal(p.preview, `Sending limits of "Howe 1 + Nicole + Atlanta" (#1): Daily send limit: 500 → 800; New leads per day stays 100.`);
  const done = await run(mod.campaignLimits, { campaign: "#1", daily_limit: 800, confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`settings 1 {"max_emails_per_day":800,"max_new_leads_per_day":100} by eddy@brokerstaffer.com via Claude`]);
  reset();
  assert.match(String((await run(mod.campaignLimits, { campaign: "#1", daily_limit: 50 })).refused), /Daily send limit \(50\) must be at least the new-leads-per-day limit \(100\)/);
  assert.match(String((await run(mod.campaignLimits, { campaign: "#1", daily_limit: 500 })).refused), /already has those limits/);
  assert.match(String((await run(mod.campaignLimits, { campaign: "#1" })).refused), /Give daily_limit and\/or new_leads_per_day/);
  assert.match(String((await run(mod.campaignLimits, { campaign: "#1", daily_limit: -5 })).refused), /whole number from 0 to 100,000/);
  // Both together.
  const both = await run(mod.campaignLimits, { campaign: "#1", daily_limit: 1000, new_leads_per_day: 200 });
  assert.equal(both.preview, `Sending limits of "Howe 1 + Nicole + Atlanta" (#1): Daily send limit: 500 → 1,000; New leads per day: 100 → 200.`);
  assert.deepEqual(calls, []);
});

test("add inboxes: by tag or by address; only healthy ones, said why; confirm runs the Inboxes page's own add, from Claude; a finished campaign or no healthy inbox — refused", { skip }, async () => {
  await load(); reset();
  world.unhealthy = new Map([[13, "Bounce rate 4%"]]);
  const d = deps();
  const p = await run(inb.campaignAddInboxes, { campaign: "#1", tag: "pool 12" }, d);
  assert.equal(p.preview, `Add 2 inboxes tagged "pool 12" to "Howe 1 + Nicole + Atlanta" (#1, active, 12 inboxes on it now). Left out by the health rules: 1 with a bounce rate of 2% or more. Any already on it stay as they are; nothing is taken off.`);
  assert.deepEqual((p.details as { adding: string[] }).adding, ["a@pool12.co", "b@pool12.co"], "a deleted inbox and another team's are never picked");
  assert.deepEqual(calls, []);
  const done = await run(inb.campaignAddInboxes, { campaign: "#1", tag: "pool 12", confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`add 1 [11,12] by eddy@brokerstaffer.com via Claude from Claude`]);
  assert.equal((done.result as { inboxesAfter: number }).inboxesAfter, 14);
  // By address: unknown ones said.
  reset();
  const byEmail = await run(inb.campaignAddInboxes, { campaign: "#1", emails: ["E@other.co", "nobody@x.co"] });
  assert.match(String(byEmail.preview), /^Add 1 inbox of the 2 addresses given to .* Not inboxes EmailBison has: nobody@x\.co\./);
  // No such tag: similar ones offered.
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", tag: "Pool" })).refused), /No inbox is tagged "Pool"\. Tags like it: Pool 12, Nicole|No inbox is tagged "Pool"\. Tags like it: Pool 12/);
  // Every one unhealthy: refused with the rule.
  reset(); world.unhealthy = new Map([[15, "Warm-up 70"]]);
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", tag: "Pool 13" })).refused), /None of the 1 inbox tagged "Pool 13" passes the health rules \(1 with a warm-up score under 90\)/);
  // A paused campaign takes inboxes (it can still send); a draft too; a completed one never.
  reset(); world.live.set(1, "completed");
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", tag: "Pool 12" })).refused), /is completed: inboxes go only on a campaign that can still send/);
  // Arguments.
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1" })).refused), /Which inboxes\?/);
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", tag: "x", emails: ["a@b.co"] })).refused), /a tag OR addresses/);
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", emails: ["nope"] })).refused), /Not email addresses: nope/);
  // An inbox turned unhealthy between preview and confirm: nothing added, a fresh preview.
  reset();
  const d2 = deps();
  const p2 = await run(inb.campaignAddInboxes, { campaign: "#1", tag: "Pool 12" }, d2);
  world.unhealthy = new Map([[12, "Bounce rate 4%"]]);
  assert.match(String((await run(inb.campaignAddInboxes, { campaign: "#1", tag: "Pool 12", confirm: p2.confirm }, d2)).refused), /Things changed/);
  assert.deepEqual(calls, []);
});


test("edit copy: one email's wording through the portal editor's planner — only that step written, plain text to HTML, read back; its rules and every refusal", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: "Hi {FIRST_NAME},\n\nWould a team in Atlanta interest you this year?" }, d);
  assert.match(String(p.preview), /^Change email 1 of "Howe 1 \+ Nicole \+ Atlanta" \(#1, active\)\. Subject stays "Quick question"\. Text now \(\d+ words\): «Hi \{FIRST_NAME\},/);
  assert.match(String(p.preview), /It has gone to 340 leads already; the new wording is for everyone who gets it from now on\.$/);
  assert.deepEqual(calls, [], "the preview wrote nothing");
  const done = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: "Hi {FIRST_NAME},\n\nWould a team in Atlanta interest you this year?", confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^update seq 55 "Howe 1 \+ Nicole \+ Atlanta" \[\[101,"Quick question","/, "only step 101, by id, in its sequence");
  assert.ok(!/103|102/.test(calls[0]), "the other emails and the A/B version untouched");
  assert.equal(calls[1], "audit edit-sequence ok by eddy@brokerstaffer.com via Claude");
  assert.equal((done.result as { confirmedInEmailBison: boolean }).confirmedInEmailBison, true);

  // An A/B version's subject.
  reset();
  const v2 = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, version: 2, subject: "Open to a move?" });
  assert.match(String(v2.preview), /^Change email 1 \(version B\) of .* Subject: "Quick q" → "Open to a move\?"\. Text stays as it is\./);

  // {CLIENT_AREA}: filled with the campaign's area before it is written; no area — refused.
  reset();
  const d3 = deps();
  const p3 = await run(edit.campaignEditCopy, { campaign: "#1", email: 2, text: "Still keen to hear about {CLIENT_AREA}, {FIRST_NAME}?" }, d3);
  await run(edit.campaignEditCopy, { campaign: "#1", email: 2, text: "Still keen to hear about {CLIENT_AREA}, {FIRST_NAME}?", confirm: p3.confirm }, d3);
  assert.match(calls[0], /\[\[103,"Quick question","[^"]*Atlanta/);
  assert.ok(!String(calls[0]).includes("CLIENT_AREA"), "EmailBison never holds the placeholder");
  reset(); world.fields = { clientName: "Howe Realty Group", area: null, alias: "Howe" };
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 2, text: "About {CLIENT_AREA}?" })).refused), /has no Area on record/);

  // The portal's rules: words, links, unknown fields.
  reset();
  const long = Array.from({ length: 130 }, () => "word").join(" ");
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: long })).refused), /130 words; the limit is 125/);
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: "See https://howe.com for more" })).refused), /link|https/i);
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: "Hi {LAST_NAME}" })).refused), /isn't a field this campaign can fill/);
  // Nothing changes; no such email or version; a finished campaign.
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, subject: "Quick question" })).refused), /already says that/);
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 5, text: "x" })).refused), /has 2 emails; there is no email 5/);
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 2, version: 2, text: "x" })).refused), /has 1 version switched on; there is no version 2/);
  world.seqStatus = "completed";
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, text: "x" })).refused), /is completed: its emails aren't changed any more/);
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1 })).refused), /Give the new subject and\/or text/);
  assert.deepEqual(calls, []);

  // Someone edits another email between preview and confirm: nothing written over it.
  reset();
  const d4 = deps();
  const p4 = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, subject: "A new subject" }, d4);
  world.seq[2].body = "<p>Edited in the OS meanwhile.</p>";
  assert.match(String((await run(edit.campaignEditCopy, { campaign: "#1", email: 1, subject: "A new subject", confirm: p4.confirm }, d4)).refused), /Things changed/);
  assert.deepEqual(calls, []);

  // EmailBison refuses: said, recorded, nothing claimed.
  reset(); world.updateFails = true;
  const d5 = deps();
  const p5 = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, subject: "A new subject" }, d5);
  const f = await run(edit.campaignEditCopy, { campaign: "#1", email: 1, subject: "A new subject", confirm: p5.confirm }, d5);
  assert.equal(f.done, false);
  assert.match(String(f.failed), /EmailBison refused the change, so nothing was saved/);
  assert.equal(calls.at(-1), "audit edit-sequence error by eddy@brokerstaffer.com via Claude");
});
