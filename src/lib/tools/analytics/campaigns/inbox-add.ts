import { describeEmailBisonError, invalidIndices } from "../emailbison/errors.ts";

import { isOpenStatus } from "./inbox-removal.ts";

/*
 * Adding the selected inboxes to campaigns, from the Inboxes page (6 Nov; Gabriel: "Is there a way to ADD inboxes to
 * all campaigns at once, or to a selection of campaigns?"; the user: beside Remove from campaigns, then select or
 * unselect the campaigns there).
 *
 * What EmailBison does, measured 6 Nov on two draft test campaigns made and deleted for it, and read from the 220
 * attaches in the audit log since 8 Sep:
 *
 *   ANY OPEN CAMPAIGN. Draft, paused and active alike, and nothing is paused: 25 of the logged attaches were made while
 *   the campaign was sending, and none was ever refused for its status. An active campaign starts sending from the new
 *   inboxes straight away.
 *
 *   AT ONCE. The campaign's own count is right within a fraction of a second, paused or not. (A removal from a paused
 *   campaign lands 2 to 3 seconds later; an attach doesn't.)
 *
 *   SOME ALREADY ON IT: the rest are added. ALL ALREADY ON IT: refused with "These emails already exist on this
 *   campaign", which here means there was nothing to do.
 *
 *   ONE ID IT DOESN'T KNOW refuses the whole call (422, "The selected sender_email_ids.N is invalid"): that one is
 *   dropped and the call made again.
 *
 * Only Connected inboxes are sent, as the Campaigns page's own Assign does (inbox-assignment.ts): one that can't connect
 * would sit on the campaign sending nothing. What is reported is the campaign's own count before and after, never the
 * number of ids sent. Finished and archived campaigns can't send, so they aren't offered or changed.
 *
 * Pure: the EmailBison calls are passed in.
 */

/** Ids per call, as the Campaigns page's Assign and the removal. */
export const ADD_CHUNK = 250;

export type AddOutcome =
  /** Inboxes went on. */
  | "added"
  /** Every one was on it already. */
  | "nothing"
  /** It has finished or been archived since the list was read: not touched. */
  | "finished"
  /** See `error`. Anything that did go on is in `added`. */
  | "failed";

export interface AddResult {
  campaignId: number;
  ok: boolean;
  outcome: AddOutcome;
  /** Inboxes that went on, by the campaign's own count. */
  added: number;
  /** Of those sent, how many it held already. */
  alreadyOn: number;
  /** Inboxes on it before and after; null when not read. */
  before: number | null;
  after: number | null;
  /** Ids EmailBison didn't know (deleted since the list was read), left out. */
  dropped: number;
  error?: string;
}

export interface AddDeps {
  status: (campaignId: number) => Promise<string>;
  count: (campaignId: number) => Promise<number>;
  attach: (campaignId: number, inboxIds: number[]) => Promise<unknown>;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** EmailBison's own wording for "every one of these is on it already" (as inbox-assignment.ts), and nothing broader. */
export function isAlreadyOn(error: unknown): boolean {
  return describeEmailBisonError(error).toLowerCase().includes("already exist on this campaign");
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Adds these inboxes to this one campaign and says exactly what happened, by the campaign's own count. */
export async function addToCampaign(deps: AddDeps, input: { campaignId: number; inboxIds: readonly number[] }): Promise<AddResult> {
  const { campaignId } = input;
  const inboxIds = [...new Set(input.inboxIds)];
  const result: AddResult = { campaignId, ok: true, outcome: "added", added: 0, alreadyOn: 0, before: null, after: null, dropped: 0 };

  let before: number;
  try {
    before = await deps.count(campaignId);
    if (!isOpenStatus(norm(await deps.status(campaignId)))) return { ...result, before, after: before, outcome: "finished" };
  } catch (e) {
    return { ...result, ok: false, outcome: "failed", error: describeEmailBisonError(e) };
  }
  result.before = before;

  let refused: unknown = null;
  let sent = 0;
  // A call answered "added" puts at least one on: EmailBison refuses when every one is there already.
  let answeredAdded = false;
  for (const part of chunks(inboxIds, ADD_CHUNK)) {
    let ids = part;
    for (let attempt = 0; attempt < 3 && ids.length; attempt++) {
      try {
        await deps.attach(campaignId, ids);
        sent += ids.length;
        answeredAdded = true;
        break;
      } catch (e) {
        if (isAlreadyOn(e)) {
          sent += ids.length;
          break;
        }
        const bad = new Set(invalidIndices(e, "sender_email_ids"));
        if (!bad.size || attempt === 2) {
          refused = e;
          break;
        }
        result.dropped += bad.size;
        ids = ids.filter((_, i) => !bad.has(i));
      }
    }
    if (refused) break;
  }

  // The campaign's own count is what really happened: a call can answer and have done nothing.
  try {
    const after = await deps.count(campaignId);
    result.after = after;
    result.added = Math.max(0, after - before);
    result.alreadyOn = Math.max(0, sent - result.added);
  } catch {
    result.after = null;
  }

  if (refused) return { ...result, ok: false, outcome: "failed", error: describeEmailBisonError(refused) };
  if (result.after === null) return { ...result, ok: false, outcome: "failed", error: "EmailBison took them, but the campaign's count couldn't be read to check. Check this campaign." };
  if (result.added === 0 && answeredAdded) {
    return { ...result, ok: false, outcome: "failed", error: "EmailBison answered as if it had worked, but the campaign's count didn't move. Check this campaign." };
  }
  if (result.added === 0) return { ...result, outcome: "nothing" };
  return result;
}

/** What a selection sends: Connected EmailBison inboxes only, and what is left out and why. */
export function addSelection(inboxes: ReadonlyArray<{ id: number | string; status: string | null }>): { send: number[]; notConnected: number; instantly: number } {
  const send: number[] = [];
  let notConnected = 0, instantly = 0;
  for (const i of inboxes) {
    if (typeof i.id !== "number") instantly++;
    else if (norm(i.status) === "connected") send.push(i.id);
    else notConnected++;
  }
  return { send, notConnected, instantly };
}
