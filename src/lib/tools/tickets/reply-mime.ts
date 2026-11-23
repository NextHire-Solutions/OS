import type { Address } from "./gmail-message.ts";

/*
 * TICKETS — a reply from Tickets as an email (RFC 2822), built the way Gmail builds one, so the client sees an ordinary
 * reply in the same conversation: "Re: <their subject>", In-Reply-To / References pointing at their email (Gmail also
 * needs the thread id: reply.ts), the teammate's words, the inbox's own Gmail signature, and the client's email quoted
 * underneath ("On Mon, Nov 23, 2026 at 2:30 PM, Alma <alma@…> wrote:"). Plain text and HTML, both UTF-8.
 *
 * Pure: no network, no clock (the quote's time is given). Every header value has CR/LF removed, so nothing typed or
 * stored can add a header (no "Bcc:" smuggled in through a name or a subject).
 */

export interface ReplyDraft {
  from: Address;
  to: Address[];
  cc: Address[];
  /** Already "Re: …" (replySubject). */
  subject: string;
  /** Bare Message-IDs (no angle brackets), as stored. */
  inReplyTo: string | null;
  references: string[];
  /** What the teammate wrote. */
  text: string;
  /** The inbox's Gmail signature (HTML, from Gmail's settings), or null. */
  signatureHtml: string | null;
  /** The client's email being answered. */
  quote: { at: string; from: Address; text: string } | null;
  /** Fixed in tests; random otherwise. */
  boundary?: string;
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/**
 * RFC 2047 encoded words when the value isn't plain ASCII: each at most 75 characters (45 bytes of UTF-8, never
 * splitting a character), separated by spaces so a long subject or name folds onto continuation lines.
 */
export function encodeHeader(value: string): string {
  const v = oneLine(value);
  if (ASCII_PRINTABLE.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}

const EMAIL = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]+$/;

/** An address a reply can be written to (formatAddress accepts it). */
export function isSendableAddress(email: string | null | undefined): boolean {
  return EMAIL.test(oneLine(email ?? "").toLowerCase());
}

/** "Name <a@b.c>", the name quoted or encoded as needed. Throws on an address that isn't one. */
export function formatAddress(a: Address): string {
  const email = oneLine(a.email).toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`Not an email address: ${email.slice(0, 80)}`);
  const name = oneLine(a.name ?? "").replace(/[<>]/g, "");
  if (!name) return email;
  if (!ASCII_PRINTABLE.test(name)) return `${encodeHeader(name)} <${email}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>`;
}

/** "Re: Invoice" from "Invoice", "RE: Invoice" stays as it is. */
export function replySubject(subject: string | null | undefined): string {
  const s = oneLine(subject ?? "") || "(no subject)";
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What was typed, as HTML: escaped, blank lines become paragraphs' space, single line breaks stay. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? esc(line) : ""))
    .join("<br>");
}

/** A Gmail signature (HTML) as plain text, for the text part and for the screen's preview (never rendered as HTML). */
export function signatureText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Mon, Nov 23, 2026 at 2:30 PM" in the team's time zone (Eastern), as Gmail writes it. */
export function quoteDate(iso: string, timeZone = "America/New_York"): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}

const who = (a: Address) => (a.name ? `${a.name} <${a.email}>` : `<${a.email}>`);

const b64Lines = (s: string) => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");

/** A header line, folded between words when long (References can hold many ids). */
function header(name: string, value: string): string {
  const words = oneLine(value).split(" ");
  const lines: string[] = [];
  let cur = `${name}:`;
  for (const w of words) {
    if (cur.length + 1 + w.length > 76 && cur.length > name.length + 1) { lines.push(cur); cur = ` ${w}`; } else cur += ` ${w}`;
  }
  lines.push(cur);
  return lines.join("\r\n");
}

/** The email: the raw message for Gmail (base64url), and the text and HTML bodies it holds. */
export function buildReply(d: ReplyDraft): { raw: string; text: string; html: string } {
  const typed = d.text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const sigText = signatureText(d.signatureHtml);
  const textParts = [typed];
  if (sigText) textParts.push("", sigText);
  if (d.quote) {
    textParts.push("", `On ${quoteDate(d.quote.at)}, ${who(d.quote.from)} wrote:`, "");
    textParts.push(...d.quote.text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n").map((l) => (l ? `> ${l}` : ">")));
  }
  const text = textParts.join("\n");

  let html = `<div dir="ltr">${textToHtml(typed)}`;
  if (d.signatureHtml) html += `<br><br><div dir="ltr" class="gmail_signature">${d.signatureHtml}</div>`;
  html += "</div>";
  if (d.quote) {
    html += `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${esc(quoteDate(d.quote.at))}, ${esc(d.quote.from.name ?? "")} &lt;<a href="mailto:${esc(d.quote.from.email)}">${esc(d.quote.from.email)}</a>&gt; wrote:<br></div>`;
    html += `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${textToHtml(d.quote.text)}</blockquote></div>`;
  }

  const boundary = d.boundary ?? `tk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const refs = [...new Set(d.references.map((r) => oneLine(r).replace(/[<>\s]/g, "")).filter(Boolean))];
  const lines = [
    header("From", formatAddress(d.from)),
    header("To", d.to.map(formatAddress).join(", ")),
    ...(d.cc.length ? [header("Cc", d.cc.map(formatAddress).join(", "))] : []),
    header("Subject", encodeHeader(d.subject)),
    ...(d.inReplyTo ? [header("In-Reply-To", `<${oneLine(d.inReplyTo).replace(/[<>\s]/g, "")}>`)] : []),
    ...(refs.length ? [header("References", refs.map((r) => `<${r}>`).join(" "))] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(html),
    `--${boundary}--`,
    "",
  ];
  return { raw: Buffer.from(lines.join("\r\n"), "utf8").toString("base64url"), text, html };
}
