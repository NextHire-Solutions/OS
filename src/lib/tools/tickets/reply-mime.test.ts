/*
 * The reply as an email (reply-mime.ts): what Gmail is handed. Headers a client's mail program threads on, names and
 * subjects in any language, and nothing typed or stored can add a header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReply, encodeHeader, formatAddress, quoteDate, replySubject, signatureText, textToHtml } from "./reply-mime.ts";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const part = (raw: string, type: string) => Buffer.from(decode(raw).split(`Content-Type: ${type}`)[1].split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString("utf8");
const base = {
  from: { email: "amy@brokerstaffer.com", name: "Amy Anderes-Damron" },
  to: [{ email: "alma@jeffcookrealestate.com", name: "Alma Nowatzke" }],
  cc: [],
  subject: "Re: Leads",
  inReplyTo: "c2@jcre",
  references: ["c1@jcre", "c2@jcre"],
  text: "Thanks Alma!",
  signatureHtml: null,
  quote: null,
  boundary: "b1",
};

test("addresses and subjects: quoted, encoded when not plain ASCII, Re: added once", () => {
  assert.equal(formatAddress({ email: "Alma@JCRE.com", name: "Alma Nowatzke" }), '"Alma Nowatzke" <alma@jcre.com>');
  assert.equal(formatAddress({ email: "a@b.co", name: 'O"Neil \\ Co' }), '"O\\"Neil \\\\ Co" <a@b.co>');
  assert.equal(formatAddress({ email: "a@b.co", name: "José Núñez" }), `=?UTF-8?B?${Buffer.from("José Núñez").toString("base64")}?= <a@b.co>`);
  assert.equal(formatAddress({ email: "a@b.co", name: null }), "a@b.co");
  assert.throws(() => formatAddress({ email: "not an address", name: null }));
  assert.throws(() => formatAddress({ email: "a@b.co>, evil@x.com", name: null }));
  assert.equal(replySubject("Leads"), "Re: Leads");
  assert.equal(replySubject("RE: Leads"), "RE: Leads");
  assert.equal(replySubject(""), "Re: (no subject)");
  assert.equal(encodeHeader("Café"), `=?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`);
});

test("threading: In-Reply-To and References name the client's email, so it lands in their conversation", () => {
  const raw = decode(buildReply(base).raw);
  assert.match(raw, /^In-Reply-To: <c2@jcre>$/m);
  assert.match(raw, /^References: <c1@jcre> <c2@jcre>$/m);
  assert.match(raw, /^Subject: Re: Leads$/m);
  assert.match(raw, /^MIME-Version: 1\.0$/m);
  assert.match(raw, /^Content-Type: multipart\/alternative; boundary="b1"$/m);
  const many = decode(buildReply({ ...base, references: Array.from({ length: 12 }, (_, i) => `id-${i}-${"x".repeat(20)}@example.com`) }).raw);
  for (const line of many.split("\r\n\r\n")[0].split("\r\n")) assert.ok(line.length <= 998, "every header line within the limit");
  assert.match(many, /^References: <id-0-/m);
  assert.match(many, /\r\n <id-\d+-/, "long References folded onto continuation lines");
});

test("nothing typed or stored can add a header (a CR/LF in a subject or a name is flattened)", () => {
  const raw = decode(buildReply({
    ...base,
    subject: "Re: hi\r\nBcc: spy@evil.com",
    to: [{ email: "alma@jeffcookrealestate.com", name: "Alma\r\nBcc: spy@evil.com" }],
    text: "Body\r\nBcc: not-a-header@x.com",
  }).raw);
  const head = raw.split("\r\n\r\n")[0];
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.equal(head.split("\r\n").filter((l) => /^[A-Za-z-]+:/.test(l)).length, head.split("\r\n").filter((l) => !l.startsWith(" ")).length);
});

test("bodies: the words as typed (escaped in HTML), the signature, the client's email quoted as Gmail does", () => {
  const r = buildReply({
    ...base,
    text: "Hi <Alma> & team,\n\nSee you at 2:30.",
    signatureHtml: "<div>Amy Anderes-Damron<br>Account Manager</div>",
    quote: { at: "2026-11-23T19:26:36Z", from: { email: "alma@jeffcookrealestate.com", name: "Alma Nowatzke" }, text: "Can you add Jeff?\nThanks" },
  });
  const text = part(r.raw, "text/plain");
  const html = part(r.raw, "text/html");
  assert.equal(text, "Hi <Alma> & team,\n\nSee you at 2:30.\n\nAmy Anderes-Damron\nAccount Manager\n\nOn Mon, Nov 23, 2026 at 2:26 PM, Alma Nowatzke <alma@jeffcookrealestate.com> wrote:\n\n> Can you add Jeff?\n> Thanks");
  assert.match(html, /^<div dir="ltr">Hi &lt;Alma&gt; &amp; team,<br><br>See you at 2:30\.<br><br><div dir="ltr" class="gmail_signature"><div>Amy Anderes-Damron<br>Account Manager<\/div><\/div><\/div>/);
  assert.match(html, /<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 23, 2026 at 2:26 PM, Alma Nowatzke &lt;<a href="mailto:alma@jeffcookrealestate\.com">alma@jeffcookrealestate\.com<\/a>&gt; wrote:<br><\/div><blockquote class="gmail_quote"/);
  assert.equal(r.text, text);
});

test("helpers: line breaks, signatures as text, the quote's date in Eastern time", () => {
  assert.equal(textToHtml("a\n\nb <c>"), "a<br><br>b &lt;c&gt;");
  assert.equal(signatureText('<div><b>Eddy</b><br>Founder &amp; CEO</div><div><a href="x">site</a></div>'), "Eddy\nFounder & CEO\nsite");
  assert.equal(signatureText(null), "");
  assert.equal(quoteDate("2026-07-04T16:05:00Z"), "Sat, Jul 4, 2026 at 12:05 PM", "summer time");
  assert.equal(quoteDate("2026-11-24T04:30:00Z"), "Mon, Nov 23, 2026 at 11:30 PM", "the team's day, not UTC's");
});

test("a long subject or name in any language: encoded words of 75 characters at most, every line within the limit (review, 24 Nov)", () => {
  const subject = "Re: " + "Pregunta sobre la facturación de noviembre y los próximos pasos del campaña ".repeat(6);
  const enc = encodeHeader(subject);
  for (const w of enc.split(" ")) assert.ok(w.length <= 75, `${w.length}: ${w}`);
  const decoded = enc.split(" ").map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1], "base64").toString("utf8")).join("");
  assert.equal(decoded, subject.trim(), "nothing lost, no character split");
  const raw = decode(buildReply({ ...base, subject, to: [{ email: "alma@jeffcookrealestate.com", name: "José Núñez de la Fuente y Rodríguez-Peña ".repeat(3) }] }).raw);
  for (const line of raw.split("\r\n\r\n")[0].split("\r\n")) assert.ok(line.length <= 998 && (line.length <= 100 || !/=\?UTF-8/.test(line)), `${line.length}: ${line.slice(0, 80)}`);
});
