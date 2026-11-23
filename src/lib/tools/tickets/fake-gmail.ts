import { GmailError, GmailHistoryGone, type GmailHistoryPage, type GmailListPage } from "./gmail-api.ts";
import type { GmailMessage, GmailPart } from "./gmail-message.ts";

/*
 * A stand-in Gmail for tests and the local end-to-end check: one mailbox's messages, with Gmail's per-mailbox ids,
 * threads, a history feed that can expire (404), and enough of the search language for the first fill
 * (from:(a OR b) newer_than:Nd). Never used by the running OS.
 */

export interface FakeMail {
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date: number;
  html?: string;
  text?: string;
  labels?: string[];
  thread?: string;
  autoSubmitted?: string;
  /** Gmail's verdict on the sender: "pass" (default, DMARC/DKIM/SPF for the From's domain), "none" (no verdict), "fail". */
  auth?: "pass" | "none" | "fail";
  /** The raw From header, when a test needs one the builder wouldn't write (encoded words). */
  rawFrom?: string;
  attachments?: Array<{ filename: string; mime: string; size: number; cid?: string }>;
  /** Any other headers, as a real message would carry them (e.g. Google Calendar's Sender). */
  headers?: Array<{ name: string; value: string }>;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export class FakeGmail {
  private msgs: Array<{ msg: GmailMessage; mail: FakeMail; history: number }> = [];
  private hist = 100;
  /** History ids at or below this are "too old" (404). */
  historyFloor = 0;
  units = 0;
  calls: string[] = [];
  private seq = 0;

  readonly address: string;
  private readonly prefix: string;

  constructor(address: string, prefix = address.split("@")[0].slice(0, 3)) {
    this.address = address;
    this.prefix = prefix;
  }

  /** Deliver a message; returns its Gmail id. A reply joins the thread of the message it answers when there is one here. */
  deliver(mail: FakeMail): string {
    const id = `${this.prefix}${(++this.seq).toString(16).padStart(6, "0")}`;
    let thread = mail.thread;
    if (!thread) {
      const parentIds = [mail.inReplyTo, ...(mail.references ?? [])].filter(Boolean);
      thread = this.msgs.find((x) => parentIds.includes(x.mail.messageId))?.msg.threadId ?? id;
    }
    const fromAddr = (/<([^>]+)>/.exec(mail.from)?.[1] ?? mail.from).trim();
    const fromDomain = fromAddr.split("@")[1] ?? "";
    const auth = mail.auth ?? "pass";
    const headers = [
      ...(auth === "pass" ? [{ name: "Authentication-Results", value: `mx.google.com; dkim=pass header.i=@${fromDomain} header.s=s1; spf=pass (google.com: domain of ${fromAddr} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${fromAddr}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${fromDomain}` }]
        : auth === "fail" ? [{ name: "Authentication-Results", value: `mx.google.com; spf=softfail (google.com: domain of transitioning ${fromAddr} does not designate 6.6.6.6 as permitted sender) smtp.mailfrom=${fromAddr}; dmarc=fail (p=NONE) header.from=${fromDomain}` }] : []),
      { name: "From", value: mail.rawFrom ?? mail.from },
      { name: "To", value: (mail.to ?? [this.address]).join(", ") },
      ...(mail.cc?.length ? [{ name: "Cc", value: mail.cc.join(", ") }] : []),
      { name: "Subject", value: mail.subject ?? "Hello" },
      { name: "Date", value: new Date(mail.date).toUTCString() },
      ...(mail.messageId ? [{ name: "Message-ID", value: `<${mail.messageId}>` }] : []),
      ...(mail.inReplyTo ? [{ name: "In-Reply-To", value: `<${mail.inReplyTo}>` }] : []),
      ...(mail.references?.length ? [{ name: "References", value: mail.references.map((r) => `<${r}>`).join(" ") }] : []),
      ...(mail.autoSubmitted ? [{ name: "Auto-Submitted", value: mail.autoSubmitted }] : []),
      ...(mail.headers ?? []),
    ];
    const parts: GmailPart[] = [
      { partId: "0", mimeType: "multipart/alternative", parts: [
        { partId: "0.0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64(mail.text ?? (mail.html ?? "").replace(/<[^>]+>/g, "")), size: 10 } },
        ...(mail.html ? [{ partId: "0.1", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: b64(mail.html), size: mail.html.length } }] : []),
      ] },
      ...(mail.attachments ?? []).map((a, i) => ({
        partId: String(i + 1), mimeType: a.mime, filename: a.filename,
        headers: [...(a.cid ? [{ name: "Content-ID", value: `<${a.cid}>` }, { name: "Content-Disposition", value: "inline" }] : [{ name: "Content-Disposition", value: `attachment; filename="${a.filename}"` }])],
        body: { attachmentId: `att-${id}-${i}`, size: a.size },
      })),
    ];
    const msg: GmailMessage = {
      id, threadId: thread, labelIds: mail.labels ?? ["INBOX"], snippet: (mail.text ?? mail.html ?? "").replace(/<[^>]+>/g, "").slice(0, 120),
      internalDate: String(mail.date), payload: { mimeType: "multipart/mixed", headers, parts },
    };
    this.msgs.push({ msg, mail, history: ++this.hist });
    return id;
  }

  private find(id: string) {
    const m = this.msgs.find((x) => x.msg.id === id);
    if (!m) throw new GmailError(`Gmail 404 on /messages: not found`, 404);
    return m;
  }

  async profile() { this.units += 1; this.calls.push("profile"); return { emailAddress: this.address, historyId: String(this.hist) }; }

  async listMessages(q: string, pageToken?: string): Promise<GmailListPage> {
    this.units += 5;
    this.calls.push(`list ${q}`);
    const terms = (/from:\(([^)]*)\)/.exec(q)?.[1] ?? "").split(/\s+OR\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const days = Number(/newer_than:(\d+)d/.exec(q)?.[1] ?? "3650");
    const since = Date.now() - days * 86_400_000;
    const hits = this.msgs.filter(({ msg, mail }) => {
      if ((msg.labelIds ?? []).some((l) => ["SPAM", "TRASH", "DRAFT", "CHAT"].includes(l))) return false;
      if (mail.date < since) return false;
      const from = (/<([^>]+)>/.exec(mail.from)?.[1] ?? mail.from).toLowerCase();
      return !terms.length || terms.some((t) => (t.includes("@") ? from === t : from.endsWith(`@${t}`)));
    }).sort((a, b) => b.mail.date - a.mail.date);
    const start = Number(pageToken ?? 0);
    const page = hits.slice(start, start + 2);
    return { messages: page.map(({ msg }) => ({ id: msg.id, threadId: msg.threadId })), nextPageToken: start + 2 < hits.length ? String(start + 2) : undefined };
  }

  async metadata(id: string): Promise<GmailMessage> {
    this.units += 20;
    this.calls.push(`metadata ${id}`);
    const { msg } = this.find(id);
    return { ...msg, payload: { headers: msg.payload?.headers } };
  }

  async full(id: string): Promise<GmailMessage> {
    this.units += 60;
    this.calls.push(`full ${id}`);
    return structuredClone(this.find(id).msg);
  }

  async thread(id: string) {
    this.units += 40;
    this.calls.push(`thread ${id}`);
    const msgs = this.msgs.filter((x) => x.msg.threadId === id).map(({ msg }) => ({ ...msg, payload: { headers: msg.payload?.headers } }));
    if (!msgs.length) throw new GmailError("Gmail 404 on /threads: not found", 404);
    return { id, messages: msgs };
  }

  async history(startHistoryId: string): Promise<GmailHistoryPage> {
    this.units += 2;
    this.calls.push(`history ${startHistoryId}`);
    const start = Number(startHistoryId);
    if (start <= this.historyFloor) throw new GmailHistoryGone();
    const added = this.msgs.filter((x) => x.history > start);
    return {
      history: added.map((x) => ({ id: String(x.history), messagesAdded: [{ message: { id: x.msg.id, threadId: x.msg.threadId, labelIds: x.msg.labelIds } }] })),
      historyId: String(this.hist),
    };
  }

  async attachment(messageId: string, attachmentId: string) {
    this.units += 20;
    const { mail } = this.find(messageId);
    const i = Number(attachmentId.split("-").pop());
    const a = mail.attachments?.[i];
    if (!a) throw new GmailError("Gmail 404 on attachment", 404);
    return { size: a.size, data: b64(`fake ${a.filename} bytes`) };
  }
}
