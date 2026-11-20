/*
 * TICKETS — reading one Gmail API message (users.messages.get, format "metadata" or "full"). Pure: no network.
 *
 * What the sync needs from a message: who sent it and to whom, its RFC Message-ID and the ids it replies to (an
 * email's identity across mailboxes: Gmail's own ids exist per mailbox), when Google accepted it, its bodies, and
 * its attachments. Google's guides: users.messages (payload, parts, internalDate), Format (metadata/full).
 */

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

export interface Address { email: string; name: string | null }
export interface Attachment {
  partId: string;
  filename: string;
  mime: string;
  size: number;
  /** Content-ID without brackets, for an inline image referenced as cid:… in the HTML. */
  cid: string | null;
  inline: boolean;
}

export interface ParsedMessage {
  gmailId: string;
  threadId: string;
  labels: string[];
  rfcId: string;
  inReplyTo: string | null;
  refs: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  /** How many addresses the From header holds (a client's email has exactly one). */
  fromCount: number;
  subject: string;
  snippet: string;
  sentAt: string;
  autoSubmitted: boolean;
  /** Gmail's own verdict on the sender (its Authentication-Results header). */
  auth: SenderAuth;
}

export interface SenderAuth { dmarc: boolean; dkimDomains: string[]; spfDomain: string | null }

/*
 * Gmail's verdict on who really sent a message (review, 20 Nov: a forged "From: client@…" from a domain without a
 * DMARC policy still reaches the inbox). Only Google's own header counts (authserv-id mx.google.com): anyone can
 * write an Authentication-Results line into the mail they send.
 */
export function parseAuth(headers: readonly GmailHeader[] | undefined): SenderAuth {
  const out: SenderAuth = { dmarc: false, dkimDomains: [], spfDomain: null };
  const ours = (headers ?? []).filter((h) => h.name.toLowerCase() === "authentication-results" && /^\s*mx\.google\.com\s*;/i.test(h.value));
  for (const h of ours.slice(0, 1)) {
    const v = h.value.replace(/\([^)]*\)/g, " ");
    if (/\bdmarc\s*=\s*pass\b/i.test(v)) out.dmarc = true;
    for (const m of v.matchAll(/\bdkim\s*=\s*pass\b[^;]*?\bheader\.(?:i|d)\s*=\s*@?([^\s;]+)/gi)) out.dkimDomains.push(m[1].toLowerCase().replace(/^.*@/, ""));
    const spf = /\bspf\s*=\s*pass\b[^;]*?\bsmtp\.mailfrom\s*=\s*([^\s;]+)/i.exec(v);
    if (spf) out.spfDomain = spf[1].toLowerCase().replace(/^.*@/, "");
  }
  return out;
}

const aligned = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** The From address is really the sender's: DMARC passed, or DKIM / SPF passed for the From's own domain. */
export function senderVerified(fromEmail: string | null, auth: SenderAuth): boolean {
  const d = (fromEmail ?? "").split("@")[1]?.toLowerCase() ?? "";
  if (!d) return false;
  if (auth.dmarc) return true;
  return auth.dkimDomains.some((x) => aligned(x, d)) || (!!auth.spfDomain && aligned(auth.spfDomain, d));
}

export interface ParsedBodies { html: string | null; text: string | null; attachments: Attachment[] }

/** The value of the first header with this name (case-insensitive), or "". */
export function header(headers: readonly GmailHeader[] | undefined, name: string): string {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
}

/* ---------------------------------------------------------------- encoded words --- */
const decoders = new Map<string, TextDecoder>();
function decoderFor(charset: string): TextDecoder {
  const cs = (charset || "utf-8").trim().toLowerCase();
  let d = decoders.get(cs);
  if (!d) {
    try { d = new TextDecoder(cs); } catch { d = new TextDecoder("utf-8"); }
    decoders.set(cs, d);
  }
  return d;
}

/** RFC 2047 "=?utf-8?B?…?=" / "=?iso-8859-1?Q?…?=" words decoded (Gmail usually decodes them already). */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs: string, enc: string, text: string) => {
      try {
        const bytes = enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return decoderFor(cs.replace(/\*.*$/, "")).decode(bytes);
      } catch {
        return text;
      }
    });
}

/* -------------------------------------------------------------------- addresses --- */
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** One address: trimmed, lower-case; "" when it isn't one. */
export function normEmail(s: string | null | undefined): string {
  const e = String(s ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  return EMAIL_RE.test(e) ? e : "";
}

/**
 * An address-list header ("Ann <a@x.com>, \"Lee, Bo\" <b@y.com>, c@z.com, Team: d@w.com;") as addresses. Quoted
 * names may hold commas; groups are flattened; comments are dropped.
 *
 * SPLIT FIRST, DECODE AFTER (review, 20 Nov): RFC 2047 words are decoded only inside a display name, once the raw
 * header has been split. Decoding first let `=?utf-8?Q?john@client.com=2C?= <attacker@evil.com>` read as two
 * addresses with the client's first — a stranger's email filed as the client's.
 */
export function parseAddressList(value: string | null | undefined): Address[] {
  const s = String(value ?? "");
  const out: Address[] = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  let inAngle = false;
  const flush = () => {
    const a = parseOne(cur);
    if (a) out.push(a);
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === '"') inQuote = false;
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")" && depth) { depth--; continue; }
    if (depth) continue;
    if (ch === "<") inAngle = true;
    if (ch === ">") inAngle = false;
    if (!inAngle && ch === ":" && !/@/.test(cur)) { cur = ""; continue; } // "Group:" — drop the group name
    if (!inAngle && (ch === "," || ch === ";")) { flush(); continue; }
    cur += ch;
  }
  flush();
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.email) ? false : (seen.add(a.email), true)));
}

function parseOne(raw: string): Address | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(.*)<([^<>]+)>\s*$/.exec(t);
  if (m) {
    const email = normEmail(m[2]);
    if (!email) return null;
    let name = m[1].trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1);
    name = stripNul(decodeWords(name.replace(/\\(.)/g, "$1"))).replace(/\s+/g, " ").trim();
    return { email, name: name && normEmail(name) !== email ? name : null };
  }
  if (/=\?/.test(t)) return null; // an encoded word where only an address may stand
  const email = normEmail(t.replace(/^"|"$/g, ""));
  return email ? { email, name: null } : null;
}

/** Postgres refuses U+0000 in text and jsonb: one such character would fail every later sync of the mailbox. */
export function stripNul(s: string): string {
  return s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}

/* ------------------------------------------------------------------ message ids --- */
/** "<abc@mail.gmail.com>" → "abc@mail.gmail.com"; "" when there's nothing usable. */
export function normMessageId(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = /<([^<>\s]+)>/.exec(s);
  const id = (m ? m[1] : s.split(/\s+/)[0] ?? "").trim();
  return id.length >= 3 && id.length <= 995 ? id : "";
}

/** Every "<id>" in a References / In-Reply-To header, in order, once each. */
export function parseIdList(v: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(v ?? "").matchAll(/<([^<>\s]+)>/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/* ------------------------------------------------------------------- entities --- */
/** Gmail's snippet arrives HTML-entity-encoded ("it&#39;s"). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => { try { return String.fromCodePoint(Number(n)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------- the parse --- */
export function parseMessage(m: GmailMessage): ParsedMessage {
  const h = m.payload?.headers ?? [];
  const internal = Number(m.internalDate);
  const dateHeader = Date.parse(header(h, "Date"));
  const sentMs = Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dateHeader) ? dateHeader : Date.now();
  const inReplyTo = parseIdList(header(h, "In-Reply-To"))[0] ?? (normMessageId(header(h, "In-Reply-To")) || null);
  const refs = parseIdList(header(h, "References"));
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);
  const auto = header(h, "Auto-Submitted").toLowerCase();
  const precedence = header(h, "Precedence").toLowerCase();
  return {
    gmailId: m.id,
    threadId: m.threadId,
    labels: m.labelIds ?? [],
    rfcId: normMessageId(header(h, "Message-ID") || header(h, "Message-Id")),
    inReplyTo,
    refs,
    from: parseAddressList(header(h, "From"))[0] ?? null,
    fromCount: parseAddressList(header(h, "From")).length,
    to: parseAddressList(header(h, "To")),
    cc: parseAddressList(header(h, "Cc")),
    replyTo: parseAddressList(header(h, "Reply-To")),
    subject: stripNul(decodeWords(header(h, "Subject"))).replace(/\s+/g, " ").trim(),
    snippet: stripNul(decodeEntities(m.snippet ?? "")).trim(),
    sentAt: new Date(sentMs).toISOString(),
    autoSubmitted: (!!auto && auto !== "no") || /^(bulk|junk|list|auto_reply)$/.test(precedence),
    auth: parseAuth(h),
  };
}

/** The headers asked for with format=metadata — everything parseMessage reads. */
export const METADATA_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "Auto-Submitted", "Precedence", "Authentication-Results"];

function decodeData(data: string | undefined, charset: string): string {
  if (!data) return "";
  return stripNul(decoderFor(charset).decode(Buffer.from(data, "base64url")));
}

function charsetOf(p: GmailPart): string {
  return /charset\s*=\s*"?([^";\s]+)/i.exec(header(p.headers, "Content-Type"))?.[1] ?? "utf-8";
}

function isAttachmentPart(p: GmailPart): boolean {
  const disp = header(p.headers, "Content-Disposition").toLowerCase();
  return !!p.filename || disp.startsWith("attachment") || (!!p.body?.attachmentId && !/^text\/(plain|html)/i.test(p.mimeType ?? ""));
}

/** Bodies (first HTML and first plain-text part that aren't attachments) and the attachments, from a format=full message. */
export function parseBodies(m: GmailMessage): ParsedBodies {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: Attachment[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    if (p.parts?.length) {
      for (const c of p.parts) walk(c);
      return;
    }
    if (isAttachmentPart(p)) {
      const cid = normMessageId(header(p.headers, "Content-ID")) || null;
      const disp = header(p.headers, "Content-Disposition").toLowerCase();
      attachments.push({
        partId: p.partId ?? "",
        filename: stripNul(decodeWords(p.filename || (cid ? `${cid}` : "attachment"))).slice(0, 200),
        mime: mime || "application/octet-stream",
        size: Number(p.body?.size ?? 0),
        cid,
        inline: !!cid && (disp.startsWith("inline") || !disp) && mime.startsWith("image/"),
      });
      return;
    }
    if (mime === "text/html" && html === null) html = decodeData(p.body?.data, charsetOf(p));
    else if (mime === "text/plain" && text === null) text = decodeData(p.body?.data, charsetOf(p));
  };
  walk(m.payload);
  return { html, text, attachments };
}

/** Plain text from HTML, for search and the snippet when Gmail gives none. Crude on purpose; never rendered. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
