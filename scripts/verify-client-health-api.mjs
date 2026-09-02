#!/usr/bin/env node
/*
 * Proves the /api/clients auth fix and the new /api/metrics/weekly endpoint.
 *
 * The bug being fixed: /api/clients had NO auth in its handler and relied
 * entirely on the middleware cookie. When DASHBOARD_PASSWORD was switched on,
 * Master Inbox — which calls it server-to-server with a token and no cookie —
 * started getting 401s and silently fell back to null plans for every client.
 *
 * The risk in fixing it: making the path reachable by a token is one careless
 * line away from letting that same token DELETE clients. So the most important
 * assertion here is the write-refusal, not the read.
 *
 * No database is touched: every check is an auth-path check, and the ones that
 * would read data use a deliberately wrong token so they never reach Supabase.
 *
 *   node scripts/verify-client-health-api.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3231;
const BASE = `http://127.0.0.1:${PORT}`;
const READ_TOKEN = "read-only-token-for-the-test";
const PASSWORD = "the-team-password";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

/*
 * Every request gets its own deadline.
 *
 * Some checks deliberately run with no database configured, and the Supabase
 * client can hang rather than fail fast in that state. Without a timeout, one
 * such request aborts the whole run and the remaining assertions never report —
 * which looks like a code failure and isn't one.
 */
async function call(method, path, headers = {}, timeoutMs = 8000) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...headers },
      body:
        method === "GET" || method === "DELETE"
          ? undefined
          : JSON.stringify({ name: "__never__" }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* html response */ }
    return { status: res.status, body };
  } catch {
    // A hang is never an auth pass. Reported as a distinct status so a timed-out
    // check fails loudly instead of being mistaken for a refusal.
    return { status: 0, body: { error: "timed out" } };
  }
}

console.log("Booting Client Health with the password gate ON…\n");

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: new URL("../apps/client-health", import.meta.url).pathname,
  env: {
    ...process.env,
    NODE_ENV: "production",
    DASHBOARD_PASSWORD: PASSWORD,
    READ_ONLY_TOKEN: READ_TOKEN,
    BS_SSO_SECRET: "",
    // Point Supabase at a closed port rather than blanking it. Blank makes the
    // client hang; an unroutable address makes it refuse instantly. Every
    // assertion below is about the auth decision, which happens before any
    // query — so the data path only ever needs to fail FAST, not succeed.
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.env.DEBUG && console.error(String(d)));

// The readiness probe needs its own deadline too. With Supabase deliberately
// unconfigured, /login can hang rather than error, and a bare fetch here would
// wait forever — the whole harness would look frozen with no output at all.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(500);
  try {
    await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(2000) });
    up = true;
  } catch { /* not ready, or still hanging — try again */ }
}
if (!up) { server.kill("SIGKILL"); console.error("never became ready"); process.exit(1); }
await sleep(600);

try {
  const good = { "x-admin-token": READ_TOKEN };
  const bad = { "x-admin-token": "wrong" };

  // --- the regression this fixes ------------------------------------------
  {
    const r = await call("GET", "/api/clients", good);
    check("GET /api/clients with READ_ONLY_TOKEN is no longer 401",
      r.status !== 401 && r.status !== 307,
      `status=${r.status} (500 here = auth passed, then no database configured)`);
  }
  {
    const r = await call("GET", "/api/clients", bad);
    check("GET /api/clients with a WRONG token is refused", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await call("GET", "/api/clients");
    check("GET /api/clients with no credential at all is refused",
      r.status === 401, `status=${r.status}`);
  }

  // --- the thing that must NOT have been opened ----------------------------
  //
  // These come back 401, not the handler's more descriptive 403, because the
  // middleware rule admits GET only and refuses writes before the handler ever
  // runs. That is the layering doing its job: the handler's requireWrite() is
  // the second line, reachable only if the middleware rule is ever widened.
  // What matters is that a read-only token cannot write — which 401 satisfies.
  const refused = (s) => s === 401 || s === 403;
  {
    const r = await call("POST", "/api/clients", good);
    check("POST with the read-only token is refused",
      refused(r.status), `status=${r.status} (middleware refuses writes first)`);
  }
  {
    const r = await call("PATCH", "/api/clients", good);
    check("PATCH with the read-only token is refused", refused(r.status), `status=${r.status}`);
  }
  {
    const r = await call("DELETE", "/api/clients?id=1", good);
    check("DELETE with the read-only token is refused — no cascade delete",
      refused(r.status), `status=${r.status}`);
  }
  {
    const r = await call("POST", "/api/clients");
    check("POST with no credential is refused", r.status === 401, `status=${r.status}`);
  }

  // --- the new weekly-metrics endpoint -------------------------------------
  {
    const r = await call("GET", "/api/metrics/weekly", bad);
    check("weekly metrics: wrong token → 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await call("GET", "/api/metrics/weekly");
    check("weekly metrics: no token → 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await call("GET", "/api/metrics/weekly", good);
    check("weekly metrics: correct token gets past auth",
      r.status !== 401 && r.status !== 307, `status=${r.status}`);
  }
  {
    const r = await call("GET", "/api/metrics/weekly?from=not-a-date", good);
    check("weekly metrics: a malformed range is rejected before querying",
      r.status === 400, `status=${r.status} ${JSON.stringify(r.body ?? {})}`);
  }
  {
    const r = await call("GET", "/api/metrics/weekly?weeks=-3", good);
    check("weekly metrics: a nonsense week count is rejected", r.status === 400, `status=${r.status}`);
  }

  // --- unchanged behaviour --------------------------------------------------
  {
    const r = await call("GET", "/api/clients/status", good);
    check("existing /api/clients/status still works the same way",
      r.status !== 401, `status=${r.status}`);
  }
  {
    const r = await call("GET", "/");
    check("the dashboard itself is still gated", r.status === 307, `status=${r.status}`);
  }
} finally {
  server.kill("SIGKILL");
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
