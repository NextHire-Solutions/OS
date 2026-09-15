/*
 * Bring named clients' portals up to the standard feature set.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TOUCHES
 *
 * One column — `feature_flags` — on named rows of Master Inbox's `clients`
 * table. Nothing else: not the portal token, not the slug, not the name, not
 * the pipeline. The portal URL is untouched, so every live link keeps working.
 *
 * The change IS user-visible: these portals gain the product tour, the plan
 * display, CSV upload, the source split, the integrations label and the
 * "Interview scheduled" stage. That is the point, and it is why the client list
 * is explicit rather than "everything missing flags" — "New client portal" is
 * deliberately excluded.
 *
 *   node scripts/backfill-portal-flags.mjs            dry run, shows the diff
 *   node scripts/backfill-portal-flags.mjs --apply    writes
 */
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

// Exactly these. Named, not matched by a rule, so the blast radius is readable.
const TARGETS = [
  "Cain Realty Group",
  "JPAR Iron Horse Real Estate",
  "Norvell&Co Real Estate",
  "Oz Group",
  "Wagner Real Estate Group",
];

const B = "/Users/sankalpdutt/Desktop/Code/brokerstaffer-os";
const raw = fs.readFileSync(`${B}/.env.local`, "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const URL_ = pick("MASTER_INBOX_SUPABASE_URL");
const KEY = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const { withStandardFlags, missingFlags } = await import(`${B}/src/lib/clients/portal-features.ts`);

const rows = await (await fetch(
  `${URL_}/rest/v1/clients?select=id,name,slug,portal_token,portal_enabled,feature_flags`, { headers: H })).json();

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — portal feature backfill\n${"=".repeat(68)}\n`);

let changed = 0, skipped = 0;
for (const target of TARGETS) {
  const row = rows.find((r) => r.name === target);
  if (!row) { console.log(`  ?? ${target}\n       NOT FOUND — skipped\n`); skipped++; continue; }

  const missing = missingFlags(row.feature_flags);
  if (missing.length === 0) { console.log(`  ok ${row.name}\n       already complete\n`); skipped++; continue; }

  const merged = withStandardFlags(row.feature_flags);
  console.log(`  →  ${row.name}`);
  console.log(`       portal   ${row.portal_token} (unchanged)`);
  console.log(`       adding   ${missing.join(", ")}`);

  if (APPLY) {
    const res = await fetch(`${URL_}/rest/v1/clients?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...H, prefer: "return=representation" },
      body: JSON.stringify({ feature_flags: merged }),
    });
    if (!res.ok) { console.log(`       FAILED   HTTP ${res.status} ${(await res.text()).slice(0, 140)}\n`); continue; }
    const [after] = await res.json();
    const still = missingFlags(after.feature_flags);
    console.log(`       result   ${Object.keys(after.feature_flags).length} flags${still.length ? ` — STILL MISSING ${still.join(", ")}` : " — complete"}`);
    console.log(`       portal   ${after.portal_token === row.portal_token ? "token unchanged ✓" : "TOKEN CHANGED — INVESTIGATE"}\n`);
  } else {
    console.log("");
  }
  changed++;
}

console.log("=".repeat(68));
console.log(`  ${changed} to change, ${skipped} skipped`);
if (!APPLY) console.log(`  dry run — nothing written. Re-run with --apply.`);
