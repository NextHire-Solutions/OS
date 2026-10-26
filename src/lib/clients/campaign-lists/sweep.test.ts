/*
 * My Agents and DNC → off the client's own campaigns: the sweep, on a fake
 * database and a fake EmailBison. What must hold: off means nothing is read;
 * practice removes nothing; live removes exactly the planned campaigns of
 * the client whose switch is on; nothing is ever done twice; nothing added
 * before the switch went on is touched.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../tools/master-inbox/test/fake-postgrest.ts";
configureFakeEnvironment("MASTER_INBOX_");
for (const v of ["OS_CAMPAIGN_CLEANUP_LIVE", "OS_CAMPAIGN_CLEANUP_LIVE_ONLY", "OS_CAMPAIGN_CLEANUP"]) delete process.env[v];

const db = new FakePostgrest();
type Row = Record<string, unknown>;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // The UNIQUE dedupe_key, as Postgres enforces it.
  if (url.pathname.endsWith("/os_campaign_removals") && (init?.method ?? "GET").toUpperCase() === "POST") {
    const body = JSON.parse(String(init?.body)) as Row | Row[];
    const row = Array.isArray(body) ? body[0] : body;
    if (db.rows("os_campaign_removals").some((r) => r.dedupe_key === row.dedupe_key)) {
      return new Response(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }), { status: 409, headers: { "content-type": "application/json" } });
    }
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { sweepCampaignRemovals, saveSettings, saveClientListSettings, removeNow, checkEmail, clientListView } = await import("./sweep.ts");
const { DEMO_PORTAL_ID } = await import("../../crm-preview/demo.ts");
type ListEntry = import("./rules.ts").ListEntry;
type ListSource = import("./rules.ts").ListSource;
type Cursor = import("./sweep.ts").Cursor;

const NOW = new Date("2026-10-26T12:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

const KEYES = { id: "c-keyes", name: "Keyes", aliases: [], miClientId: "p-keyes" };
const JEFF = { id: "c-jeff", name: "Jeff Cook", aliases: [], miClientId: "p-jeff" };
const CAMPAIGNS: Record<string, { id: string; name: string; status: string }[]> = {
  "c-keyes": [{ id: "642", name: "Keyes + West Florida", status: "active" }, { id: "700", name: "Keyes + Miami", status: "paused" }],
  "c-jeff": [{ id: "653", name: "Jeff Cook + Charleston", status: "active" }],
};
/** Every address is on 642, 700, 653 and someone else's 999 — the plan must keep only the client's own. */
const LEADS = (email: string) => [{ id: email.length, email, campaigns: [642, 700, 653, 999].map((campaignId) => ({ campaignId, status: "in_sequence" })) }];

let entries: Record<ListSource, ListEntry[]>;
let removed: { campaignId: number; leadIds: number[]; actor: string }[];
let lookups: string[];
let reads: number;
/** Runs inside each removal — a person changing a switch while a pass is mid-way. */
let duringRemove: (() => Promise<void>) | null = null;

function deps(env: Record<string, string> = {}) {
  return {
    env,
    now: () => NOW,
    readEntries: async (source: ListSource, cursor: Cursor, limit: number, before: string) => {
      reads++;
      const after = (e: ListEntry) => e.created_at > cursor.at || (e.created_at === cursor.at && (cursor.id === null || e.id > cursor.id));
      return entries[source].filter((e) => after(e) && e.created_at < before).sort((a, b) => (a.created_at + a.id < b.created_at + b.id ? -1 : 1)).slice(0, limit);
    },
    clients: async () => [KEYES, JEFF],
    portals: async () => [{ id: "p-keyes", name: "Keyes", slug: "keyes" }, { id: "p-jeff", name: "Jeff Cook", slug: "jeff" }, { id: DEMO_PORTAL_ID, name: "Demo Portal", slug: "demo" }, { id: "p-orphan", name: "Nobody", slug: "nobody" }],
    campaigns: async (c: { id: string }) => CAMPAIGNS[c.id] ?? [],
    findLeads: async (email: string) => { lookups.push(email); return LEADS(email); },
    remove: async (campaignId: number, leadIds: number[], actor: string) => {
      removed.push({ campaignId, leadIds, actor });
      await duringRemove?.();
      return { ok: true, attempted: leadIds.length, applied: leadIds.length, skipped: 0, chunks: [{ size: leadIds.length, ok: true }], batchId: "b" };
    },
  };
}

function reset(settings: Row | null, clients: Row[] = []) {
  db.reset();
  removed = [];
  lookups = [];
  reads = 0;
  duringRemove = null;
  db.seed("os_campaign_list_settings", settings ? [{ id: "default", per_run: 40, updated_at: at(-60), ...settings }] : []);
  db.seed("os_campaign_list_clients", clients);
  db.seed("os_campaign_removals", []);
  db.seed("os_clients", [{ id: "c-keyes", name: "Keyes", mi_client_id: "p-keyes" }, { id: "c-jeff", name: "Jeff Cook", mi_client_id: "p-jeff" }]);
  db.seed("client_agents", []);
  db.seed("client_dnc_entries", []);
  entries = {
    my_agents: [
      { id: "a1", client_id: "p-keyes", email: "Pat@Agent.test", name: "Pat", created_at: at(-10) },
      { id: "a2", client_id: DEMO_PORTAL_ID, email: "demo@agent.test", name: "Demo", created_at: at(-9) },
      { id: "a3", client_id: "p-orphan", email: "lost@agent.test", name: "Lost", created_at: at(-8) },
      { id: "a0", client_id: "p-keyes", email: "before@agent.test", name: "Before", created_at: at(-120) },
      // Added a minute ago: held back until it is two minutes old (a slow import may still be committing around it).
      { id: "a9", client_id: "p-keyes", email: "fresh@agent.test", name: "Fresh", created_at: at(-1) },
    ],
    dnc: [
      { id: "d1", client_id: "p-jeff", email: "sam@agent.test", name: "Sam", kind: "agent", created_at: at(-7) },
      { id: "d2", client_id: "p-jeff", email: null, name: "Name Only", kind: "agent", created_at: at(-6) },
      { id: "d3", client_id: "p-jeff", email: "x@bigco.test", name: "Big Co", kind: "company", created_at: at(-5) },
    ],
  };
}

const statusOf = (id: string) => db.rows("os_campaign_removals").find((r) => r.entry_id === id)?.status;

test("switched off: nothing is read, looked up or removed", async () => {
  reset({ enabled: false, practice_mode: true, cursor_at: at(-60) });
  const r = await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(r.off, "switched off");
  assert.equal(reads, 0);
  assert.equal(lookups.length, 0);
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) });
  assert.equal((await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP: "0", OS_CAMPAIGN_CLEANUP_LIVE: "1" }))).off, "OS_CAMPAIGN_CLEANUP=0");
  assert.equal(reads, 0);
});

test("practice: every entry recorded, nothing removed, nothing before the switch, never twice", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  const r = await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(removed.length, 0, "practice removes nothing — even with the server lock open and the client on");
  assert.equal(statusOf("a1"), "practice");
  assert.equal(statusOf("a2"), "skipped", "the Demo Portal");
  assert.equal(statusOf("a3"), "skipped", "a portal with no single client");
  assert.equal(statusOf("d1"), "practice");
  assert.equal(statusOf("d2"), "skipped", "a name alone");
  assert.equal(statusOf("d3"), "skipped", "a company");
  assert.equal(statusOf("a0"), undefined, "added before the switch went on");
  assert.equal(statusOf("a9"), undefined, "too new — left for a later pass");
  assert.deepEqual(lookups, ["pat@agent.test", "sam@agent.test"], "only real addresses of real clients are looked up");
  const pat = db.rows("os_campaign_removals").find((x) => x.entry_id === "a1")!;
  assert.deepEqual((pat.campaigns as Row[]).map((c) => [c.campaignId, c.outcome]), [["642", "would_remove"], ["700", "would_remove"]], "Keyes' own campaigns only — never Jeff's 653 or someone's 999");
  assert.equal(pat.os_client_id, "c-keyes");
  assert.equal(r.claimed, 6);

  const again = await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(again.claimed, 0, "the cursor moved past them");
  assert.equal(db.rows("os_campaign_removals").length, 6);
});

test("live: only the switched-on client, only its campaigns, exactly the planned lead", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.deepEqual(removed.map((x) => [x.campaignId, x.leadIds]), [[642, ["pat@agent.test".length]], [700, ["pat@agent.test".length]]]);
  assert.match(removed[0].actor, /campaign-cleanup \(My Agents\)/);
  assert.equal(statusOf("a1"), "removed");
  assert.equal(statusOf("d1"), "practice", "Jeff's switch is off");
});

test("live, but the server lock is closed: practice", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  await sweepCampaignRemovals(deps({}));
  assert.equal(removed.length, 0);
  assert.equal(statusOf("a1"), "practice");
  const pat = db.rows("os_campaign_removals").find((x) => x.entry_id === "a1")!;
  assert.match(String((pat.campaigns as Row[])[0].reason), /OS_CAMPAIGN_CLEANUP_LIVE/);
});

test("the test fence: only the listed campaign is touched", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1", OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "700" }));
  assert.deepEqual(removed.map((x) => x.campaignId), [700]);
  assert.equal(statusOf("a1"), "partly_removed");
});

test("an entry already claimed is never acted on again", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  db.seed("os_campaign_removals", [{ dedupe_key: "my_agents:a1", source: "my_agents", entry_id: "a1", status: "removed", attempts: 1, created_at: at(-1), updated_at: at(-1) }]);
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(removed.length, 0);
  assert.equal(db.rows("os_campaign_removals").filter((r) => r.entry_id === "a1").length, 1);
});

test("switching on always starts in practice, even when asked to go straight to live", async () => {
  reset({ enabled: false, practice_mode: false, cursor_at: at(-600) });
  const s = await saveSettings({ enabled: true, practiceMode: false }, "admin@outreachify.io", undefined, NOW);
  assert.equal(s.enabled, true);
  assert.equal(s.practiceMode, true);
});

test("a switch change abandons entries claimed but not finished — they are never finished later under other switches", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(-60) });
  db.seed("os_campaign_removals", [{ dedupe_key: "my_agents:a1", source: "my_agents", entry_id: "a1", status: "pending", attempts: 1, created_at: at(-30), updated_at: at(-30) }]);
  await saveSettings({ practiceMode: false }, "admin@outreachify.io", undefined, NOW);
  assert.equal(statusOf("a1"), "skipped");
});

test("switching on, or leaving practice, starts from now", async () => {
  reset({ enabled: false, practice_mode: true, cursor_at: at(-600) });
  await saveSettings({ enabled: true }, "admin@outreachify.io", undefined, NOW);
  const s1 = db.rows("os_campaign_list_settings")[0];
  assert.equal(s1.cursor_at, NOW.toISOString());
  assert.equal(s1.cursor_id, null);
  db.rows("os_campaign_list_settings")[0].cursor_at = at(-600);
  await saveSettings({ practiceMode: false }, "admin@outreachify.io", undefined, NOW);
  assert.equal(db.rows("os_campaign_list_settings")[0].cursor_at, NOW.toISOString(), "practice week's entries are not removed by leaving practice");
  await assert.rejects(saveSettings({ enabled: false, ifUpdatedAt: "2020-01-01T00:00:00.000Z" }, "x", undefined, NOW), /changed by someone else/);
});

test("Remove now needs every gate the sweep needs — and one press acts once", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(-60) });
  await sweepCampaignRemovals(deps({}));
  const row = db.rows("os_campaign_removals").find((r) => r.entry_id === "a1")!;
  const LIVE = { OS_CAMPAIGN_CLEANUP_LIVE: "1" };
  await assert.rejects(removeNow(String(row.id), "admin@outreachify.io", deps({})), /locked/);
  await assert.rejects(removeNow(String(row.id), "admin@outreachify.io", deps(LIVE)), /practice mode/, "practice on");
  db.rows("os_campaign_list_settings")[0].practice_mode = false;
  await assert.rejects(removeNow(String(row.id), "admin@outreachify.io", deps(LIVE)), /own switch is off/, "client switch off");
  db.seed("os_campaign_list_clients", [{ os_client_id: "c-keyes", remove_enabled: true }]);
  db.rows("os_campaign_list_settings")[0].enabled = false;
  await assert.rejects(removeNow(String(row.id), "admin@outreachify.io", deps(LIVE)), /switched off/, "clean-up off");
  db.rows("os_campaign_list_settings")[0].enabled = true;
  assert.equal(removed.length, 0, "no gate closed → nothing removed so far");
  // The entry must still be on the portal's list.
  await assert.rejects(removeNow(String(row.id), "admin@outreachify.io", deps(LIVE)), /no longer on the portal/);
  db.seed("client_agents", [{ ...entries.my_agents[0] }]);
  const r = await removeNow(String(row.id), "admin@outreachify.io", deps({ ...LIVE, OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "642" }));
  assert.deepEqual(removed.map((x) => x.campaignId), [642], "the fence still applies to a person's press");
  assert.equal(r.status, "partly_removed");
  // A second press from a page that read the record before the first one finished.
  db.rows("os_campaign_removals").find((x) => x.entry_id === "a1")!.status = "partly_removed";
  const stalePress = removeNow(String(row.id), "other@outreachify.io", deps(LIVE));
  const first = removeNow(String(row.id), "admin@outreachify.io", deps(LIVE));
  const settled = await Promise.allSettled([first, stalePress]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1, "only one of two presses acts");
  const skipped = db.rows("os_campaign_removals").find((x) => x.entry_id === "d2")!;
  await assert.rejects(removeNow(String(skipped.id), "x", deps(LIVE)), /Only a practised/);
});

test("leaving practice while a pass is mid-way: the pass stops and never puts the cursor back", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }, { os_client_id: "c-jeff", remove_enabled: true }]);
  const LIVE = { OS_CAMPAIGN_CLEANUP_LIVE: "1" };
  // The first lookup is where the person flips practice off.
  let flipped = false;
  const d = deps(LIVE);
  const findLeads = d.findLeads;
  d.findLeads = async (email: string) => {
    if (!flipped) { flipped = true; await saveSettings({ practiceMode: false }, "admin@outreachify.io", undefined, NOW); }
    return findLeads(email);
  };
  const r = await sweepCampaignRemovals(d);
  assert.ok(r.stopped, "the pass ended");
  assert.equal(db.rows("os_campaign_list_settings")[0].cursor_at, NOW.toISOString(), "the cursor stays where leaving practice put it");
  // The next pass is live — and finds nothing added before practice was left.
  await sweepCampaignRemovals(deps(LIVE));
  assert.equal(removed.length, 0, "nothing added before leaving practice is removed");
  assert.equal(statusOf("d1"), undefined);
});

test("switching off while a live pass is mid-way: nothing more is removed", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }, { os_client_id: "c-jeff", remove_enabled: true }]);
  duringRemove = async () => { if (db.rows("os_campaign_list_settings")[0].enabled) await saveSettings({ enabled: false }, "admin@outreachify.io", undefined, NOW); };
  const r = await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.deepEqual(removed.map((x) => x.campaignId), [642], "the removal in flight finishes; nothing after it");
  assert.ok(r.stopped);
  assert.equal(statusOf("d1"), undefined, "Jeff's entry was never reached");
});

test("a client switched off mid-pass is not removed from", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(-60) }, [{ os_client_id: "c-keyes", remove_enabled: true }, { os_client_id: "c-jeff", remove_enabled: true }]);
  duringRemove = async () => { db.rows("os_campaign_list_clients").find((r) => r.os_client_id === "c-jeff")!.remove_enabled = false; };
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.deepEqual([...new Set(removed.map((x) => x.campaignId))], [642, 700], "Keyes only");
  assert.equal(statusOf("d1"), "practice", "Jeff's switch was read fresh — off");
});

test("a stuck entry is retried by one process only, and fails after three tries", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(1) });
  db.seed("client_agents", [{ ...entries.my_agents[0] }]);
  db.seed("os_campaign_removals", [{ dedupe_key: "my_agents:a1", source: "my_agents", entry_id: "a1", status: "pending", attempts: 1, decided_by: "sweep", settings_version: at(-60), created_at: at(-30), updated_at: at(-30) }]);
  await Promise.all([sweepCampaignRemovals(deps()), sweepCampaignRemovals(deps())]);
  assert.equal(lookups.length, 1, "two passes, one retry");
  assert.equal(statusOf("a1"), "practice");
  const row = db.rows("os_campaign_removals")[0];
  Object.assign(row, { status: "pending", attempts: 3, updated_at: at(-30) });
  await sweepCampaignRemovals(deps());
  assert.equal(statusOf("a1"), "failed");
});

test("Check one email: reads only, and says what would happen now", async () => {
  reset({ enabled: true, practice_mode: true, cursor_at: at(-60) });
  const r = await checkEmail("c-keyes", " Pat@Agent.test ", deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(r.email, "pat@agent.test");
  assert.deepEqual(r.rows.map((x) => [x.campaignId, x.wouldBe]), [["642", "practice"], ["700", "practice"]]);
  assert.equal(removed.length, 0);
  assert.equal(db.rows("os_campaign_removals").length, 0, "nothing recorded");
  await assert.rejects(checkEmail("c-keyes", "not an email", deps()), /one email address/);
});

test("a Prospects campaign must be one of the client's own", async () => {
  reset({ enabled: false, practice_mode: true, cursor_at: at(-60) });
  await assert.rejects(saveClientListSettings("c-keyes", { prospectsCampaignId: "653" }, "x", deps()), /not one of this client's/);
  const s = await saveClientListSettings("c-keyes", { prospectsCampaignId: "700" }, "x", deps());
  assert.equal(s.prospectsCampaignName, "Keyes + Miami");
  assert.equal(s.removeEnabled, false, "choosing a campaign switches nothing on");
});

test("a stuck claim is never finished under other switches, nor a person's unfinished Remove now", async () => {
  reset({ enabled: true, practice_mode: false, cursor_at: at(1) }, [{ os_client_id: "c-keyes", remove_enabled: true }]);
  db.seed("client_agents", [{ ...entries.my_agents[0] }]);
  db.seed("os_campaign_removals", [
    // Claimed by a practice pass (other switches) whose process died.
    { dedupe_key: "my_agents:a1", source: "my_agents", entry_id: "a1", status: "pending", attempts: 1, decided_by: "sweep", settings_version: at(-600), created_at: at(-30), updated_at: at(-30) },
  ]);
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(removed.length, 0);
  assert.equal(statusOf("a1"), "skipped");
  Object.assign(db.rows("os_campaign_removals")[0], { status: "pending", attempts: 2, decided_by: "admin@outreachify.io", settings_version: at(-60), updated_at: at(-30) });
  await sweepCampaignRemovals(deps({ OS_CAMPAIGN_CLEANUP_LIVE: "1" }));
  assert.equal(removed.length, 0, "a person's Remove now is never finished by the sweep");
  assert.equal(statusOf("a1"), "failed");
});

test("the Prospects campaign: pre-selected until a person picks one; a chosen one that disappears falls back to the suggestion", async () => {
  reset({ enabled: false, practice_mode: true, cursor_at: at(-60) });
  let v = await clientListView("c-keyes", deps());
  assert.ok(v.available);
  if (!v.available) return;
  assert.equal(v.prospects.source, "suggested");
  assert.equal(v.prospects.effective?.id, "642", "Keyes' sending campaign, not the paused one");
  assert.deepEqual(v.campaigns.map((c) => c.id), ["642", "700"], "sending first");
  await saveClientListSettings("c-keyes", { prospectsCampaignId: "700" }, "x", deps());
  v = await clientListView("c-keyes", deps());
  if (!v.available) return;
  assert.equal(v.prospects.source, "chosen");
  assert.equal(v.prospects.effective?.id, "700", "the person's choice wins over the suggestion");
  db.rows("os_campaign_list_clients")[0].prospects_campaign_id = "555";
  v = await clientListView("c-keyes", deps());
  if (!v.available) return;
  assert.equal(v.prospects.source, "suggested");
  assert.equal(v.prospects.savedMissing?.id, "555", "and it says the chosen one is gone");
});
