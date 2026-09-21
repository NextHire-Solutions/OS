/*
 * Why the five products disagree about the client list — measured, per product.
 */
import { resolveAll } from "../src/lib/tools/assistant/identity.ts";

const all = await resolveAll();
const miss = (k) => all.filter((c) => !c[k]);

console.log(`CANONICAL ROSTER (Master Inbox): ${all.length} clients\n`);
console.log(`  In Campaign Analytics : ${all.length - miss("analyticsClientId").length}/${all.length}`);
console.log(`  In Client Health      : ${all.length - miss("clientHealthId").length}/${all.length}`);
console.log(`  In Agent Search       : ${all.length - miss("agentSearchClientId").length}/${all.length}`);
console.log(`  In ALL FOUR           : ${all.filter((c) => !c.missing.length).length}/${all.length}`);

console.log("\nMISSING FROM CAMPAIGN ANALYTICS:");
for (const c of miss("analyticsClientId")) console.log(`   ${c.name}`);
console.log("\nMISSING FROM CLIENT HEALTH:");
for (const c of miss("clientHealthId")) console.log(`   ${c.name}`);
console.log("\nMISSING FROM AGENT SEARCH:");
for (const c of miss("agentSearchClientId")) console.log(`   ${c.name}`);
