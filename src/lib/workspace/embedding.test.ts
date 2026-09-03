/*
 * Embeddability tests.
 *
 * The rule this encodes is the one the whole single-sign-on design rests on,
 * and it is easy to get subtly wrong: `a.up.railway.app` and `b.up.railway.app`
 * LOOK like a shared apex and are not, because `up.railway.app` is a public
 * suffix. Getting that wrong would ship panes that render each tool's login
 * inside the workspace and look like our bug.
 *
 *   node --test src/lib/workspace/embedding.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { canEmbed, registrableDomain } from "./embedding.ts";

// --- registrable domain ------------------------------------------------------

test("finds the shareable parent of a normal host", () => {
  assert.equal(registrableDomain("home.brokerstaffer.com"), "brokerstaffer.com");
  assert.equal(registrableDomain("inbox.brokerstaffer.com"), "brokerstaffer.com");
  assert.equal(registrableDomain("brokerstaffer.com"), "brokerstaffer.com");
});

test("public-suffix hosts have NO shareable parent", () => {
  // The crux. These look like siblings and are separate sites.
  assert.equal(registrableDomain("os-production-54e3.up.railway.app"), null);
  assert.equal(registrableDomain("alluring-ambition-production-d0b0.up.railway.app"), null);
  assert.equal(registrableDomain("anything.vercel.app"), null);
  assert.equal(registrableDomain("x.pages.dev"), null);
});

test("case and port are ignored", () => {
  assert.equal(registrableDomain("HOME.BrokerStaffer.com:443"), "brokerstaffer.com");
});

test("localhost is its own thing", () => {
  assert.equal(registrableDomain("localhost"), "localhost");
});

// --- the verdict -------------------------------------------------------------

test("two railway subdomains are NOT embeddable", () => {
  const v = canEmbed(
    "os-production-54e3.up.railway.app",
    "https://alluring-ambition-production-d0b0.up.railway.app",
  );
  assert.equal(v.embeddable, false);
  assert.equal(v.embeddable === false && v.reason, "Needs a shared domain");
  assert.match(
    v.embeddable === false ? v.detail : "",
    /separate sites/,
    "and it explains why, because 'it does not work' is not actionable",
  );
});

test("two subdomains of one real apex ARE embeddable", () => {
  // What the DNS change buys. No code change, just different hosts.
  const v = canEmbed("home.brokerstaffer.com", "https://inbox.brokerstaffer.com/inbox");
  assert.equal(v.embeddable, true);
});

test("different apexes are not embeddable, and the message names both", () => {
  const v = canEmbed("home.brokerstaffer.com", "https://app.someoneelse.com");
  assert.equal(v.embeddable, false);
  assert.match(v.embeddable === false ? v.detail : "", /brokerstaffer\.com/);
  assert.match(v.embeddable === false ? v.detail : "", /someoneelse\.com/);
});

test("same host is always fine — local development still works", () => {
  assert.equal(canEmbed("localhost:3000", "http://localhost:3000/x").embeddable, true);
});

test("a missing or malformed URL is reported, not thrown", () => {
  // A tool with no URL set must degrade to one explained pane, never a crash
  // that takes the whole shell down.
  const v = canEmbed("home.brokerstaffer.com", "");
  assert.equal(v.embeddable, false);
  assert.equal(v.embeddable === false && v.reason, "Not configured");
});
