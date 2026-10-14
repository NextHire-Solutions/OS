/*
 * "A lead is Interested" — the Slack alert's rules and wording (14 Oct).
 *
 * Asked by Amy (client), 11 Oct: "Could you build a slack channel that notifies
 * when a candidate is 'interested' in the master inbox?" The channel is
 * #client-interested-updates; the OS posts there through the Master Inbox bot.
 *
 * Decided with the user before building:
 *   · once per conversation — the first time it is labelled Interested, by the
 *     AI on a new reply or by a person, in either inbox app
 *   · client, lead, email, phone, brokerage, campaign, a snippet of the reply
 *     and a link to the conversation in the OS
 *   · every client except Demo Portal
 *   · only from go-live on — nothing from before is announced
 *   · a label removed or changed before the alert goes out sends nothing
 *
 * Pure: the loading and posting are in interested-alerts.ts.
 */

/*
 * Go-live. Nothing labelled before this is ever announced, however the sweep's
 * window is computed — the decision was "only new ones from now".
 */
export const INTERESTED_ALERTS_FROM = "2026-10-14T02:00:00.000Z";

/*
 * How far back each sweep looks. The sweep runs every minute; the window only
 * has to cover a restart or a deploy, and an assignment older than this that
 * was somehow missed is not worth announcing late.
 */
export const SWEEP_WINDOW_MS = 30 * 60 * 1000;

/** The earliest assignment one sweep looks at. */
export function sweepSince(now: Date): string {
  const windowStart = new Date(now.getTime() - SWEEP_WINDOW_MS).toISOString();
  return windowStart > INTERESTED_ALERTS_FROM ? windowStart : INTERESTED_ALERTS_FROM;
}

/** The label that triggers it: "Interested", exactly, in any case — never "Not Interested". */
export function isInterestedLabel(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "interested";
}

/** Clients whose conversations are never announced. */
export function isExcludedClient(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "demo portal";
}

/** Slack treats &, < and > as markup; a lead's own words must not be read as a link. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The first couple of lines of what the lead wrote: whitespace collapsed, cut at a word. */
export function snippetOf(body: string | null | undefined, max = 280): string | null {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

export interface InterestedAlert {
  clientName: string | null;
  leadName: string | null;
  leadEmail: string | null;
  leadPhone: string | null;
  brokerage: string | null;
  campaign: string | null;
  /** What the lead wrote, already cut by snippetOf. */
  snippet: string | null;
  threadUrl: string;
}

/** The message, in Slack's own markup. Fields with nothing in them are left out, never shown as blank. */
export function alertText(a: InterestedAlert): string {
  const clean = (v: string | null | undefined) => (v && v.trim() ? slackEscape(v.trim()) : null);
  const who = clean(a.leadName) ?? clean(a.leadEmail) ?? "A lead";
  const lines = [`:large_green_circle: *Interested* · ${clean(a.clientName) ?? "No client"}`, `*${who}*`];
  const contact = [clean(a.leadEmail), clean(a.leadPhone)].filter(Boolean).join(" · ");
  if (contact) lines.push(contact);
  if (clean(a.brokerage)) lines.push(`Brokerage: ${clean(a.brokerage)}`);
  if (clean(a.campaign)) lines.push(`Campaign: ${clean(a.campaign)}`);
  if (clean(a.snippet)) lines.push(`> ${clean(a.snippet)}`);
  lines.push(`<${a.threadUrl}|Open the conversation>`);
  return lines.join("\n");
}
