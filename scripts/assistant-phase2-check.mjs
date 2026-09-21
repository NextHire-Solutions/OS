/*
 * The phase-2 tools, against the live estate, then through the real model.
 *
 * Each figure here is one a person could contradict by opening the matching
 * screen. That is the only standard that matters for an assistant which will
 * be believed.
 */
import { campaignsForClientTool, scrapeActivityTool, inboxActivityTool, replyAgentStatusTool } from "../src/lib/tools/assistant/tools-phase2.ts";

console.log("=== campaigns_for_client: The Keyes Company (active only) ===");
const c = await campaignsForClientTool("The Keyes Company", { activeOnly: true });
if ("campaigns" in c) {
  console.log(`  ${c.total} active`);
  for (const r of c.campaigns.slice(0, 4)) {
    console.log(`    ${r.name.slice(0, 40).padEnd(42)} ${r.platform.padEnd(11)} sent ${String(r.emailsSent).padStart(6)}  replies ${String(r.replies).padStart(4)}  ${r.replyRate != null ? (r.replyRate * 100).toFixed(2) + "%" : "-"}`);
  }
} else console.log("  ", JSON.stringify(c).slice(0, 200));

console.log("\n=== campaigns_for_client: a client NOT linked to Analytics ===");
console.log("  ", JSON.stringify(await campaignsForClientTool("Cardinal Realty Group")).slice(0, 210));

console.log("\n=== scrape_activity: latest runs across the business ===");
const s = await scrapeActivityTool({ limit: 5 });
if ("batches" in s) for (const b of s.batches) {
  console.log(`  ${String(b.at).slice(0,10)}  ${b.campaign.slice(0,38).padEnd(40)} ${String(b.status).padEnd(6)} agents ${String(b.agents).padStart(5)}  with email ${String(b.withEmail).padStart(5)}  sent ${String(b.sent).padStart(5)}`);
} else console.log("  ", JSON.stringify(s).slice(0,200));

console.log("\n=== scrape_activity: a client NOT linked to Agent Search ===");
console.log("  ", JSON.stringify(await scrapeActivityTool({ client: "Brooklyn Group" })).slice(0, 210));

console.log("\n=== inbox_activity: last 30 days ===");
const i = await inboxActivityTool({ days: 30 });
if ("byLabel" in i) {
  console.log(`  ${i.totalLabelled} labelled replies since ${String(i.since).slice(0,10)}`);
  for (const l of i.byLabel.slice(0, 8)) console.log(`    ${l.label.padEnd(24)} ${String(l.replies).padStart(5)}`);
} else console.log("  ", JSON.stringify(i).slice(0,200));

console.log("\n=== reply_agent_status ===");
const a = await replyAgentStatusTool();
if ("agents" in a) for (const x of a.agents) {
  console.log(`  ${x.name.padEnd(20)} mode=${x.mode.padEnd(7)} active=${x.active}  covers=${x.clients}  drafted=${x.drafted}  held=${x.heldBySafetyGate}  handedOver=${x.handedOver}`);
} else console.log("  ", JSON.stringify(a).slice(0,200));
