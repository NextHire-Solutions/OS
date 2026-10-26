import { test } from "node:test";
import assert from "node:assert/strict";

import { isPlaceholder, looksLikePhone, realValue } from "./placeholder.ts";

/* 26 Oct: Mark Simmons' phone list held "None" — the imported text, seeded in when a second number was added. */

test("an import's 'nothing' is never a value — any case, any spacing; a real value is kept, trimmed", () => {
  for (const v of ["None", " none ", "NULL", "n/a", "N/A", "-", "—", "undefined", "", "   ", null, undefined, 7]) assert.equal(isPlaceholder(v), true, JSON.stringify(v));
  assert.equal(realValue("None"), null);
  assert.equal(realValue(" 317-617-7369 "), "317-617-7369");
  assert.equal(realValue("gcaraballow@kw.com"), "gcaraballow@kw.com");
  assert.equal(isPlaceholder("Nonesuch Realty"), false, "only the whole value");
});

test("a phone has at least seven digits", () => {
  for (const ok of ["317-617-7369", "+1 (305) 555-0000", "+19044693552", "555 0142 x12"]) assert.equal(looksLikePhone(ok), true, ok);
  for (const bad of ["None", "n/a", "call me", "555-01", ""]) assert.equal(looksLikePhone(bad), false, bad);
});
