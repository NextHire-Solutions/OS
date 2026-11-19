import { test } from "node:test";
import assert from "node:assert/strict";

import { trimEmail, trimText } from "./quote-trim.ts";

const SECRET = "TEAM-REPLY-SECRET";

test("Gmail: the quote container and everything after it go", () => {
  const r = trimEmail(`<div dir="ltr">Thanks, that works.</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue Eddy wrote:</div><blockquote>${SECRET}</blockquote></div>`, `Thanks, that works.\n\nOn Tue, Nov 18 Eddy <eddy@brokerstaffer.com> wrote:\n> ${SECRET}`);
  assert.equal(r.trimmed, true);
  assert.ok(r.html!.includes("Thanks, that works.") && !r.html!.includes(SECRET));
  assert.ok(!r.text!.includes(SECRET) && r.text!.startsWith("Thanks"));
});

test("Outlook, Apple Mail, Yahoo and Thunderbird quote markers", () => {
  for (const html of [
    `<p>Mine</p><div id="divRplyFwdMsg"><b>From:</b> Eddy</div><div>${SECRET}</div>`,
    `<p>Mine</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p><b>From:</b> Eddy</p></div><p>${SECRET}</p>`,
    `<p>Mine</p><blockquote type="cite">${SECRET}</blockquote>`,
    `<p>Mine</p><div class="yahoo_quoted">${SECRET}</div>`,
    `<p>Mine</p><div class="moz-cite-prefix">On … wrote:</div><blockquote>${SECRET}</blockquote>`,
    `<p>Mine</p><p>---------- Forwarded message ---------</p><p>${SECRET}</p>`,
  ]) {
    const r = trimEmail(html, null);
    assert.ok(r.trimmed && !JSON.stringify(r).includes(SECRET) && JSON.stringify(r).includes("Mine"), html.slice(0, 60));
  }
});

test("a quote the HTML hides but the text shows: the HTML is dropped, the trimmed text kept", () => {
  const r = trimEmail(`<div>Mine</div><div><span>On Mon Amy wrote:</span><div>${SECRET}</div></div>`, `Mine\n\nOn Mon, Nov 17, 2026 at 9:00 AM Amy <amy@brokerstaffer.com> wrote:\n${SECRET}`);
  assert.equal(r.html, null);
  assert.equal(r.text, "Mine");
  assert.equal(r.trimmed, true);
});

test("plain text: wrapped 'On … wrote:', Original Message, Outlook From/Sent, trailing > lines", () => {
  assert.equal(trimText(`Mine\n\nOn Tue, Nov 18, 2026 at 9:00 AM Eddy Boccara <\neddy@brokerstaffer.com> wrote:\n> ${SECRET}`).text, "Mine");
  assert.equal(trimText(`Mine\n-----Original Message-----\n${SECRET}`).text, "Mine");
  assert.equal(trimText(`Mine\n\nFrom: Eddy Boccara\nSent: Tuesday\nTo: x\n\n${SECRET}`).text, "Mine");
  assert.equal(trimText(`Mine\n\n> ${SECRET}\n> more`).text, "Mine");
});

test("an email with no quote is kept whole and not marked trimmed", () => {
  const r = trimEmail("<p>Hello <b>team</b></p>", "Hello team");
  assert.deepEqual([r.html, r.trimmed], ["<p>Hello <b>team</b></p>", false]);
  assert.deepEqual(trimText("> a quote at the top\nthen my words"), { text: "> a quote at the top\nthen my words", trimmed: false });
});
