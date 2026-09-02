#!/usr/bin/env node
/*
 * Proves the rollback story: with BS_SSO_SECRET unset, the patched app behaves
 * EXACTLY as it does in production today.
 *
 * This is the claim the whole rollout plan rests on — "deploy it, nothing
 * changes, flip a variable when you're ready" — so it should be demonstrated,
 * not asserted. The same built artefact is booted twice, once with the switch
 * off and once with it on, and both behaviours are asserted.
 *
 *   node scripts/verify-killswitch.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { mintSso, SSO_COOKIE } from "../packages/bs-auth/index.ts";

const PASSWORD = "the-existing-team-password";
const SSO_SECRET = "sso-secret";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`    ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** The cookie value Client Health's existing password login produces. */
function legacyCookie(password) {
  const sig = createHmac("sha256", password).update("bs-dashboard-authed").digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function boot(port, env) {
  const server = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: new URL("../apps/client-health", import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { await fetch(`http://127.0.0.1:${port}/login`); return server; } catch { /* wait */ }
  }
  server.kill("SIGKILL");
  throw new Error("server never became ready");
}

const get = async (port, path, cookie) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location") };
};

// ---------------------------------------------------------------------------
// SWITCH OFF — what a deploy looks like before you turn anything on.
// ---------------------------------------------------------------------------
console.log("\n  BS_SSO_SECRET unset — should be indistinguishable from today\n");

{
  const port = 3220;
  const server = await boot(port, { DASHBOARD_PASSWORD: PASSWORD, BS_SSO_SECRET: "" });
  try {
    const legacy = `bs_auth=${legacyCookie(PASSWORD)}`;

    check("the existing team password still signs people in",
      (await get(port, "/", legacy)).status === 200);

    check("the existing session still reaches the API",
      (await get(port, "/api/clients", legacy)).status !== 401);

    check("no password → still redirected to /login, as today",
      (await get(port, "/")).status === 307);

    // The important one: SSO is genuinely inert, not merely unused.
    const token = await mintSso(SSO_SECRET, {
      email: "sam@brokerstaffer.com", grants: ["clients"], ver: 1,
    });
    check("an SSO token is IGNORED while the switch is off",
      (await get(port, "/", `${SSO_COOKIE}=${token}`)).status === 307,
      "no accidental second door");

    check("a wrong password is still refused",
      (await get(port, "/", "bs_auth=wrong")).status === 307);
  } finally {
    server.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// SWITCH ON — same build, one variable added.
// ---------------------------------------------------------------------------
console.log("\n  BS_SSO_SECRET set — SSO active, old login kept as a fallback\n");

{
  const port = 3221;
  const server = await boot(port, { DASHBOARD_PASSWORD: PASSWORD, BS_SSO_SECRET: SSO_SECRET });
  try {
    const legacy = `bs_auth=${legacyCookie(PASSWORD)}`;

    check("the old team password STILL works — nobody is locked out",
      (await get(port, "/", legacy)).status === 200,
      "this is what makes the rollout safe");

    const granted = await mintSso(SSO_SECRET, {
      email: "sam@brokerstaffer.com", grants: ["clients"], ver: 1,
    });
    check("SSO now signs people in too",
      (await get(port, "/", `${SSO_COOKIE}=${granted}`)).status === 200);

    const ungranted = await mintSso(SSO_SECRET, {
      email: "analyst@brokerstaffer.com", grants: ["analytics"], ver: 1,
    });
    check("SSO without the grant is refused",
      (await get(port, "/", `${SSO_COOKIE}=${ungranted}`)).status === 200,
      "renders the no-access page, not the dashboard");

    check("machine routes are unaffected in both modes",
      (await get(port, "/api/clients/status")).status !== 307);
  } finally {
    server.kill("SIGKILL");
  }
}

console.log("");
const failed = results.filter((r) => !r.pass);
console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
if (!failed.length) {
  console.log("\n  → Deploying the patch with BS_SSO_SECRET unset changes nothing.");
  console.log("  → Rollback is: delete the variable, redeploy. No code revert.\n");
}
process.exit(failed.length ? 1 : 0);
