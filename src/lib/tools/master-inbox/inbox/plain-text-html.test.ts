import { test } from "node:test";
import assert from "node:assert/strict";

import { plainTextToHtml } from "./plain-text-html.ts";

/*
 * The conversion that stops a plain-text reply arriving as one wall of text.
 *
 * Found by sending a 40-paragraph reply to a real mailbox and LOOKING at it.
 * The stored row was perfect — every newline present — so a database check
 * said the send was fine. Only the rendered email showed all forty paragraphs
 * run together. These cases pin what "preserved" actually means.
 */

test("a blank line becomes a paragraph break", () => {
  assert.equal(plainTextToHtml("one\n\ntwo"), "<p>one</p><p>two</p>");
});

test("a single newline becomes a line break, not a paragraph", () => {
  assert.equal(plainTextToHtml("one\ntwo"), "<p>one<br>two</p>");
});

test("the 40-paragraph shape survives as 40 paragraphs", () => {
  const src = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}`).join("\n\n");
  const html = plainTextToHtml(src);
  assert.equal((html.match(/<p>/g) ?? []).length, 40);
  assert.match(html, /<p>Paragraph 1<\/p>/);
  assert.match(html, /<p>Paragraph 40<\/p>/);
});

test("HTML in the text is escaped, never rendered", () => {
  // A lead who writes "a < b" must not have it swallowed as a tag, and a
  // pasted "<script>" must never become one.
  assert.equal(plainTextToHtml("a < b & c > d"), "<p>a &lt; b &amp; c &gt; d</p>");
  assert.match(plainTextToHtml("<script>alert(1)</script>"), /&lt;script&gt;/);
  assert.equal(plainTextToHtml("<b>x</b>").includes("<b>"), false);
});

test("three or more newlines collapse to one paragraph break, not empty ones", () => {
  assert.equal(plainTextToHtml("one\n\n\n\ntwo"), "<p>one</p><p>two</p>");
});

test("an empty string stays empty rather than becoming an empty paragraph", () => {
  assert.equal(plainTextToHtml(""), "");
});

test("a lone newline still produces something visible", () => {
  // `<p></p>` collapses to nothing in most mail clients; `<p><br></p>` holds
  // the blank line the writer intended.
  assert.equal(plainTextToHtml("\n"), "<p><br></p>");
});

test("trailing and leading blank lines do not vanish silently", () => {
  assert.equal(plainTextToHtml("\n\nbody"), "<p><br></p><p>body</p>");
});
