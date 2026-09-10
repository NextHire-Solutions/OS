/*
 * Proves the Onboarding port did not lose anything.
 *
 * The workspace now WRITES to the orchestrator's tables — stages, templates,
 * settings and the roster. That is the intended architecture (the OS is
 * replacing the tool, not mirroring it), but it means a mistake here costs real
 * rows, and an unfiltered `.update()` or `.delete()` would cost all of them.
 *
 * This records every row that matters, and on a second run reports any
 * difference. Run it before a change and after; a clean diff is evidence rather
 * than assurance.
 *
 *   node scripts/onboarding-fingerprint.mjs save
 *   node scripts/onboarding-fingerprint.mjs check
 *
 * Shaped after scripts/portal-fingerprint.mjs. Read-only: it performs no writes
 * of any kind.
 *
 * `orch_clients` is fingerprinted per row rather than merely counted, because a
 * client silently losing its stage or its payment flag is exactly the sort of
 * damage a row count cannot see.
 *
 * ---------------------------------------------------------------------------
 * WHY portal_url IS HASHED
 *
 * THIS REPOSITORY IS PUBLIC, and a client's portal URL ends in their access
 * token — `…/portal/<slug>-<token>` is the credential, not just an
 * address. Writing it into a file that gets committed would publish a live
 * client portal.
 *
 * A hash answers the only question this file asks — "did it change?" — without
 * being usable by anyone who reads it.
 *
 * (`.portal-fingerprint.json`, which this script is modelled on, IS committed
 * and DOES contain 57 live `portal_token` values. That is worth fixing; it is
 * not this script's to fix.)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = process.env.FP_OUT || path.join(process.cwd(), ".onboarding-fingerprint.json");

/* The tables Onboarding owns. Counted every run; none may ever shrink silently. */
const TABLES = [
  "orch_clients",
  "orch_stages",
  "orch_templates",
  "orch_settings",
  "orch_salespeople",
  "orch_introductions",
  "orch_client_team",
  "orch_client_leads",
  "orch_email_replies",
  "orch_email_account",
  "orch_connector_deliveries",
  "orch_client_fields",
];

function env() {
  const E = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
    if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return E;
}

async function snapshot() {
  const E = env();
  // Onboarding shares Agent Search's Supabase project — one database, two
  // halves, split by the orch_ prefix. See src/lib/tools/corofy/supabase.ts.
  const U = E.AGENT_SEARCH_SUPABASE_URL;
  const K = E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) {
    throw new Error("AGENT_SEARCH_SUPABASE_URL / SERVICE_ROLE_KEY missing from .env.local");
  }
  const head = { apikey: K, Authorization: `Bearer ${K}` };

  const counts = {};
  for (const t of TABLES) {
    const q = await fetch(`${U}/rest/v1/${t}?select=*&limit=1`, {
      headers: { ...head, Prefer: "count=exact", Range: "0-0" },
    });
    // A table that does not exist is recorded as absent rather than as zero —
    // "0 rows" and "no such table" are different facts.
    counts[t] = q.ok
      ? Number((q.headers.get("content-range") || "/0").split("/")[1]) || 0
      : null;
  }

  const get = async (p) => {
    const r = await fetch(`${U}/rest/v1/${p}`, { headers: head });
    if (!r.ok) throw new Error(`${p} read failed: ${r.status} ${await r.text()}`);
    return r.json();
  };

  const rawClients = await get(
    "orch_clients?select=id,client_name,stage_id,status,stripe_paid,health_status,portal_url&order=created_at",
  );
  const clients = rawClients.map((c) => ({
    ...c,
    // The token in the URL never reaches disk — only whether it changed.
    portal_url: c.portal_url
      ? `sha256:${crypto.createHash("sha256").update(c.portal_url).digest("hex").slice(0, 16)}`
      : null,
  }));
  const stages = await get("orch_stages?select=id,name,sort,color&order=sort");
  const templates = await get("orch_templates?select=id,category,key,name&order=category,sort");
  const people = await get("orch_salespeople?select=id,name,role,active&order=name");
  const settings = await get("orch_settings?select=key,value&order=key");

  return { at: new Date().toISOString(), counts, clients, stages, templates, people, settings };
}

const mode = process.argv[2] || "check";
const now = await snapshot();

const line = (t, n, was) => {
  const shown = n === null ? "absent" : String(n);
  const d =
    was === undefined || was === null || n === null
      ? ""
      : n === was
        ? " (unchanged)"
        : n > was
          ? ` (+${n - was})`
          : ` (-${was - n})`;
  return `    ${t.padEnd(28)} ${shown.padStart(8)}${d}`;
};

if (mode === "save" || !fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, JSON.stringify(now, null, 2));
  console.log(`  saved · ${now.clients.length} clients · ${now.stages.length} stages · ${now.templates.length} templates · ${now.people.length} people`);
  for (const t of TABLES) console.log(line(t, now.counts[t]));
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(OUT, "utf8"));
const problems = [];
const notes = [];

/* --- clients: the rows the workspace must never damage ------------------- */
const wasClient = new Map(before.clients.map((c) => [c.id, c]));
for (const c of now.clients) {
  const b = wasClient.get(c.id);
  if (!b) {
    notes.push(`new client "${c.client_name}" (not a fault, but new)`);
    continue;
  }
  for (const f of ["client_name", "stage_id", "status", "stripe_paid", "health_status", "portal_url"]) {
    if (b[f] !== c[f]) {
      const changed = `client "${b.client_name}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(c[f])}`;
      // A health_status change is the daily sync doing its job; the rest is not.
      (f === "health_status" ? notes : problems).push(
        f === "health_status" ? changed : `*** ${changed}`,
      );
    }
  }
  wasClient.delete(c.id);
}
for (const [, b] of wasClient) problems.push(`*** CLIENT DELETED: "${b.client_name}"`);

/* --- stages, templates and people ---------------------------------------- */
const gone = (kind, beforeRows, nowRows, label) => {
  const ids = new Set(nowRows.map((r) => r.id));
  for (const b of beforeRows) {
    if (!ids.has(b.id)) problems.push(`*** ${kind} DELETED: "${label(b)}"`);
  }
};
gone("STAGE", before.stages, now.stages, (s) => s.name);
gone("TEMPLATE", before.templates, now.templates, (t) => `${t.category}/${t.key ?? t.name}`);
gone("PERSON", before.people, now.people, (p) => `${p.name} (${p.role})`);

/* A system template losing its key would silently break the send that uses it. */
const wasTpl = new Map(before.templates.map((t) => [t.id, t]));
for (const t of now.templates) {
  const b = wasTpl.get(t.id);
  if (b && b.key !== t.key) problems.push(`*** TEMPLATE KEY CHANGED: "${b.name}" ${b.key} → ${t.key}`);
}

/* --- counts --------------------------------------------------------------- */
for (const t of TABLES) {
  const n = now.counts[t];
  const was = before.counts?.[t];
  if (was === undefined || was === null || n === null) continue;
  if (n < was) problems.push(`*** DATA LOSS: ${t} ${was} → ${n} (${was - n} rows fewer)`);
}

console.log(`  ${now.clients.length} clients · ${now.stages.length} stages · ${now.templates.length} templates · ${now.people.length} people · baseline ${before.at}`);
for (const t of TABLES) console.log(line(t, now.counts[t], before.counts?.[t]));

if (notes.length) {
  console.log("\n  notes (expected or harmless):");
  for (const n of notes) console.log(`     ${n}`);
}

if (problems.length === 0) {
  console.log("\n  ✅ no client changed · nothing deleted · no table shrank");
  process.exit(0);
}
console.log("\n  ⚠️  DIFFERENCES:");
for (const p of problems) console.log(`     ${p}`);
process.exit(problems.some((p) => p.startsWith("***")) ? 1 : 0);
