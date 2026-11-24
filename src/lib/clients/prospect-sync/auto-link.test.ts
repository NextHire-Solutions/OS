/*
 * Areas linked to campaigns automatically (24 Nov): with Jeff Cook's own figures, measured that day from its campaigns'
 * leads (100% read-only), each of its five MLSs lands in the right market's campaign; the rest of the rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { autoLinkFor, autoLinkForMls, mlsCodesOf, normCity, type CampaignProfile } from "./auto-link.ts";

const P = (id: string, name: string, status: string, sampled: number, mls: Record<string, number>, cities: Record<string, number> = {}): CampaignProfile => ({ id, name, status, sampled, mls, cities });
const JEFF: CampaignProfile[] = [
  P("1396", "JCRE + Charleston, SC + ZF NS1 (EST)", "active", 53, { CHSMLS: 49, CMLS: 1, CANOPY: 1, TRIANGLE: 1, GGAR: 1 }),
  P("1394", "JCRE + Myrtle Beach, SC + ZF NS1 (EST)", "active", 49, { CCAR: 48, CMLS: 1 }),
  P("1393", "JCRE + Charlotte–Triad, NC + Jeff Copy (EST)", "active", 61, { CANOPY: 61 }),
  P("1283", "JCRE + Charleston–Summerville, SC + ZF NS1 (EST)", "paused", 200, { CHSMLS: 193, CMLS: 4, GGAR: 1, CCAR: 1, RESIDES: 1 }),
  P("1280", "JCRE + Columbia, SC + ZF NS1 (EST)", "paused", 200, { CMLS: 173, CHSMLS: 6, CANOPY: 5, GGAR: 7, CCAR: 8, MCRTC: 1 }),
  P("1276", "JCRE + Greenville, SC + ZF NS1 (EST)", "paused", 200, { GGAR: 173, TRIANGLE: 2, CMLS: 2, CANOPY: 9, GAMLS: 3, CHSMLS: 5, RESIDES: 3, CCAR: 3 }),
  P("1377", "JCRE 9 + Charleston, SC + ZF NS1 (EST)", "completed", 200, { CHSMLS: 187 }),
];

test("Jeff Cook, 24 Nov: each MLS goes to its own market's campaign; a sending one before a paused one", () => {
  const pick = (code: string) => autoLinkForMls(code, JEFF)?.id ?? null;
  assert.deepEqual(
    Object.fromEntries(["CHSMLS", "CCAR", "CANOPY", "CMLS", "GGAR"].map((c) => [c, pick(c)])),
    { CHSMLS: "1396", CCAR: "1394", CANOPY: "1393", CMLS: "1280", GGAR: "1276" },
  );
  const cmls = autoLinkForMls("CMLS", JEFF)!;
  assert.match(cmls.why, /^87% of its leads are CMLS agents \(paused: they'll be emailed once it's resumed\)$/);
  assert.equal(autoLinkForMls("CHSMLS", JEFF)!.why, "92% of its leads are CHSMLS agents", "Charleston (sending) before Charleston–Summerville (paused)");
  assert.equal(pick("TRIANGLE"), null, "a stray few leads never make a campaign an MLS's");
});

test("one MLS, two sending campaigns split by area: the agent's city decides (The Rafeh Group's two SOCAL campaigns)", () => {
  const rafeh = [
    P("10", "Rafeh + San Fernando Valley & North LA", "active", 200, { SOCAL: 196 }, { "van nuys": 30, sherman: 12, "santa clarita": 1 }),
    P("11", "Rafeh + Santa Clarita & Antelope Valley", "active", 200, { SOCAL: 198 }, { "santa clarita": 41, palmdale: 22, "van nuys": 1 }),
  ];
  assert.equal(autoLinkFor({ codes: ["SOCAL"], cities: ["Santa Clarita, CA", null] }, rafeh)?.id, "11");
  const vn = autoLinkFor({ codes: ["SOCAL"], cities: ["Van Nuys", "Van Nuys"] }, rafeh)!;
  assert.equal(vn.id, "10");
  assert.match(vn.why, /and it has the most from Van Nuys$/);
  assert.equal(autoLinkFor({ codes: ["SOCAL"], cities: [] }, rafeh)?.id, "11", "no city to go on: the larger share");
});

test("never a guess: drafts, finished and unreadable campaigns don't count; below a fifth (or 3 leads) is no link", () => {
  assert.equal(autoLinkForMls("X", [P("1", "Draft", "draft", 50, { X: 50 })]), null);
  assert.equal(autoLinkForMls("X", [P("1", "Done", "completed", 50, { X: 50 }), P("2", "Old", "stopped", 50, { X: 50 })]), null);
  assert.equal(autoLinkForMls("X", [P("1", "Unread", "active", 0, {})]), null);
  assert.equal(autoLinkForMls("X", [P("1", "Mixed", "active", 100, { X: 19, Y: 81 })]), null, "19% is not that MLS's campaign");
  assert.equal(autoLinkForMls("X", [P("1", "Tiny", "active", 10, { X: 2 })]), null, "two leads are not a market");
  assert.equal(autoLinkForMls("X", [P("1", "Mixed", "active", 100, { X: 30, Y: 70 })])?.id, "1", "a campaign covering several MLSs takes each with a real share (Keyes' East Florida)");
  assert.equal(autoLinkForMls("X", [P("1", "Q", "queued", 10, { X: 9 })])?.id, "1", "queued/launching count as sending");
});

test("an agent in several of the client's MLSs: its first MLS with a campaign", () => {
  assert.equal(autoLinkFor({ codes: ["TRIANGLE", "CANOPY"], cities: [] }, JEFF)?.code, "CANOPY");
  assert.equal(autoLinkFor({ codes: ["NOPE"], cities: [] }, JEFF), null);
});

test("the lead fields as they are stored", () => {
  assert.deepEqual(mlsCodesOf("FMLS | GAMLS"), ["FMLS", "GAMLS"]);
  assert.deepEqual(mlsCodesOf(" chsmls "), ["CHSMLS"]);
  assert.deepEqual(mlsCodesOf(""), []);
  assert.equal(normCity("Columbia, SC"), "columbia");
  assert.equal(normCity("  North  Charleston , SC"), "north charleston");
  assert.equal(normCity(null), "");
});

test("near-identical copies of one market (a renewal's leftovers): the newer campaign, not a point of share", () => {
  const cols = [
    P("1105", "JCRE 6 + Columbia, SC", "paused", 200, { CMLS: 172 }, { columbia: 198 }),
    P("1280", "JCRE + Columbia, SC", "paused", 200, { CMLS: 170 }, { columbia: 198 }),
  ];
  assert.equal(autoLinkFor({ codes: ["CMLS"], cities: ["Columbia"] }, cols)?.id, "1280");
  assert.equal(autoLinkForMls("CMLS", cols)?.id, "1280");
  // A real difference in share still decides.
  assert.equal(autoLinkForMls("X", [P("1", "Older but the X one", "paused", 100, { X: 90 }), P("2", "Newer, mixed", "paused", 100, { X: 40 })])?.id, "1");
});

test("access (24 Nov): Gabriel can pick where new Prospects go — the picks only, never the clean-up switch", async () => {
  const { holdsPage } = await import("../../identity/named-pages.ts");
  assert.equal(holdsPage("Gabo075823532@gmail.com", "prospects-campaigns"), true);
  assert.equal(holdsPage("amy@brokerstaffer.com", "prospects-campaigns"), false);
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("src/app/api/tools/master-inbox/campaign-cleanup/client/[id]/route.ts", "utf8");
  assert.match(route, /if \(admin \|\| holdsPage\(session\.user\.email, "prospects-campaigns"\)\) return \{ session, admin \};/);
  assert.match(route, /const PICKS_ONLY = new Set\(\["prospectsCampaignId", "prospectsByMls", "ifUpdatedAt"\]\);/);
  assert.match(route, /if \(!admin && \(!body \|\| typeof body !== "object" \|\| Object\.keys\(body\)\.some\(\(k\) => !PICKS_ONLY\.has\(k\)\)\)\) \{\s*return NextResponse\.json\(\{ error: "Only workspace admins can change that\." \}, \{ status: 403 \}\);/);
});
