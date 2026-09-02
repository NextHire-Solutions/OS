#!/usr/bin/env node
/*
 * Copies packages/bs-auth/index.ts into every app.
 *
 *   node packages/bs-auth/sync.mjs          # write the copies
 *   node packages/bs-auth/sync.mjs --check  # fail if any copy has drifted
 *
 * The apps deploy independently from separate repos, so they cannot import a
 * shared workspace package. Four copies is the trade; --check in CI is what
 * stops them quietly diverging, which is the only real failure mode of copying.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SOURCE = join(here, "index.ts");

/**
 * Where each app expects the module.
 *
 * Read from targets.json rather than hard-coded, because this same script runs
 * in two layouts: this repo (which holds only the workspace) and the local
 * integration sandbox (which holds copies of all four apps). Hard-coding would
 * mean two versions of the tool that keeps two versions from happening.
 */
const TARGETS = JSON.parse(readFileSync(join(here, "targets.json"), "utf8")).targets;

const check = process.argv.includes("--check");
const source = readFileSync(SOURCE, "utf8");
const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);

const header = `/* ---------------------------------------------------------------------------
 * GENERATED FILE — DO NOT EDIT HERE.
 *
 * Source of truth: packages/bs-auth/index.ts in the BrokerStaffer-SSO workspace.
 * Regenerate with: node packages/bs-auth/sync.mjs
 *
 * Edit the source and re-sync; edits made here are overwritten and, worse, make
 * this app verify tokens differently from every other app.
 *
 * bs-auth@${digest}
 * ------------------------------------------------------------------------- */

`;

const contents = header + source;

let drifted = 0;
let written = 0;

for (const target of TARGETS) {
  const path = join(root, target);

  if (check) {
    if (!existsSync(path)) {
      console.error(`  MISSING  ${target}`);
      drifted++;
      continue;
    }
    if (readFileSync(path, "utf8") !== contents) {
      console.error(`  DRIFTED  ${target}`);
      drifted++;
      continue;
    }
    console.log(`  ok       ${target}`);
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (existing === contents) {
    console.log(`  unchanged ${target}`);
    continue;
  }
  writeFileSync(path, contents);
  console.log(`  wrote     ${relative(root, path)}`);
  written++;
}

if (check && drifted > 0) {
  console.error(`\n${drifted} copy/copies out of sync with packages/bs-auth/index.ts.`);
  console.error("Run: node packages/bs-auth/sync.mjs");
  process.exit(1);
}

if (!check) console.log(`\nbs-auth@${digest} → ${written} written, ${TARGETS.length - written} already current.`);
