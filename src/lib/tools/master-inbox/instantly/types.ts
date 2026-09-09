// Instantly.ai v2 API — types observed live against api.instantly.ai/api/v2.
//
// Auth: Authorization: Bearer <key>. The key is a base64 string in the form
// `id:secret`; send the encoded string as-is (DO NOT decode).
//
// Cursor pagination: requests take `limit` (max 100) and `starting_after`;
// responses include `items[]` and `next_starting_after` (absent on last page).

export interface InstantlyAddress {
  name?: string;
  address: string;
}

// Returned by GET /emails and GET /emails/{id}. (NOTE: this differs from the
// webhook envelope shape — see InstantlyWebhookEnvelope below.)
export interface InstantlyEmail {
  id: string;
  timestamp_created?: string;
  timestamp_email?: string;
  message_id?: string;
  subject?: string | null;

  from_address_email?: string | null;
  from_address_json?: InstantlyAddress[];

  to_address_email_list?: string | null;
  to_address_json?: InstantlyAddress[];
  cc_address_email_list?: string | null;
  cc_address_json?: InstantlyAddress[];
  bcc_address_email_list?: string | null;
  bcc_address_json?: InstantlyAddress[];

  eaccount?: string;
  campaign_id?: string | null;
  lead?: string | null;
  lead_id?: string | null;
  thread_id?: string;

  ue_type?: number;            // 1 = sent, 2 = received
  is_unread?: number | boolean;
  is_focused?: number | boolean;
  i_status?: number;
  step?: string;

  content_preview?: string;
  body?: {
    text?: string;
    html?: string;
  };
}

export interface InstantlyCampaign {
  id: string;
  name: string;
  status?: number;
  timestamp_created?: string;
  timestamp_updated?: string;
  organization?: string;
  daily_limit?: number;
  stop_on_reply?: boolean;
}

// Per-campaign subsequence. Verified live: requires `parent_campaign`
// query param to list. Status seen: 1 (running), 3 (draft/paused).
export interface InstantlySubsequence {
  id: string;
  name: string;
  parent_campaign: string;
  status?: number;
  timestamp_created?: string;
  timestamp_leads_updated?: string;
  conditions?: Record<string, unknown>;
  sequences?: unknown;
  workspace?: string;
}

// Shape from POST /leads/list. Originally used only to resolve a lead's
// UUID from an email — but the endpoint actually returns the FULL lead,
// so the portal's external-intro enrichment reads the detail fields too.
export interface InstantlyLeadSummary {
  id: string;
  email: string;
  campaign?: string;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string;
  status?: number;
  timestamp_created?: string;
  // Full-detail fields (verified live against POST /leads/list).
  company_name?: string | null;
  job_title?: string | null;
  phone?: string | null;
  website?: string | null;
  // Every campaign custom variable Instantly holds for the lead.
  payload?: Record<string, unknown> | null;
  // Set when the lead currently sits in a subsequence.
  subsequence_id?: string | null;
  timestamp_added_subsequence?: string | null;
}

// Live-verified shape. Quirk: the POST endpoint requires `target_hook_url`
// (not `webhook_url`) and a singular `event_type` string (not the plural
// `event_types` array shown in marketing docs). The GET response uses the
// same names — there's only one event_type per webhook, so multi-event
// subscriptions require multiple webhook rows.
export interface InstantlyWebhook {
  id: string;
  name?: string;
  target_hook_url: string;
  event_type: string;
  organization?: string;
  status?: number;
  timestamp_created?: string;
}

export type InstantlyEventType =
  | "reply_received"
  | "lead_interested"
  | "lead_not_interested"
  | "lead_neutral"
  | "lead_meeting_booked"
  | "lead_meeting_completed"
  | "lead_closed"
  | "lead_out_of_office"
  | "lead_wrong_person"
  | "lead_unsubscribed"
  | "campaign_completed";

export const RELEVANT_EVENTS: InstantlyEventType[] = ["reply_received"];

// Real reply_received webhook envelope — observed live in production logs.
// Field shape is FLAT, NOT nested. Lead custom variables appear as
// arbitrary top-level keys (firstName, companyName, LicenseNumber, etc).
//
// Required-ish for our handler: event_type, email_id, lead_email,
// campaign_id, campaign_name, reply_subject, reply_text (or reply_html).
//
// Everything else is preserved into the lead's custom_fields jsonb so we
// don't lose any per-lead enrichment Instantly already did for us.
export interface InstantlyWebhookEnvelope {
  event_type?: string;
  timestamp?: string;
  workspace?: string;
  unibox_url?: string;          // contains "thread:<id>" — only canonical thread id source

  // Triggering reply
  email_id?: string;            // UUID, matches /emails/{id}
  reply_subject?: string;
  reply_text?: string;
  reply_text_snippet?: string;
  reply_html?: string;

  // Provider context
  email_account?: string;       // OUR sending mailbox (the eaccount)
  campaign_id?: string;
  campaign_name?: string;       // pre-resolved — no /campaigns/{id} call needed
  is_first?: boolean;
  step?: number | string;
  variant?: number | string;

  // Lead identity (flat)
  lead_email?: string;
  email?: string;               // alias of lead_email in some payloads
  firstName?: string;
  lastName?: string;
  companyName?: string;
  jobTitle?: string;
  phone?: string;
  website?: string;
  City?: string;
  State?: string;
  County?: string;
  location?: string;
  LicenseNumber?: string;
  AgencyZip?: string;

  // Custom variables Instantly enriched on the lead — passthrough to
  // leads.custom_fields. Anything we don't model explicitly above ends up
  // here via the index signature.
  [key: string]: unknown;
}
