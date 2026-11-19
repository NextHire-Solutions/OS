import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeWords, htmlToText, normEmail, normMessageId, parseAddressList, parseBodies, parseIdList, parseMessage, type GmailMessage } from "./gmail-message.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("address lists: names with commas, bare addresses, groups, comments, duplicates", () => {
  assert.deepEqual(parseAddressList('"Lee, Bo" <Bo.Lee@KW.com>, ann@x.com, Team: c@z.com, d@w.com;, (note) e@v.com, ann@X.com'), [
    { email: "bo.lee@kw.com", name: "Lee, Bo" },
    { email: "ann@x.com", name: null },
    { email: "c@z.com", name: null },
    { email: "d@w.com", name: null },
    { email: "e@v.com", name: null },
  ]);
  assert.deepEqual(parseAddressList("Jane Doe <jane@acme.com>"), [{ email: "jane@acme.com", name: "Jane Doe" }]);
  assert.deepEqual(parseAddressList("jane@acme.com <jane@acme.com>"), [{ email: "jane@acme.com", name: null }], "a name that is the address is no name");
  assert.deepEqual(parseAddressList('"Esc\\"aped" <q@x.com>'), [{ email: "q@x.com", name: 'Esc"aped' }]);
  assert.deepEqual(parseAddressList("undisclosed-recipients:;"), []);
  assert.deepEqual(parseAddressList(""), []);
  assert.deepEqual(parseAddressList("not an address"), []);
});

test("normEmail", () => {
  assert.equal(normEmail(" Mailto:A@B.co "), "a@b.co");
  assert.equal(normEmail("a@b"), "");
  assert.equal(normEmail(null), "");
});

test("encoded words (RFC 2047), B and Q, adjacent words joined", () => {
  assert.equal(decodeWords("=?UTF-8?B?Q2Fmw6k=?= menu"), "Café menu");
  assert.equal(decodeWords("=?iso-8859-1?Q?Caf=E9_au_lait?="), "Café au lait");
  assert.equal(decodeWords("=?utf-8?Q?a?= =?utf-8?Q?b?="), "ab");
  assert.equal(decodeWords("plain"), "plain");
});

test("message ids and reference lists", () => {
  assert.equal(normMessageId(" <CAF+x@mail.gmail.com> "), "CAF+x@mail.gmail.com");
  assert.equal(normMessageId("bare@id"), "bare@id");
  assert.equal(normMessageId(""), "");
  assert.deepEqual(parseIdList("<a@x> <b@y>\r\n <a@x>"), ["a@x", "b@y"]);
});

test("a metadata message parses: identity, threading, people, time, auto-replies", () => {
  const m: GmailMessage = {
    id: "18c1", threadId: "18c0", labelIds: ["INBOX", "UNREAD"], snippet: "It&#39;s &amp; ok", internalDate: "1763650000000",
    payload: { headers: [
      { name: "From", value: "Jane Roe <JANE@acme.com>" },
      { name: "To", value: "eddy@brokerstaffer.com, Amy <amy@brokerstaffer.com>" },
      { name: "Cc", value: "x@acme.com" },
      { name: "Subject", value: "Re:  Invoice\r\n question" },
      { name: "Message-ID", value: "<m2@acme.com>" },
      { name: "In-Reply-To", value: "<m1@brokerstaffer.com>" },
      { name: "References", value: "<m0@acme.com>" },
      { name: "Auto-Submitted", value: "auto-replied" },
    ] },
  };
  const p = parseMessage(m);
  assert.equal(p.rfcId, "m2@acme.com");
  assert.equal(p.inReplyTo, "m1@brokerstaffer.com");
  assert.deepEqual(p.refs, ["m0@acme.com", "m1@brokerstaffer.com"], "In-Reply-To joins the references");
  assert.deepEqual(p.from, { email: "jane@acme.com", name: "Jane Roe" });
  assert.deepEqual(p.to.map((a) => a.email), ["eddy@brokerstaffer.com", "amy@brokerstaffer.com"]);
  assert.equal(p.subject, "Re: Invoice question");
  assert.equal(p.snippet, "It's & ok");
  assert.equal(p.sentAt, new Date(1763650000000).toISOString());
  assert.equal(p.autoSubmitted, true);
  assert.equal(parseMessage({ ...m, payload: { headers: [{ name: "Auto-Submitted", value: "no" }] } }).autoSubmitted, false);
});

test("bodies: HTML preferred part found in nested multiparts, charsets honoured, attachments and inline images listed", () => {
  const m: GmailMessage = {
    id: "1", threadId: "1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { partId: "0", mimeType: "multipart/related", parts: [
          { partId: "0.0", mimeType: "multipart/alternative", parts: [
            { partId: "0.0.0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64("Hello Café") } },
            { partId: "0.0.1", mimeType: "text/html", headers: [{ name: "Content-Type", value: 'text/html; charset="iso-8859-1"' }], body: { data: Buffer.from("<p>Caf\xe9</p>", "latin1").toString("base64url") } },
          ] },
          { partId: "0.1", mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline" }], body: { attachmentId: "A1", size: 2048 } },
        ] },
        { partId: "1", mimeType: "application/pdf", filename: "Invoice.pdf", headers: [{ name: "Content-Disposition", value: 'attachment; filename="Invoice.pdf"' }], body: { attachmentId: "A2", size: 50123 } },
      ],
    },
  };
  const b = parseBodies(m);
  assert.equal(b.text, "Hello Café");
  assert.equal(b.html, "<p>Café</p>");
  assert.deepEqual(b.attachments, [
    { partId: "0.1", filename: "logo.png", mime: "image/png", size: 2048, cid: "logo@x", inline: true },
    { partId: "1", filename: "Invoice.pdf", mime: "application/pdf", size: 50123, cid: null, inline: false },
  ]);
});

test("a text/plain part sent as an attachment is an attachment, not the body", () => {
  const b = parseBodies({ id: "1", threadId: "1", payload: { mimeType: "multipart/mixed", parts: [
    { partId: "0", mimeType: "text/plain", body: { data: b64("Body") } },
    { partId: "1", mimeType: "text/plain", filename: "notes.txt", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "A", size: 4 } },
  ] } });
  assert.equal(b.text, "Body");
  assert.equal(b.attachments.length, 1);
});

test("htmlToText keeps lines, drops styles and tags", () => {
  assert.equal(htmlToText("<style>p{}</style><p>Hi&nbsp;there</p><div>Line<br>two</div>"), "Hi there\nLine\ntwo");
});
