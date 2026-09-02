#!/usr/bin/env node
/*
 * End-to-end proof that Analytics enforces SSO grants AND still honours its own
 * legacy cookie.
 *
 * That second half is not optional. The Command Center's status board reads
 * /api/analytics/kpis by MINTING a bsa_session cookie server-side. If this
 * change broke that path, the workspace home screen would quietly lose its KPI
 * card — a regression nobody would trace back to an auth refactor. So the
 * legacy route is asserted here, deliberately, alongside the new one.
 *
 *   node scripts/verify-analytics.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mintSso, SSO_COOKIE } from "../packages/bs-auth/index.ts";

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const SSO_SECRET = "e2e-sso-secret";
const LEGACY_SECRET = "e2e-legacy-secret";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location"), res };
}

/** Mint this app's OWN legacy cookie, the way the Command Center connector does. */
async function mintLegacy(secret, email, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const { createHmac } = await import("node:crypto");
  const expiresAt = Date.now() + ttlMs;
  const body = `${Buffer.from(email).toString("base64url")}.${expiresAt}`;
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

console.log("Booting Analytics with SSO + legacy auth…");

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: new URL("../apps/analytics", import.meta.url).pathname,
  env: {
    ...process.env,
    BS_SSO_SECRET: SSO_SECRET,
    AUTH_SECRET: LEGACY_SECRET,
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.env.DEBUG && console.error(String(d)));

let up = false;
for (let i = 0; i < 80 && !up; i++) {
  await sleep(500);
  try { await fetch(`${BASE}/login`); up = true; } catch { /* not yet */ }
}
if (!up) { server.kill("SIGKILL"); console.error("server never became ready"); process.exit(1); }
await sleep(700);
console.log("");

try {
  const now = Date.now();
  const granted = await mintSso(SSO_SECRET, {
    email: "sam@brokerstaffer.com", grants: ["analytics", "inbox"], ver: 1, now,
  });
  const ungranted = await mintSso(SSO_SECRET, {
    email: "nicole@brokerstaffer.com", grants: ["inbox", "clients"], ver: 1, now,
  });

  // --- no credential -------------------------------------------------------
  {
    const r = await get("/analytics/campaign");
    check("no token → redirected to /login",
      r.status === 307 && (r.location ?? "").includes("/login"), `status=${r.status}`);
  }
  {
    const r = await get("/api/analytics/kpis");
    check("no token → /api/analytics/kpis is 401 JSON", r.status === 401, `status=${r.status}`);
  }

  // --- SSO, wrong grant ----------------------------------------------------
  {
    const r = await get("/analytics/campaign", `${SSO_COOKIE}=${ungranted}`);
    const body = r.status === 200 ? await r.res.text() : "";
    check("SSO token without `analytics` grant → no-access page",
      r.status === 200 && body.includes("No access to Campaign Analytics"),
      `status=${r.status}`);
  }
  {
    const r = await get("/api/analytics/kpis", `${SSO_COOKIE}=${ungranted}`);
    check("SSO token without grant → API is 403", r.status === 403, `status=${r.status}`);
  }

  // --- SSO, correct grant --------------------------------------------------
  {
    const r = await get("/analytics/campaign", `${SSO_COOKIE}=${granted}`);
    check("SSO token WITH `analytics` grant → not blocked",
      r.status !== 307 && r.status !== 403, `status=${r.status}`);
  }
  {
    const r = await get("/", `${SSO_COOKIE}=${granted}`);
    check("granted user at / → redirected to the analytics home",
      r.status === 307 && (r.location ?? "").includes("/analytics/campaign"),
      `location=${r.location}`);
  }

  // --- the regression that would be invisible ------------------------------
  {
    const legacy = await mintLegacy(LEGACY_SECRET, "command-center@brokerstaffer.com");
    const r = await get("/api/analytics/kpis", `bsa_session=${legacy}`);
    check("LEGACY bsa_session still reaches the KPI route (Command Center depends on this)",
      r.status !== 401 && r.status !== 403 && r.status !== 307,
      `status=${r.status}`);
  }
  {
    const legacy = await mintLegacy(LEGACY_SECRET, "sam@brokerstaffer.com");
    const r = await get("/analytics/campaign", `bsa_session=${legacy}`);
    check("legacy cookie still opens pages during rollout",
      r.status !== 307, `status=${r.status}`);
  }

  // --- forgery and expiry --------------------------------------------------
  {
    const forged = await mintSso("attackers-secret", {
      email: "attacker@evil.com", grants: ["analytics"], ver: 1, now,
    });
    const r = await get("/analytics/campaign", `${SSO_COOKIE}=${forged}`);
    check("SSO token signed with another secret → rejected", r.status === 307, `status=${r.status}`);
  }
  {
    const stale = await mintSso(SSO_SECRET, {
      email: "sam@brokerstaffer.com", grants: ["analytics"], ver: 1,
      now: now - 40 * 60 * 1000,
    });
    const r = await get("/analytics/campaign", `${SSO_COOKIE}=${stale}`);
    check("expired SSO token → rejected", r.status === 307, `status=${r.status}`);
  }

  // --- public surfaces stay public ----------------------------------------
  {
    const r = await get("/api/cron/status");
    check("machine route /api/cron/* stays public (bearer-token auth of its own)",
      r.status !== 307, `status=${r.status}`);
  }
  {
    const r = await get("/login");
    check("login page reachable with no cookie", r.status === 200, `status=${r.status}`);
  }
  {
    const r = await get("/login", `${SSO_COOKIE}=${granted}`);
    check("signed-in user hitting /login is bounced home", r.status === 307, `status=${r.status}`);
  }

  // --- embed mode ----------------------------------------------------------
  {
    const r = await get("/analytics/campaign?embed=1", `${SSO_COOKIE}=${granted}`);
    const setCookie = r.res.headers.get("set-cookie") ?? "";
    check("?embed=1 sets bs_embed", setCookie.includes("bs_embed=1"), setCookie.slice(0, 50));
  }
} finally {
  server.kill("SIGKILL");
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
