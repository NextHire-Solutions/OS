/*
 * Exercises every Master Inbox endpoint the copied UI can call.
 *
 * Reads only — nothing here writes. Write paths are tested separately and
 * bracketed by scripts/portal-fingerprint.mjs so a mistake is visible.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * A route that 401s is reported as a FAILURE unless it is listed in
 * MACHINE_ROUTES: those authenticate with a Bearer token for the downstream
 * attribution tool, and refusing a browser session is what they are supposed
 * to do.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3210";
const API = `${BASE}/api/tools/master-inbox`;

/** Machine-to-machine. A 401 here is correct behaviour, not a break. */
const MACHINE_ROUTES = new Set(["/outcomes", "/reply-labels", "/clients/status"]);

const GETS = [
  "/labels", "/lists", "/custom-views", "/reply-templates", "/reply-agents",
  "/clients", "/clients/portals", "/clients/intro-stats", "/clients/intros",
  "/ai-labeling", "/settings", "/portals", "/outbox", "/reminders",
  "/search/threads?q=test", "/metrics/follow-up-time",
  "/outcomes", "/reply-labels",
];

async function token() {
  const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
  const raw = fs.readFileSync(".env.local", "utf8");
  const pick = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const secret = pick("BS_SSO_SECRET") || pick("AUTH_SECRET");
  return mintSso(secret, { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
}

function shape(body) {
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j)) return `${j.length} items`;
    const key = Object.keys(j).find((k) => Array.isArray(j[k]));
    if (key) return `${j[key].length} ${key}`;
    return Object.keys(j).slice(0, 4).join(",") || "{}";
  } catch {
    return body.slice(0, 40).replace(/\s+/g, " ");
  }
}

const cookie = `bs_sso=${await token()}`;
let pass = 0, fail = 0;
const failures = [];

for (const path of GETS) {
  const started = Date.now();
  let res, body = "";
  try {
    res = await fetch(API + path, { headers: { cookie } });
    body = await res.text();
  } catch (e) {
    failures.push(`${path} — ${e.message}`); fail++; console.log(`  ✗ ${path.padEnd(30)} threw`);
    continue;
  }
  const ms = Date.now() - started;
  const machine = MACHINE_ROUTES.has(path.split("?")[0]);
  const ok = res.status === 200 || (machine && res.status === 401) || res.status === 405;
  const note = machine && res.status === 401 ? "bearer-only ✓" : res.status === 405 ? "no GET (POST-only)" : shape(body);
  console.log(`  ${ok ? "✓" : "✗"} ${path.padEnd(30)} ${res.status}  ${String(ms).padStart(5)}ms  ${note}`);
  if (ok) pass++; else { fail++; failures.push(`${path} → ${res.status} ${body.slice(0, 120)}`); }
}

console.log(`\n  ${pass} passed · ${fail} failed`);
if (failures.length) { console.log("\n  FAILURES:"); for (const f of failures) console.log(`    ${f}`); }
process.exit(fail ? 1 : 0);
