#!/usr/bin/env node
/*
 * Produces the sha256hex half of an AUTH_USERS entry.
 *   npm run hash -- 'correct horse battery staple'
 */
import { createHash } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash -- '<password>'");
  process.exit(1);
}

console.log(createHash("sha256").update(password).digest("hex"));
