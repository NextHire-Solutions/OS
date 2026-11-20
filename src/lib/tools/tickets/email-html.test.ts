import { test } from "node:test";
import assert from "node:assert/strict";

import { frameCsp, prepareEmail, textToHtml } from "./email-html.ts";

test("the frame's policy: no scripts ever, remote images only once allowed", () => {
  const off = frameCsp("https://os.brokerstaffer.com", false);
  assert.match(off, /default-src 'none'/);
  assert.match(off, /img-src data: https:\/\/os\.brokerstaffer\.com\/api\/tools\/tickets\/attachment(;|$)/, "only the attachment route of the OS");
  assert.ok(!/script-src/.test(off));
  assert.match(frameCsp("https://os.brokerstaffer.com", true), /img-src data: https:\/\/os\.brokerstaffer\.com\/api\/tools\/tickets\/attachment https: http:/);
});

test("plain text: links clickable, HTML escaped, the quoted tail folded", () => {
  const html = textToHtml("Hi <team>, see https://x.com/a?b=1.\n\nThanks\n\nOn Tue, Nov 18, 2026 at 9:00 AM Eddy <eddy@brokerstaffer.com> wrote:\n> earlier\n> text");
  assert.match(html, /Hi &lt;team&gt;/);
  assert.match(html, /<a href="https:\/\/x\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<details class="tkq"><summary title="Show quoted text">•••<\/summary>.*On Tue, Nov 18/s);
  assert.ok(!html.split("<details")[0].includes("earlier"), "the quote is inside the fold");
});

test("plain text with no quote has no fold; > lines only at the end fold", () => {
  assert.ok(!textToHtml("Just a note").includes("<details"));
  assert.ok(textToHtml("Reply\n\n> old\n> older").includes("<details"));
  assert.ok(!textToHtml("> a quote at the top\nthen my words").includes("<details"));
});

test("without a browser DOM the HTML falls back to the escaped text, never raw HTML", () => {
  const p = prepareEmail({ html: "<script>alert(1)</script><p>Hi</p>", text: "Hi", messageId: "m", attachments: [], showImages: false, origin: "https://os.example" });
  assert.ok(!p.doc.includes("<script>alert"));
  assert.match(p.doc, /Content-Security-Policy/);
  assert.match(p.doc, /<base target="_blank">/);
});
