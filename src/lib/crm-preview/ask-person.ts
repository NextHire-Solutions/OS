/*
 * "Ask for a person" in the portal's chat (4 Nov, the user: "send us a slack notification (no email or phone number)
 * and say that we will get back to them"; Amy and Eddy: our team replies in the same chat, and by email too). No address
 * or number in the chat or on Slack: the person by name only, and anything like one taken out of what they typed before
 * it's posted.
 *
 * Pure, so the chat window can use the wording too; the routes (api/crm-preview/ask-person, person-chat) do the rest.
 */

export const PERSON_ASK = "I'd like to talk to a person.";
export const PERSON_REPLY = "Of course. I've let our team know, and we'll get back to you soon.";
/** Said once replies really do go by email too (the switch in portal-chat/mail.ts). */
export const PERSON_REPLY_EMAIL = "Of course. I've let our team know, and we'll get back to you here and by email.";
export const PERSON_FAILED = "I couldn't reach our team just now. Please try again.";
/** Each request is a Slack post: past a few an hour (portal-chat/threads.ts ASKS_PER_HOUR), they're told we have it. */
export const PERSON_TOO_MANY = "Our team has your requests from the last hour and will get back to you. Please give us a little time.";

export const MAX_QUESTION_CHARS = 300;

const ADDRESS = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g;
const NUMBER = /\+?\(?\d(?:[\s()./\u2010-\u2015-]*\d){6,}/g;

/** What they last typed, for the post: one line, no address or phone number, clipped. Anything else: nothing. */
export function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Bounded first: these patterns are slow on a very long text, and one person's request can't be allowed to hold up the OS.
  const text = raw.slice(0, 2_000).replace(ADDRESS, "[removed]").replace(NUMBER, "[removed]").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS).trimEnd()}…` : text;
}

/** Slack reads <…> as a mention or a link: what a client typed is shown, never acted on. */
const plain = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where our team opens the conversation. */
export function threadLink(base: string, portalId: string, threadId: string): string {
  return `${base.replace(/\/+$/, "")}/crm-preview?client=${encodeURIComponent(portalId)}&thread=${encodeURIComponent(threadId)}`;
}

const header = (test: boolean, what: string, portal: string) => `${test ? "[TEST] " : ""}*${what} · ${plain(portal)}*`;
// personName falls back to the address when there is no name: left out, never shown.
const from = (person: string | null | undefined) => {
  const name = cleanQuestion(person);
  return name && !person!.includes("@") ? [`• From: ${plain(name)}`] : [];
};

/** The post, in the portal channel's one clean look (prospect-sync/rules.ts). "[TEST]" when it's our own team pressing it, or the Demo. */
export function askPersonSlackText(o: { portal: string; person: string | null; question: string | null; test: boolean; link: string }): string {
  return [
    header(o.test, "Asked for a person", o.portal),
    ...from(o.person),
    ...(o.question ? [`• Last message: "${plain(o.question)}"`] : []),
    `<${o.link}|Open the chat to reply>`,
  ].join("\n");
}

/** They wrote again while waiting for us (at most every so often: portal-chat/threads.ts ALERT_EVERY_MS). */
export function personFollowUpSlackText(o: { portal: string; person: string | null; question: string | null; test: boolean; link: string }): string {
  return [
    header(o.test, "New chat message", o.portal),
    ...from(o.person),
    ...(o.question ? [`• "${plain(o.question)}"`] : []),
    `<${o.link}|Open the chat to reply>`,
  ].join("\n");
}
