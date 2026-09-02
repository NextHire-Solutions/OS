#!/usr/bin/env node
/*
 * Two jobs.
 *
 * 1. CROSS-IMPLEMENTATION: mint tokens with the TypeScript library and verify
 *    them with the hand-ported JavaScript one. This is the guarantee that the
 *    port cannot drift. If someone changes the payload shape, the encoding or
 *    the skew window on one side only, this fails — instead of Agent Search
 *    quietly rejecting every valid session in production, which would present
 *    as "the scraper logged me out" and take a day to trace.
 *
 * 2. END-TO-END: boot the real Express server and prove the gate covers the UI
 *    as well as the API, and that the credential-storing routes are shut.
 *
 *   node scripts/verify-agent-search.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { mintSso, SSO_COOKIE } from "../packages/bs-auth/index.ts";
import {
  hasGrant as jsHasGrant,
  readSsoCookie as jsReadCookie,
  verifySso as jsVerify,
} from "../apps/agent-search/web/server/bs-auth.js";

const SECRET = "e2e-sso-secret";
const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
console.log("Cross-implementation: TypeScript mints → JavaScript verifies\n");

{
  const now = Date.now();

  const token = await mintSso(SECRET, {
    email: "Sam@BrokerStaffer.com", grants: ["search", "inbox"], ver: 3, now,
  });
  const session = await jsVerify(SECRET, token, now);

  check("JS verifier accepts a TS-minted token", !!session);
  check("email matches", session?.email === "sam@brokerstaffer.com", session?.email);
  check("grants match", JSON.stringify(session?.grants) === '["inbox","search"]',
    JSON.stringify(session?.grants));
  check("ver survives the round trip", session?.ver === 3, String(session?.ver));

  const forged = await mintSso("another-secret", {
    email: "attacker@evil.com", grants: ["search"], ver: 1, now,
  });
  check("JS verifier rejects a token signed with another secret",
    (await jsVerify(SECRET, forged, now)) === null);

  const stale = await mintSso(SECRET, {
    email: "sam@brokerstaffer.com", grants: ["search"], ver: 1,
    now: now - 40 * 60 * 1000,
  });
  check("JS verifier rejects an expired token", (await jsVerify(SECRET, stale, now)) === null);

  // Same skew window on both sides, or sessions would die at different moments
  // in different apps.
  const edge = await mintSso(SECRET, {
    email: "sam@brokerstaffer.com", grants: ["search"], ver: 1,
    now: now - 30 * 60 * 1000,
  });
  check("JS verifier applies the same 60s clock skew",
    (await jsVerify(SECRET, edge, now + 30_000)) !== null &&
    (await jsVerify(SECRET, edge, now + 61_000)) === null);

  const unknownTool = await mintSso(SECRET, {
    email: "sam@brokerstaffer.com", grants: ["search", "database"], ver: 1, now,
  });
  const narrowed = await jsVerify(SECRET, unknownTool, now);
  check("JS verifier drops unknown tools", JSON.stringify(narrowed?.grants) === '["search"]');

  check("JS hasGrant agrees", jsHasGrant(session, "search") && !jsHasGrant(session, "analytics"));
  check("JS cookie reader finds the token",
    jsReadCookie(`a=1; ${SSO_COOKIE}=xyz; b=2`) === "xyz");
  check("JS cookie reader ignores a lookalike name",
    jsReadCookie(`not_${SSO_COOKIE}=nope`) === undefined);
}

// ---------------------------------------------------------------------------
console.log("\nEnd-to-end: the real Express server\n");

const server = spawn("node", ["web/server/index.js"], {
  cwd: new URL("../apps/agent-search", import.meta.url).pathname,
  env: { ...process.env, BS_SSO_SECRET: SECRET, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
server.stdout.on("data", (d) => { bootLog += String(d); });
server.stderr.on("data", (d) => process.env.DEBUG && console.error(String(d)));

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(400);
  try { await fetch(`${BASE}/api/status`); up = true; } catch { /* not yet */ }
}
if (!up) {
  server.kill("SIGKILL");
  console.error("server never became ready");
  if (bootLog) console.error(bootLog);
  process.exit(1);
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location"), res };
}

try {
  const now = Date.now();
  const granted = `${SSO_COOKIE}=${await mintSso(SECRET, {
    email: "sam@brokerstaffer.com", grants: ["search"], ver: 1, now,
  })}`;
  const ungranted = `${SSO_COOKIE}=${await mintSso(SECRET, {
    email: "nicole@brokerstaffer.com", grants: ["inbox"], ver: 1, now,
  })}`;

  check("boot log states the auth mode", bootLog.includes("BrokerStaffer SSO"),
    (bootLog.split("\n").find((l) => l.includes("Auth:")) ?? "").trim());

  // The UI itself must be gated, not just the API.
  {
    const r = await get("/");
    check("anonymous → UI is NOT served, redirected to the workspace",
      r.status === 302 && (r.location ?? "").includes("brokerstaffer"),
      `status=${r.status} location=${r.location}`);
  }
  {
    const r = await get("/app.js");
    check("anonymous → static bundle is not served either", r.status === 302, `status=${r.status}`);
  }

  // The routes that actually matter.
  {
    const r = await get("/api/search");
    check("anonymous → /api/search is 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await get("/api/courted/account");
    check("anonymous → credential-storing route is shut", r.status === 401, `status=${r.status}`);
  }

  {
    const r = await get("/", ungranted);
    const body = await r.res.text();
    check("signed in without the `search` grant → 403 explanation, not the app",
      r.status === 403 && body.includes("No access to Agent Search"), `status=${r.status}`);
  }
  {
    const r = await get("/api/columns", ungranted);
    check("without the grant → API is 403", r.status === 403, `status=${r.status}`);
  }

  {
    const r = await get("/", granted);
    check("with the `search` grant → UI is served", r.status === 200, `status=${r.status}`);
  }
  {
    const r = await get("/api/columns", granted);
    check("with the grant → API responds", r.status === 200, `status=${r.status}`);
  }

  {
    const r = await get("/api/status");
    check("/api/status stays public (the workspace status board polls it)",
      r.status === 200, `status=${r.status}`);
  }
} finally {
  server.kill("SIGKILL");
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
