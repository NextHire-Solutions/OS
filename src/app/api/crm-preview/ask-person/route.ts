import { NextResponse, type NextRequest } from "next/server";

import { postToPortalChannel } from "@/lib/clients/prospect-sync/queue";
import { askPersonSlackText, cleanQuestion, PERSON_ASK, PERSON_FAILED, PERSON_REPLY, PERSON_REPLY_EMAIL, PERSON_TOO_MANY, personFollowUpSlackText, threadLink } from "@/lib/crm-preview/ask-person";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { isDemoPortal } from "@/lib/crm-preview/demo";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { firstName } from "@/lib/crm-preview/signed-in";
import { signedInPerson } from "@/lib/crm-preview/signed-in-person";
import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { isAssistantsOwn } from "@/lib/portal-chat/assistant-sign";
import { mayEmailReply, sendChatReplyEmail } from "@/lib/portal-chat/mail";
import { addMessage, addOnce, ALERT_EVERY_MS, ASKS_PER_HOUR, asksSince, awaitTold, claimAsk, clientCopy, closeThread, loadThread, markAlerted, markEmailed, markRead, MAX_MESSAGE_CHARS, releaseAsk, setHistory, startThread, teamSpokeSince, threadView, type ChatRole, type ChatThreadView, type ThreadRow } from "@/lib/portal-chat/threads";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadTeamMembers } from "@/lib/tools/master-inbox/portals/portal-data";

/*
 * The conversation with our team from the portal's chat (4 Nov; lib/portal-chat/threads.ts). The same gate as the chat.
 * POST { client, action, thread?, text?, key?, question?, turns? }:
 *
 *   ask      "Ask for a person": their conversation starts, our team hears on Slack with a link. They're told we'll get
 *            back to them only once the post has really gone, and only then can anyone see or write to it; if it hasn't
 *            gone, pressing again tries again. A few an hour per person: each one is a Slack post.
 *   say      a client writing while it's open: to our team, not the assistant
 *   read     a client has seen it
 *   leave    a client going back to the assistant: it closes
 *   reply    our team: into the client's chat, and to their email (portal-chat/mail.ts; the reply stands if that fails,
 *            and our team is shown it didn't go)
 *   resolve  our team: it closes, and the client is back with the assistant
 *
 * A client only ever touches their own conversation; anyone else's, or anything of another portal's, is a bare 404.
 * say and reply carry the window's key for what was typed: sent again after a timeout, it's saved, posted and emailed once.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OS_URL = process.env.OS_PUBLIC_URL ?? "https://os.brokerstaffer.com";
const NOT_FOUND = () => new NextResponse(null, { status: 404 });
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE_HEADERS });

const KEY = /^[A-Za-z0-9-]{8,64}$/;

/** What came before they asked, as the window sends it: plain turns only, and the assistant's only with its signature. */
function historyOf(raw: unknown, portalId: string): Parameters<typeof setHistory>[1] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): Parameters<typeof setHistory>[1] => {
    const role = (t as { role?: unknown } | null)?.role;
    const text = (t as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) return [];
    if (role === "client") return [{ role, text }];
    return role === "assistant" && isAssistantsOwn(portalId, text, (t as { sig?: unknown }).sig) ? [{ role, text }] : [];
  });
}

export async function POST(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const body = (await request.json().catch(() => null)) as { client?: unknown; action?: unknown; thread?: unknown; text?: unknown; key?: unknown; question?: unknown; turns?: unknown } | null;
  const client = typeof body?.client === "string" ? body.client : "";
  if (!UUID.test(client)) return NextResponse.json({ error: "A client is required." }, { status: 400, headers: NO_STORE_HEADERS });
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });

  const gate = admit(who, role, "chat", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ at: "[crm-preview] refused", who, kind: "ask-person", client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  const staff = viewer.kind === "staff";
  const action = typeof body?.action === "string" ? body.action : "ask";
  const now = new Date();
  try {
    const { data } = await createAdminSupabase().from("clients").select("name").eq("id", client).maybeSingle();
    const portal = (data as { name: string | null } | null)?.name?.trim();
    if (!portal) return json({ error: PERSON_FAILED }, 404);
    const test = staff || isDemoPortal(client);
    // A client is never sent whether a reply was emailed, or that it's a test: those are for our team.
    const shown = (view: ChatThreadView) => (staff ? view : clientCopy(view));
    const you = async () => signedInPerson(viewer, client, await loadTeamMembers(client)).catch(() => null);

    if (action === "ask") {
      // By name only: signedInPerson falls back to the address, and that's never stored as who they are.
      const known = (await you())?.name ?? null;
      const name = known && !known.includes("@") ? known : null;
      const reply = mayEmailReply(who) ? PERSON_REPLY_EMAIL : PERSON_REPLY;
      const answered = async (row: ThreadRow) => json({ role: viewer.kind, reply, thread: shown(await threadView(row)) });
      const row = await startThread({ portalId: client, email: who, name, test, now });
      // Already told (pressed again, or from another tab): the same answer, no second post.
      if (row.last_alert_at) return await answered(row);
      if ((await asksSince(client, who, new Date(now.getTime() - 3_600_000))) >= ASKS_PER_HOUR) {
        console.warn(JSON.stringify({ at: "[crm-preview] ask-person too many", who, client }));
        return json({ error: PERSON_TOO_MANY }, 429);
      }
      const claim = await claimAsk(row.id, now);
      if (!claim) {
        // Another press is telling our team right now (two tabs at once): its answer is this one's.
        const told = await awaitTold(row.id);
        return told ? await answered(told) : json({ error: PERSON_FAILED }, 502);
      }
      try {
        // All of it in place first: the conversation shows, and can be written to, only once the post has gone.
        await setHistory(row.id, historyOf(body?.turns, client), now);
        // After what came before, whatever the clock says: they're numbered as they're written.
        await addMessage(row.id, "client", PERSON_ASK, null, now);
        await addMessage(row.id, "note", reply, null, now);
        const link = threadLink(OS_URL, client, row.id);
        if (!(await postToPortalChannel(askPersonSlackText({ portal, person: name, question: cleanQuestion(body?.question), test, link })))) throw new Error("Slack didn't take the post");
        // Posted: our team has the link, so it's noted as told — tried twice, or pressing again would post again.
        await markAlerted(row.id, now).catch(() => markAlerted(row.id, now));
      } catch (e) {
        // Not told after all: let go, so pressing again tries again (and starts what was said afresh).
        await releaseAsk(row.id, claim).catch(() => {});
        console.error(JSON.stringify({ at: "[crm-preview] ask-person not posted", who, client, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
        return json({ error: PERSON_FAILED }, 502);
      }
      console.info(JSON.stringify({ at: "[crm-preview] ask-person", who, client, thread: row.id, posted: true }));
      return await answered((await loadThread(row.id)) ?? row);
    }

    // Everything else is about one conversation: this portal's, that our team has been told of — and a client's own.
    const threadId = typeof body?.thread === "string" ? body.thread : "";
    if (!UUID.test(threadId)) return json({ error: "A conversation is required." }, 400);
    const row = await loadThread(threadId);
    if (!row || row.portal_id !== client || !row.last_alert_at) return NOT_FOUND();
    if (!staff && row.client_email !== who) return NOT_FOUND();
    const ended = () => threadView(row).then((thread) => json({ role: viewer.kind, error: "This conversation has ended.", thread: shown({ ...thread, status: "closed" }) }, 409));
    const text = typeof body?.text === "string" ? body.text.slice(0, MAX_MESSAGE_CHARS).trim() : "";
    const key = typeof body?.key === "string" && KEY.test(body.key) ? body.key : null;

    switch (action) {
      case "say": {
        if (staff) return NOT_FOUND();
        if (row.status !== "open") return await ended();
        if (!text) return json({ error: "Write a message first." }, 400);
        const before = await threadView(row);
        if ((await addOnce(row.id, "client", text, null, now, key)).duplicate) break;
        // Our team hears again if it's been a while, or if this answers their reply (they've moved on); the message is
        // saved whether or not the post goes.
        if (teamSpokeSince(before, row.last_alert_at) || now.getTime() - Date.parse(row.last_alert_at) >= ALERT_EVERY_MS) {
          const sent = await postToPortalChannel(personFollowUpSlackText({ portal, person: row.client_name, question: cleanQuestion(text), test: row.test, link: threadLink(OS_URL, client, row.id) }));
          if (sent) await markAlerted(row.id, now);
        }
        break;
      }
      case "read": {
        if (staff) return NOT_FOUND();
        await markRead(row.id, now);
        break;
      }
      case "leave": {
        if (staff) return NOT_FOUND();
        await closeThread(row.id, who, now);
        // Read, too: they've left it, so it isn't shown to them again.
        await markRead(row.id, new Date(now.getTime() + 1));
        console.info(JSON.stringify({ at: "[crm-preview] person-chat left", who, client, thread: row.id }));
        return json({ role: viewer.kind, thread: null });
      }
      case "reply": {
        if (!staff) return NOT_FOUND();
        if (row.status !== "open") return await ended();
        if (!text) return json({ error: "Write a reply first." }, 400);
        const name = firstName((await you())?.name) || null;
        const saved = await addOnce(row.id, "team" satisfies ChatRole, text, { name, email: who }, now, key);
        // Sent again after a timeout: it's there already, and was emailed (or not) the first time — never twice.
        if (saved.duplicate) return json({ role: viewer.kind, thread: await threadView((await loadThread(row.id)) ?? row) });
        const messageId = saved.id;
        // Saved: from here on it has gone, whatever else fails. Saying otherwise would have it sent twice.
        let emailed = false;
        try {
          // Only someone still on the portal's sign-in list: a reply is never sent to a person who has since left it.
          const { data: listed } = await createAdminSupabase().from("os_portal_logins").select("email").eq("portal_id", client).eq("email", row.client_email).is("removed_at", null).maybeSingle();
          if ((listed || row.test) && mayEmailReply(row.client_email)) {
            const before = await threadView(row);
            const asked = [...before.messages].reverse().find((m) => m.role === "client" && m.text !== PERSON_ASK)?.text ?? null;
            await sendChatReplyEmail({ to: row.client_email, firstName: firstName(row.client_name) || null, from: name, reply: text, question: asked });
            emailed = true;
            if (messageId) await markEmailed(messageId, new Date()).catch((e) => console.error(JSON.stringify({ at: "[crm-preview] person-chat emailed not noted", thread: row.id, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" })));
          }
        } catch (e) {
          console.error(JSON.stringify({ at: "[crm-preview] person-chat email failed", who, client, thread: row.id, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
        }
        console.info(JSON.stringify({ at: "[crm-preview] person-chat reply", who, client, thread: row.id, emailed }));
        const view = await loadThread(row.id).then((r) => (r ? threadView(r) : null)).catch(() => null);
        return json({ role: viewer.kind, thread: view });
      }
      case "resolve": {
        if (!staff) return NOT_FOUND();
        await closeThread(row.id, who, now);
        console.info(JSON.stringify({ at: "[crm-preview] person-chat resolved", who, client, thread: row.id }));
        break;
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
    const fresh = await loadThread(row.id);
    return json({ role: viewer.kind, thread: fresh ? shown(await threadView(fresh)) : null });
  } catch (e) {
    console.error(JSON.stringify({ at: "[crm-preview] ask-person failed", who, client, action, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return json({ error: PERSON_FAILED }, 502);
  }
}
