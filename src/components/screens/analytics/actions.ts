"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { invalidate, loadOnce } from "../lazy";

/*
 * The write half of Campaign Analytics, from the browser.
 *
 * Shaped after `screens/onboarding/actions.ts`: one `send` that turns a non-2xx
 * into an Error carrying the server's own sentence, and one exported function
 * per thing a person can do. Keeping them here rather than inline in the
 * components means every call site reports failures the same way — and that the
 * list of writes these screens can perform is one file you can read top to
 * bottom.
 *
 * Everything below reaches Analytics' own database or, for the campaign
 * actions, Analytics' own EmailBison/Instantly clients. The live app is
 * untouched by any of it; both read and write the same rows.
 */

async function send(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error((body?.error as string | undefined) ?? `Request failed (${res.status})`);
  }
  return body ?? {};
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export const BASE = "/api/tools/analytics";

/* -------------------------------- reads ---------------------------------- */

export const KPIS_URL = (qs: string) => `${BASE}/kpis?${qs}`;
export const TIMESERIES_URL = (qs: string) => `${BASE}/timeseries?${qs}`;
export const CAMPAIGN_ROWS_URL = (qs: string) => `${BASE}/campaign-rows?${qs}`;
export const CLIENT_ROWS_URL = (qs: string) => `${BASE}/client-rows?${qs}`;
export const REPLIES_URL = (qs: string) => `${BASE}/replies?${qs}`;
export const REPLY_ROWS_URL = (qs: string) => `${BASE}/replies/rows?${qs}`;
/** The values behind the three reply-attribute filters, for the range given. */
export const REPLY_FACETS_URL = (qs: string) => `${BASE}/replies/facets?${qs}`;
export const VOLUME_URL = (qs: string) => `${BASE}/volume?${qs}`;
export const INFRASTRUCTURE_URL = (qs: string) => `${BASE}/infrastructure?${qs}`;
export const ATTRIBUTION_URL = (qs: string) => `${BASE}/attribution?${qs}`;
export const ATTRIBUTION_EVENTS_URL = (qs: string) => `${BASE}/attribution/events?${qs}`;
export const COPY_URL = (qs: string) => `${BASE}/copy?${qs}`;
export const OFFERS_URL = (qs: string) => `${BASE}/offers?${qs}`;
export const OFFER_SUGGESTIONS_URL = (qs: string) => `${BASE}/offers/suggestions?${qs}`;
export const CAMPAIGNS_URL = (qs: string) => `${BASE}/campaigns?${qs}`;
export const CAMPAIGN_URL = (id: string) => `${BASE}/campaigns/${id}`;
export const CLIENTS_URL = `${BASE}/clients`;
export const SCHEDULE_URL = (day: string) => `${BASE}/schedule?day=${day}`;
export const SYNC_STATUS_URL = `${BASE}/sync/status`;
export const REPLY_DIMENSIONS_URL = (clientId?: string) =>
  clientId ? `${BASE}/reply-dimensions?client_id=${clientId}` : `${BASE}/reply-dimensions`;

/* ------------------------------- the sync -------------------------------- */

/** What the sync route hands back: the tool's own `RunOutcome`, over HTTP. */
export interface SyncOutcome {
  job?: string;
  status?: string;
  rowsWritten?: number;
  error?: string;
  /** Per-job counts (`campaigns`, `markedDeleted`, `steps`…) — or, on a
      timeout, the route's own sentence. */
  detail?: Record<string, unknown> | string;
}

/** Triggers one of the seven manually-runnable jobs. See the route for why. */
export const runSync = (job: string) =>
  send(`${BASE}/sync/run?job=${job}`, { method: "POST" }) as Promise<SyncOutcome>;

/**
 * One sentence for what a sync did — the tool's sync-button.tsx, as text.
 *
 * Rendered from whatever the job actually returned rather than a fixed list of
 * fields: entities reports campaigns/markedDeleted, outcomes reports
 * emailbison/instantly/direct, and a hardcoded reader showed "0 campaigns" for
 * every one of them. "Synced" with no number cannot be told from a no-op, which
 * is exactly the doubt the button exists to remove.
 *
 * `bad` marks the two outcomes the runner reports as failures without a non-2xx
 * — `error` and `circuit-open` — so the toast stays up long enough to read.
 */
export function describeSync(what: string, result: SyncOutcome): { text: string; bad?: boolean } {
  if (result.status === "skipped") return { text: `${what}: a scheduled sync is already running.` };
  if (result.status === "running") {
    return { text: `${what} is still running — check back in a minute.` };
  }
  if (result.status === "error" || result.status === "circuit-open") {
    return { text: `${what} failed${result.error ? `: ${result.error}` : "."}`, bad: true };
  }
  const detail = typeof result.detail === "object" && result.detail ? result.detail : {};
  const summary = Object.entries(detail)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .map(([k, v]) => `${v.toLocaleString("en-US")} ${k.replace(/([A-Z])/g, " $1").toLowerCase()}`)
    .join(", ");
  return { text: `${what}: ${summary || `${result.rowsWritten ?? 0} rows`}` };
}

/* -------------------------------- clients -------------------------------- */

export type MatchMode = "contains" | "prefix" | "exact";

export const createClient = (name: string, aliases: string[], matchMode: MatchMode) =>
  send(CLIENTS_URL, json("POST", { name, aliases, matchMode }));

export const updateClient = (
  id: string,
  patch: { name?: string; aliases?: string[]; matchMode?: MatchMode; active?: boolean },
) => send(`${CLIENTS_URL}/${id}`, json("PATCH", patch));

/**
 * Deletes a client.
 *
 * `campaign_clients.client_id` is ON DELETE SET NULL, so its campaigns fall
 * back to Unassigned rather than disappearing — deleting a client never deletes
 * campaign data. The screen says so before the second click.
 */
export const removeClient = (id: string) => send(`${CLIENTS_URL}/${id}`, { method: "DELETE" });

/** Pins a campaign to a client by hand. `null` unpins it back to the matcher. */
export const assignCampaign = (campaignId: string, clientId: string | null) =>
  send(`${BASE}/campaigns/${campaignId}/client`, json("PUT", { clientId }));

/** Which reply breakdowns one client sees. Copy-on-write; the default is safe. */
export const setReplyDimension = (clientId: string, key: string, active: boolean) =>
  send(`${BASE}/reply-dimensions`, json("PUT", { clientId, key, active }));

/* -------------------------------- offers --------------------------------- */

export const createOffer = (
  name: string,
  niche: string | null,
  sourceCampaignId?: number,
  campaignIds?: number[],
) => send(`${BASE}/offers`, json("POST", { name, niche, sourceCampaignId, campaignIds }));

export const updateOffer = (
  id: string,
  /** `sourceCampaignId: null` returns the offer to "highest-volume campaign (automatic)". */
  patch: { name?: string; niche?: string | null; active?: boolean; sourceCampaignId?: number | null },
) =>
  send(`${BASE}/offers/${id}`, json("PATCH", patch));

/** Deletes an offer. Its campaigns are only detached — none is changed. */
export const removeOffer = (id: string) => send(`${BASE}/offers/${id}`, { method: "DELETE" });

/** Attaches this campaign to an offer, or `null` to detach it. */
export const setCampaignOffer = (campaignId: string, offerId: string | null) =>
  send(`${BASE}/campaigns/${campaignId}/offer`, json("PUT", { offerId }));

/* ------------------------------- copy tags -------------------------------- */

export const COPY_TAGS_URL = (stepId: number) => `${BASE}/copy/tags?step_id=${stepId}`;

/**
 * Saves the seven copy dimensions for one sequence step.
 *
 * `undefined` means "not part of this update"; `null` or `""` clears the tag.
 * Saving through the UI promotes a suggestion to `manual` and stamps
 * `confirmed_at`, which is how "a person agreed with this" stays answerable.
 */
export const saveCopyTags = (sequenceStepId: number, tags: Record<string, string | null>) =>
  send(`${BASE}/copy/tags`, json("PUT", { sequenceStepId, tags }));

/** Seeds `subject_line` tags for every untagged first email in the workspace. */
export const suggestCopyTags = () => send(`${BASE}/copy/suggest`, { method: "POST" });

/* ----------------------------- campaign actions --------------------------- */

export type CampaignAction = "pause" | "resume" | "archive" | "duplicate";

export interface ActionResult {
  campaignId?: string | number;
  id?: string | number;
  name?: string;
  ok?: boolean;
  status?: string;
  error?: string;
}

/**
 * Pause / resume / archive / duplicate, on either platform.
 *
 * `confirm` is required by the server for `resume` and nothing else, because
 * resume is the one that starts sending: on EmailBison it moves `paused` to
 * `queued`, which is not an undo, and on Instantly it calls `activate`. The
 * screen arms the button twice before this is reached.
 */
export const applyCampaignAction = (
  action: CampaignAction,
  targets: Array<{ platform: string; id: string }>,
) =>
  send(`${BASE}/campaigns/actions`, json("POST", { action, targets, confirm: true })) as Promise<{
    batchId?: string;
    applied?: number;
    failed?: number;
    results?: ActionResult[];
  }>;

/* --------------------------- one campaign's settings ---------------------- */

export type CampaignSettingsPatch = {
  name?: string;
  max_emails_per_day?: number;
  max_new_leads_per_day?: number;
  plain_text?: boolean;
  open_tracking?: boolean;
  can_unsubscribe?: boolean;
  include_auto_replies_in_stats?: boolean;
};

export const saveCampaignSettings = (id: string, patch: CampaignSettingsPatch) =>
  send(`${BASE}/campaigns/${id}/settings`, json("PATCH", patch));

/* ------------------------ the campaign page's writes ---------------------- */

/*
 * Everything below is the set of writes the tool's campaign page can perform
 * — the sequence editor, lead removal, the four bulk dialogs and inbox
 * assignment. Each one is a real, irreversible change to EmailBison or
 * Instantly, and every route demands `confirm: true`, which is sent from here
 * and nowhere else.
 *
 * `sendRaw` exists because several of these routes answer 207 for a partial
 * success, or a 4xx that still carries a body the dialog must show (a
 * re-campaign that created the draft and then failed to fill it names the
 * campaign id in a 207; a copy that emptied its target says `targetLeftEmpty`).
 * `send` throws on non-2xx and would lose that body, so these helpers return
 * the status and the body and let the dialog decide.
 */
async function sendRaw<T = Record<string, unknown>>(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = ((await res.json().catch(() => null)) ?? {}) as T & { error?: string };
  return { ok: res.ok, status: res.status, body };
}

/** The merge tags this workspace can fill in, from `lead_attributes`. */
export const MERGE_TAGS_URL = `${BASE}/merge-tags`;

/** One page of a campaign's leads, or (with `facets=1`) the status counts. */
export const CAMPAIGN_LEADS_URL = (id: string, qs: string) => `${BASE}/campaigns/${id}/leads?${qs}`;

/** Which inboxes are on this campaign — `summary=1` is the one-call count. */
export const CAMPAIGN_INBOXES_URL = (id: string, summary?: boolean) =>
  `${BASE}/campaigns/${id}/inboxes${summary ? "?summary=1" : ""}`;

/** The tagged pools one platform offers. */
export const INBOX_TAGS_URL = (platform: "emailbison" | "instantly") =>
  `${BASE}/campaigns/inboxes?platform=${platform}`;

/** How many leads a re-campaign would move (GET on the same route as the POST). */
export const RECAMPAIGN_PREVIEW_URL = (id: string) => `${BASE}/campaigns/${id}/re-campaign`;

export interface SequenceStepPayload {
  /** Absent = a new step, appended by EmailBison. */
  id?: number;
  email_subject: string;
  email_body: string;
  wait_in_days: number;
  thread_reply: boolean;
  variant: boolean;
  variant_from_step_id?: number | null;
}

/**
 * Replaces the sequence with the list as the editor arranged it.
 *
 * `sequenceId` is EmailBison's handle on the sequence and is required there;
 * Instantly has none (its campaign holds one sequence) and the route ignores
 * it. The route diffs against the live sequence and turns a failure part-way
 * into `partiallyApplied` counts, which the message here spells out — the
 * tool's own wording, because "retry" and "check what state this campaign is
 * in first" are different instructions.
 */
export async function saveSequence(
  id: string,
  sequenceId: number | null,
  steps: SequenceStepPayload[],
): Promise<{ ok: boolean; updated?: number; added?: number; deleted?: number }> {
  const { ok, body } = await sendRaw<{
    ok?: boolean;
    partiallyApplied?: { updated: number; added: number; deleted: number };
  }>(
    `${BASE}/campaigns/${id}/sequence`,
    json("PUT", { ...(sequenceId ? { sequenceId } : {}), steps }),
  );
  if (!ok) {
    throw new Error(
      body.partiallyApplied
        ? `${body.error}\n\nPart of the save was applied (${body.partiallyApplied.updated} updated, ` +
          `${body.partiallyApplied.added} added, ${body.partiallyApplied.deleted} deleted). ` +
          `Reload before trying again.`
        : (body.error ?? "The sequence could not be saved"),
    );
  }
  return body as { ok: boolean; updated?: number; added?: number; deleted?: number };
}

export interface RemoveLeadsResult {
  ok: boolean;
  attempted: number;
  applied: number;
  skipped: number;
  chunks: Array<{ size: number; ok: boolean; message?: string; error?: string }>;
}

/**
 * Removes leads from a campaign. No undo exists on either platform.
 *
 * Ids travel as they came — integers for EmailBison, uuids for Instantly —
 * because the route refuses a list whose ids do not match the campaign's
 * platform, and coercing here would defeat that check. A 207 (some chunks
 * refused) is returned, not thrown: it is a result to report, not a failure.
 */
export async function removeLeads(
  id: string,
  leadIds: Array<number | string>,
): Promise<RemoveLeadsResult> {
  const { ok, status, body } = await sendRaw<RemoveLeadsResult>(
    `${BASE}/campaigns/${id}/leads/remove`,
    json("POST", { leadIds, confirm: true }),
  );
  if (!ok && status !== 207) throw new Error(body.error ?? "The removal failed.");
  return body;
}

/** Every lead id matching the current filter — from the server, not the pages seen. */
export async function selectAllLeadIds(
  id: string,
  q: string,
  status: string | null,
): Promise<Array<number | string>> {
  const params = new URLSearchParams({ ids: "1" });
  if (q) params.set("q", q);
  if (status) params.append("status", status);
  const { ok, body } = await sendRaw<{ leadIds: Array<number | string> }>(
    CAMPAIGN_LEADS_URL(id, params.toString()),
    { method: "GET" },
  );
  if (!ok) throw new Error(body.error ?? "Could not load the full selection");
  return body.leadIds ?? [];
}

export type CopyMode = "replace" | "append";

export interface CopyPlanStep {
  order: number;
  subject: string | null;
  waitInDays: number | null;
  threadReply: boolean;
  isVariant: boolean;
  opening: string | null;
}

export interface CopyPlan {
  sourceName: string;
  targetName: string;
  targetStatus: string;
  mode: CopyMode;
  steps: CopyPlanStep[];
  removing: CopyPlanStep[];
  /** Replace cannot proceed — a target step has already sent emails. */
  blocked: boolean;
  warnings: string[];
}

export interface CopyOptions {
  includeVariants: boolean;
  includeAttachments: boolean;
  includeCopyTags?: boolean;
}

/**
 * The dry run: what copying `source` into `target` would do, without doing it.
 * `apply:false` is the route's default and is sent explicitly anyway.
 */
export async function planCopySequence(
  targetId: number,
  sourceCampaignId: number,
  mode: CopyMode,
  options: CopyOptions,
): Promise<CopyPlan> {
  const { ok, body } = await sendRaw<{ plan?: CopyPlan }>(
    `${BASE}/campaigns/${targetId}/copy-sequence`,
    json("POST", { sourceCampaignId, mode, ...options, apply: false }),
  );
  if (!ok || !body.plan) throw new Error(body.error ?? "Could not build the preview");
  return body.plan;
}

export interface CopyOutcome {
  ok: boolean;
  created: number;
  deleted: number;
  error?: string;
  /** A Replace deleted the old steps and then failed to create the new ones. */
  targetLeftEmpty?: boolean;
  tagsCopied?: number;
}

/**
 * The real thing. Returns the outcome even on failure so a bulk deploy can
 * keep each target's verbatim error, and `targetLeftEmpty`, which is the one
 * line a person must read.
 */
export async function applyCopySequence(
  targetId: number,
  sourceCampaignId: number,
  mode: CopyMode,
  options: CopyOptions,
): Promise<{ ok: boolean; status: number; body: Partial<CopyOutcome> & { error?: string } }> {
  return sendRaw<Partial<CopyOutcome>>(
    `${BASE}/campaigns/${targetId}/copy-sequence`,
    json("POST", { sourceCampaignId, mode, ...options, apply: true }),
  );
}

export interface InboxAssignmentSummary {
  tag: string;
  action: "attach" | "remove";
  inboxes: number;
  skippedDisconnected: number;
  results: Array<{
    campaignId: string | number;
    name: string;
    ok: boolean;
    applied: number;
    alreadyAttached?: number;
    error?: string;
  }>;
}

/** Attaches or removes a tagged pool on every target. 207 = some refused. */
export async function assignInboxes(
  targets: Array<{ platform: "emailbison" | "instantly"; id: string }>,
  tag: string,
  action: "attach" | "remove",
): Promise<InboxAssignmentSummary> {
  const { ok, status, body } = await sendRaw<InboxAssignmentSummary>(
    `${BASE}/campaigns/inboxes`,
    json("POST", { targets, tag, action, confirm: true }),
  );
  if (!ok && status !== 207) throw new Error(body.error ?? "The assignment failed.");
  return body;
}

export interface ReCampaignResult {
  ok: boolean;
  campaignId: number | null;
  name: string;
  steps: number;
  inboxes: number;
  leadsSelected: number;
  leadsAttached: number;
  leadsSkipped: number;
  bouncedRemoved: number;
  rolledBack?: boolean;
  error?: string;
}

/**
 * Duplicates the campaign as a DRAFT and moves the never-replied leads in.
 *
 * A 207 means the campaign exists but was not fully populated — returned, not
 * thrown, because the caller has to know its id to finish or delete it.
 */
export async function reCampaign(
  id: string,
  body: { name: string; copyInboxes: boolean; removeBouncedFromSource: boolean },
): Promise<{ ok: boolean; status: number; body: Partial<ReCampaignResult> & { error?: string } }> {
  return sendRaw<Partial<ReCampaignResult>>(
    `${BASE}/campaigns/${id}/re-campaign`,
    json("POST", { ...body, confirm: true }),
  );
}

export interface FanOutSummary {
  created: number;
  failed: number;
  targets: Array<{
    clientName: string;
    ok: boolean;
    campaignId: number | null;
    name: string;
    steps: number;
    inboxes: number;
    error?: string;
  }>;
}

/** One draft per client from this template. 207 = some failed. */
export async function fanOut(
  id: string,
  body: { clientIds: string[]; nameTemplate: string; copyInboxes: boolean },
): Promise<FanOutSummary> {
  const { ok, status, body: out } = await sendRaw<FanOutSummary>(
    `${BASE}/campaigns/${id}/fan-out`,
    json("POST", { ...body, confirm: true }),
  );
  if (!ok && status !== 207) throw new Error(out.error ?? "Could not create the campaigns.");
  return out;
}

/* ------------------------------- outcomes --------------------------------- */

/** Logs an outcome by hand against one reply. Idempotent — the id is derived. */
export const logOutcome = (replyId: number, eventType: string, occurredAt?: string) =>
  send(`${BASE}/outcomes`, json("POST", { replyId, eventType, occurredAt }));

/** Removes a hand-logged outcome. The route refuses anything the feed owns. */
export const unlogOutcome = (id: string) =>
  send(`${BASE}/outcomes?id=${encodeURIComponent(id)}`, { method: "DELETE" });

/* --------------------------- data, refetchable ---------------------------- */

/**
 * `Lazy`, but the caller can ask for the data again, and the URL can change.
 *
 * `Lazy` is right for a screen whose data cannot change while you look at it.
 * Every Analytics screen has a filter bar, so the URL it reads is a moving
 * target, and four of them write. This is the same `loadOnce` cache — so two
 * screens asking for the same query share one request — plus `reload()`, which
 * drops the cached promise first.
 *
 * `keepPrevious` is the tool's `placeholderData: keepPreviousData`, and it is
 * not decoration: without it every filter change blanks the whole screen for
 * 400ms and the page jumps. The stale data stays on screen, dimmed by the
 * caller, until the new answer lands.
 */
export function useAnalyticsData<T>(url: string, options?: { skip?: boolean }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  // The request this component is currently interested in. A slower earlier
  // request must not overwrite a faster later one — the classic filter race.
  const wanted = useRef(url);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const run = useCallback((target: string, fresh: boolean) => {
    wanted.current = target;
    setLoading(true);
    if (fresh) invalidate(target);
    loadOnce<T>(target).then(
      (d) => {
        if (!live.current || wanted.current !== target) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live.current || wanted.current !== target) return;
        setError(e instanceof Error ? e.message : "Could not load this view");
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (options?.skip) return;
    run(url, false);
  }, [url, run, options?.skip]);

  const reload = useCallback(async () => {
    run(url, true);
  }, [run, url]);

  return { data, error, loading, reload };
}
