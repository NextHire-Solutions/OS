import "server-only";

import { getOnboardingDb } from "./db";
import { getAccessToken } from "./google-oauth";
import { RECENT_REPLY_MS } from "./gmail-pure";
import { decodeEntities } from "./slack-format";
import { notifySlack, slackMention, esc } from "./slack";

/*
 * Poll the connected mailbox for replies and attach them to the right client.
 * READS Gmail; sends nothing. The tool's `lib/gmail-replies.ts`.
 *
 * Matching: when the tool sends, Gmail returns a threadId which it stores on
 * the delivery. Any inbox message on that same thread is a reply from that
 * client. Idempotent via gmail_message_id.
 */

async function gapi(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me" + path, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`gmail api ${res.status}: ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
}

export async function pollReplies(): Promise<{ scanned: number; matched: number }> {
  const auth = await getAccessToken();
  if (!auth) throw new Error("Google not connected — connect an account in Onboarding › Settings");
  const token = auth.token;
  const db = getOnboardingDb();

  // thread -> client, from our sent emails
  const { data: dels } = await db.from("orch_connector_deliveries")
    .select("client_id, response").eq("target", "email").eq("status", "ok");
  const threadToClient = new Map<string, string>();
  for (const d of (dels ?? []) as { client_id: string | null; response: { threadId?: string } | null }[]) {
    const tid = d.response?.threadId;
    if (tid && d.client_id) threadToClient.set(tid, d.client_id);
  }
  if (threadToClient.size === 0) return { scanned: 0, matched: 0 };

  // Our own address — mail we sent can bounce back into the inbox (forward loops,
  // group copies) on the same thread; that must never count as a client reply.
  const profile = await gapi(token, "/profile").catch(() => null);
  const self = String(profile?.emailAddress ?? "").toLowerCase();

  const list = await gapi(token, `/messages?q=${encodeURIComponent("in:inbox newer_than:14d")}&maxResults=100`);
  const messages = ((list.messages ?? []) as { id: string; threadId: string }[]);

  // Which of these are already stored? Only genuinely NEW replies get a Slack ping.
  const candidates = messages.filter((m) => threadToClient.has(m.threadId));
  const { data: knownRows } = candidates.length
    ? await db.from("orch_email_replies").select("gmail_message_id").in("gmail_message_id", candidates.map((m) => m.id))
    : { data: [] as { gmail_message_id: string }[] };
  const known = new Set(((knownRows ?? []) as { gmail_message_id: string }[]).map((r) => r.gmail_message_id));

  let matched = 0;
  const fresh: { clientId: string; from: string; subject: string; snippet: string }[] = [];
  for (const m of candidates) {
    const clientId = threadToClient.get(m.threadId)!;
    const full = await gapi(token, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const payload = (full.payload ?? {}) as { headers?: { name: string; value: string }[] };
    const headers: Record<string, string> = Object.fromEntries(
      (payload.headers ?? []).map((h) => [String(h.name).toLowerCase(), h.value]),
    );
    if (self && (headers["from"] ?? "").toLowerCase().includes(self)) continue; // our own mail
    const snippet = String(full.snippet ?? "");
    const { error } = await db.from("orch_email_replies").upsert({
      client_id: clientId,
      gmail_message_id: m.id,
      thread_id: m.threadId,
      from_email: headers["from"] ?? "",
      subject: headers["subject"] ?? "",
      snippet,
      received_at: headers["date"] ? new Date(headers["date"]).toISOString() : null,
    }, { onConflict: "gmail_message_id" });
    if (!error) {
      matched++;
      const receivedMs = headers["date"] ? new Date(headers["date"]).getTime() : Date.now();
      if (!known.has(m.id) && Date.now() - receivedMs < RECENT_REPLY_MS) {
        fresh.push({ clientId, from: headers["from"] ?? "", subject: headers["subject"] ?? "", snippet });
      }
    }
  }

  // Team ping: a client replied (usually the copy-approval answer) — review + mark in the app.
  // Subject/snippet are external input: decode Gmail's entities, then Slack-escape.
  if (fresh.length) {
    const ids = [...new Set(fresh.map((r) => r.clientId))];
    const { data: cs } = await db.from("orch_clients").select("id, client_name").in("id", ids);
    const nameOf = new Map(((cs ?? []) as { id: string; client_name: string | null }[]).map((c) => [c.id, c.client_name]));
    for (const r of fresh) {
      const subject = esc(decodeEntities(r.subject));
      const snippet = esc(decodeEntities(r.snippet).slice(0, 200));
      await notifySlack({
        clientId: r.clientId, action: "client_reply",
        text: `${slackMention()} :envelope_with_arrow: Reply from *${esc(nameOf.get(r.clientId) ?? "a client")}* — “${subject}”\n> ${snippet}\nReview it in the app — if it's the copy approval, hit Mark approved.`,
      }).catch((e) => console.error("reply slack ping failed", e));
    }
  }
  return { scanned: messages.length, matched };
}
