#!/usr/bin/env node
/*
 * End-to-end proof that Client Health enforces SSO grants.
 *
 * Boots the real built app with BS_SSO_SECRET set, mints tokens with the shared
 * library, and asserts the four cases that matter. Unit-testing the middleware
 * in isolation would prove the function works; this proves the wiring does —
 * matcher, cookie parsing, rewrite target and all.
 *
 *   node scripts/verify-client-health.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mintSso, SSO_COOKIE } from "../packages/bs-auth/index.ts";

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "e2e-sso-secret";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location"), res };
}

console.log("Booting Client Health with SSO enabled…");

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: new URL("../apps/client-health", import.meta.url).pathname,
  env: {
    ...process.env,
    BS_SSO_SECRET: SECRET,
    // No DASHBOARD_PASSWORD: this run tests the SSO path on its own, and proves
    // that with SSO configured and no password fallback the app fails CLOSED.
    DASHBOARD_PASSWORD: "",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let booted = false;
server.stdout.on("data", (d) => { if (String(d).includes("Ready")) booted = true; });
server.stderr.on("data", (d) => process.env.DEBUG && console.error(String(d)));

for (let i = 0; i < 60 && !booted; i++) {
  await sleep(500);
  try { await fetch(`${BASE}/login`); booted = true; } catch { /* not up yet */ }
}
if (!booted) { server.kill("SIGKILL"); console.error("server never became ready"); process.exit(1); }

await sleep(700);
console.log("");

try {
  const now = Date.now();

  // 1. No credential at all.
  {
    const r = await get("/");
    check(
      "no token → redirected to /login",
      r.status === 307 && (r.location ?? "").includes("/login"),
      `status=${r.status} location=${r.location}`,
    );
  }

  // 2. No credential, API route — must be JSON 401, not an HTML redirect,
  //    or the dashboard's fetches would silently parse a login page.
  {
    const r = await get("/api/clients");
    check("no token → /api/clients is 401 JSON", r.status === 401, `status=${r.status}`);
  }

  // 3. Valid identity, WRONG grant. The security-critical case.
  {
    const token = await mintSso(SECRET, {
      email: "analyst@brokerstaffer.com", grants: ["analytics"], ver: 1, now,
    });
    const r = await get("/", `${SSO_COOKIE}=${token}`);
    const body = r.status === 200 ? await r.res.text() : "";
    check(
      "valid token without `clients` grant → 403 page, not the dashboard",
      r.status === 200 && body.includes("No access to Client Health"),
      `status=${r.status}`,
    );
  }

  // 4. Same, on an API route → 403 JSON.
  {
    const token = await mintSso(SECRET, {
      email: "analyst@brokerstaffer.com", grants: ["analytics"], ver: 1, now,
    });
    const r = await get("/api/clients", `${SSO_COOKIE}=${token}`);
    check("valid token without grant → /api/clients is 403", r.status === 403, `status=${r.status}`);
  }

  // 5. Correct grant → through.
  {
    const token = await mintSso(SECRET, {
      email: "sam@brokerstaffer.com", grants: ["clients", "inbox"], ver: 1, now,
    });
    const r = await get("/", `${SSO_COOKIE}=${token}`);
    check("valid token WITH `clients` grant → 200", r.status === 200, `status=${r.status}`);
  }

  // 6. Forged token — right shape, wrong secret.
  {
    const token = await mintSso("attackers-own-secret", {
      email: "attacker@evil.com", grants: ["clients"], ver: 1, now,
    });
    const r = await get("/", `${SSO_COOKIE}=${token}`);
    check(
      "token signed with a different secret → rejected",
      r.status === 307 && (r.location ?? "").includes("/login"),
      `status=${r.status}`,
    );
  }

  // 7. Expired token.
  {
    const token = await mintSso(SECRET, {
      email: "sam@brokerstaffer.com", grants: ["clients"], ver: 1,
      now: now - 40 * 60 * 1000, // minted 40 min ago, TTL is 30
    });
    const r = await get("/", `${SSO_COOKIE}=${token}`);
    check("expired token → rejected", r.status === 307, `status=${r.status}`);
  }

  // 8. Machine endpoints keep their own auth and stay reachable.
  {
    const r = await get("/api/clients/status");
    check(
      "machine route /api/clients/status still bypasses the gate",
      r.status !== 307,
      `status=${r.status} (its own x-admin-token check applies)`,
    );
  }

  // 9. Embed mode sets the cookie the layout reads.
  {
    const token = await mintSso(SECRET, {
      email: "sam@brokerstaffer.com", grants: ["clients"], ver: 1, now,
    });
    const r = await get("/?embed=1", `${SSO_COOKIE}=${token}`);
    const setCookie = r.res.headers.get("set-cookie") ?? "";
    check("?embed=1 sets bs_embed cookie", setCookie.includes("bs_embed=1"), setCookie.slice(0, 60));
  }
} finally {
  server.kill("SIGKILL");
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
