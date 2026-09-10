import { env } from "@/lib/env";
import type {
  InstantlyEmail,
  InstantlyCampaign,
  InstantlyWebhook,
  InstantlyEventType,
  InstantlySubsequence,
  InstantlyLeadSummary,
} from "./types";

// Thin typed wrapper around Instantly.ai's v2 REST API.
//
// Auth: `Authorization: Bearer <key>` — pass the user's API key as-is
// (it's already base64-encoded `id:secret`; do NOT decode).
// Pagination: `?limit=...&starting_after=...`; the response's
// `next_starting_after` is the cursor for the next page (omit when null).
//
// Rate limit: docs say 20 req/min on /emails list — there are no
// X-RateLimit-* headers, so we back off on 429 instead of pre-emptively
// throttling. Webhooks are the preferred sync path; this client is only
// used for backfill and for sending replies.

export class InstantlyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ClientOpts {
  baseUrl?: string;
  apiKey?: string;
}

export interface ListResponse<T> {
  items: T[];
  next_starting_after?: string | null;
}

export function createInstantlyClient(opts: ClientOpts = {}) {
  const baseUrl = (opts.baseUrl ?? env.INSTANTLY_BASE_URL).replace(/\/$/, "");
  const apiKey = opts.apiKey ?? env.INSTANTLY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Instantly API key is not configured (INSTANTLY_API_KEY).",
    );
  }

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    const data = text ? safeJSON(text) : null;
    if (!res.ok) {
      throw new InstantlyError(
        `Instantly ${method} ${path} -> ${res.status}`,
        res.status,
        data ?? text,
      );
    }
    return data as T;
  }

  return {
    // Campaigns
    listCampaigns: (params: { limit?: number; starting_after?: string; search?: string; status?: number } = {}) =>
      request<ListResponse<InstantlyCampaign>>("GET", "/campaigns", undefined, {
        limit: params.limit ?? 100,
        starting_after: params.starting_after,
        search: params.search,
        status: params.status,
      }),
    getCampaign: (id: string) =>
      request<InstantlyCampaign>("GET", `/campaigns/${id}`),

    // Emails
    listEmails: (params: {
      limit?: number;
      starting_after?: string;
      email_type?: "received" | "sent";
      campaign_id?: string;
      thread_id?: string;
      is_unread?: boolean;
      eaccount?: string;
      lead?: string;
      search?: string;
    } = {}) =>
      request<ListResponse<InstantlyEmail>>("GET", "/emails", undefined, {
        limit: params.limit ?? 100,
        starting_after: params.starting_after,
        email_type: params.email_type,
        campaign_id: params.campaign_id,
        thread_id: params.thread_id,
        is_unread: params.is_unread,
        eaccount: params.eaccount,
        lead: params.lead,
        search: params.search,
      }),
    getEmail: (id: string) => request<InstantlyEmail>("GET", `/emails/${id}`),
    getUnreadCount: () =>
      request<{ count: number }>("GET", "/emails/unread/count"),

    // Send a reply. `reply_to_uuid` is the Instantly email id we're replying to.
    // `eaccount` is the mailbox to send from (defaults to the eaccount on the
    // reply-to email if omitted).
    sendReply: (input: {
      reply_to_uuid: string;
      subject?: string;
      body: { text?: string; html?: string };
      eaccount?: string;
      cc_address_email_list?: string;
      bcc_address_email_list?: string;
      include_original_body?: boolean;
    }) => request<InstantlyEmail>("POST", "/emails/reply", input),

    // Forward an Instantly email to a NEW recipient. Different from
    // sendReply — Instantly's reply endpoint pins the recipient to the
    // original sender, but /emails/forward accepts an arbitrary
    // to_address_email_list while still threading off the source
    // email via reply_to_uuid. Required: eaccount (sender mailbox),
    // reply_to_uuid (the email being forwarded), to_address_email_list
    // (comma-joined recipients), subject, body.
    forwardEmail: (input: {
      eaccount: string;
      reply_to_uuid: string;
      to_address_email_list: string;
      subject: string;
      body: { text?: string; html?: string };
      cc_address_email_list?: string;
      bcc_address_email_list?: string;
      include_original_body?: boolean;
    }) => request<InstantlyEmail>("POST", "/emails/forward", input),

    markThreadRead: (threadId: string) =>
      request<{ success?: boolean }>("POST", `/emails/threads/${threadId}/mark-as-read`),

    // Subsequences (per-campaign branches that leads can be moved into)
    listSubsequences: (parentCampaign: string, params: { limit?: number; starting_after?: string } = {}) =>
      request<ListResponse<InstantlySubsequence>>("GET", "/subsequences", undefined, {
        parent_campaign: parentCampaign,
        limit: params.limit ?? 100,
        starting_after: params.starting_after,
      }),

    // Lead UUID lookup — POST /leads/list with `search` is the only way to
    // resolve a lead's UUID from their email address (the reply_received
    // webhook payload doesn't carry it).
    findLeadByEmail: (email: string) =>
      request<ListResponse<InstantlyLeadSummary>>("POST", "/leads/list", {
        search: email,
        limit: 5,
      }),

    // Move an existing lead into a subsequence. Verified live: body
    // requires both `id` (lead UUID) and `subsequence_id`.
    moveLeadToSubsequence: (input: { lead_id: string; subsequence_id: string }) =>
      request<{ success?: boolean }>("POST", "/leads/subsequence/move", {
        id: input.lead_id,
        subsequence_id: input.subsequence_id,
      }),

    // Block list (Do-Not-Contact). POST /block-lists-entries with
    // `bl_value` = the email (or domain) — Instantly stops contacting it
    // across the workspace.
    blockEmail: (email: string) =>
      request<{ id?: string }>("POST", "/block-lists-entries", { bl_value: email }),

    // Domain block. Instantly accepts `*@<domain>` as a wildcard
    // pattern in bl_value; this blocks every address at the domain.
    // Matches the portal's company DNC flow.
    blockDomain: (domain: string) =>
      request<{ id?: string }>("POST", "/block-lists-entries", {
        bl_value: `*@${domain}`,
      }),

    // Webhooks
    listWebhooks: () => request<ListResponse<InstantlyWebhook>>("GET", "/webhooks"),
    listWebhookEventTypes: () =>
      request<{ items?: string[] } | string[]>("GET", "/webhooks/event-types"),
    // Instantly's create endpoint takes a single `event_type` (string) — for
    // multi-event subscriptions, the caller must POST once per event. See
    // InstantlyWebhook for the field-name quirk vs the marketing docs.
    createWebhook: (input: {
      name: string;
      target_hook_url: string;
      event_type: InstantlyEventType | string;
    }) => request<InstantlyWebhook>("POST", "/webhooks", input),
    deleteWebhook: (id: string) =>
      request<{ success?: boolean }>("DELETE", `/webhooks/${id}`),

    // Raw escape hatch for ad-hoc calls.
    raw: request,
  };
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
