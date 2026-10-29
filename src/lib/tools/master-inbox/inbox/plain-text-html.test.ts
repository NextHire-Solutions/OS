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

/*
 * emailParagraphs (29 Oct): the composer's paragraphs as every mail app shows them. Found when a client asked for
 * space between the paragraphs of an introduction — Gmail showed the whole intro run together, and the blank lines
 * added in the composer (empty <p></p>) were gone. The bodies below are those two sends, as stored.
 */
import { emailParagraphs } from "./plain-text-html.ts";

const B = "<div><br></div>";

test("emailParagraphs: a blank line between paragraphs, written as Gmail's own composer writes it", () => {
  assert.equal(emailParagraphs("<p>one</p><p>two</p>"), `<div>one</div>${B}<div>two</div>`);
});

test("emailParagraphs: each blank line the person added is one more blank line", () => {
  assert.equal(emailParagraphs("<p>one</p><p></p><p>two</p>"), `<div>one</div>${B}${B}<div>two</div>`);
  assert.equal(emailParagraphs("<p>one</p><p><br></p><p></p><p>two</p>"), `<div>one</div>${B}${B}${B}<div>two</div>`);
});

test("emailParagraphs: line breaks inside a paragraph stay as they are (the signature block)", () => {
  assert.equal(emailParagraphs("<p>Best,<br>Nicole Collins<br>Talent Acquisition</p>"), "<div>Best,<br>Nicole Collins<br>Talent Acquisition</div>");
});

test("emailParagraphs: the Jeffrey Holland introduction — every paragraph and every added blank line survives", () => {
  const sent = "<p>Hey Jeffrey,</p><p>I'd like to introduce you to Sergei Hovsepyan, Team Lead at Rise Real Estate Tujunga.</p><p></p><p>Sergei, we recently connected with Jeffrey.</p><p></p><p>I hope you have a productive conversation!</p><p></p><p>Best,<br>Nicole Collins</p>";
  const out = emailParagraphs(sent);
  assert.equal(out, `<div>Hey Jeffrey,</div>${B}<div>I'd like to introduce you to Sergei Hovsepyan, Team Lead at Rise Real Estate Tujunga.</div>${B}${B}<div>Sergei, we recently connected with Jeffrey.</div>${B}${B}<div>I hope you have a productive conversation!</div>${B}${B}<div>Best,<br>Nicole Collins</div>`);
  assert.doesNotMatch(out, /<p>/, "no bare paragraph left for a mail app to squash");
});

test("emailParagraphs: only bare <p> is touched — a signature's styled paragraphs, tables and other HTML stay byte for byte", () => {
  const sig = '<table><tr><td><p style="margin:0">Nicole Collins</p></td></tr></table>';
  assert.equal(emailParagraphs(`<p>Thanks!</p><br><br>${sig}`), `<div>Thanks!</div><br><br>${sig}`);
  assert.equal(emailParagraphs("<div>already spaced</div><div><br></div><div>fine</div>"), "<div>already spaced</div><div><br></div><div>fine</div>");
  assert.equal(emailParagraphs(""), "");
});

test("emailParagraphs: separate runs of paragraphs are spaced within themselves, not across what sits between", () => {
  assert.equal(emailParagraphs("<p>a</p><p>b</p><hr><p>c</p>"), `<div>a</div>${B}<div>b</div><hr><div>c</div>`);
  assert.equal(emailParagraphs("<ul><li><p>one</p></li><li><p>two</p></li></ul>"), "<ul><li><div>one</div></li><li><div>two</div></li></ul>");
});

test("emailParagraphs: what a reader sees in plain text is unchanged — the learning loop is not fooled", () => {
  const html = "<p>Hi Sam,</p><p>Thursday works.</p>";
  const text = (h: string) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
  assert.equal(text(emailParagraphs(html)).replace(/\s+/g, " "), "Hi Sam, Thursday works.");
});
