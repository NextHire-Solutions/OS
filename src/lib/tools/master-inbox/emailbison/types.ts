// EmailBison webhook payload — observed shape:
//   { data: { event: { type, name, workspace_id, workspace_name }, data: {...} } }
// `event.type` is uppercase ("EMAIL_SENT", "LEAD_REPLIED", ...). `data.data`
// is a discriminated union by event type. We model the fields we actually use.

export interface EmailBisonLead {
  id: number;
  uuid: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  status?: string | null;
  title?: string | null;
  company?: string | null;
  emails_sent?: number;
  opens?: number;
  unique_opens?: number;
  replies?: number;
  unique_replies?: number;
  bounces?: number;
  custom_variables?: Array<{ name: string; value: string }>;
}

export interface EmailBisonSenderEmail {
  id: number;
  name?: string | null;
  email: string;
  status?: string;
  type?: string;
}

export interface EmailBisonCampaign {
  id: number;
  name?: string;
}

export interface EmailBisonScheduledEmail {
  id: number;
  lead_id: number;
  email_subject?: string | null;
  email_body?: string | null;
  status?: string;
  sent_at?: string | null;
}

// EmailBison reply payload — field names per the live `/api/webhook-events/test-event`
// response. NOT `body_html` / `subject` — they're `html_body` / `email_subject`.
export interface EmailBisonReply {
  id: number;
  uuid?: string;
  email_subject?: string | null;
  html_body?: string | null;
  text_body?: string | null;
  raw_body?: string | null;
  from_name?: string | null;
  from_email_address?: string | null;
  primary_to_email_address?: string | null;
  to?: string | string[] | null;
  cc?: string | string[] | null;
  bcc?: string | string[] | null;
  date_received?: string | null;
  type?: string | null;        // "Tracked Reply" / etc.
  folder?: string | null;      // "Inbox" / etc.
  raw_message_id?: string | null;
  parent_id?: number | null;
  interested?: boolean | null;
  automated_reply?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type EmailBisonEventType =
  | "email_sent"
  | "manual_email_sent"
  | "lead_first_contacted"
  | "lead_replied"
  | "lead_interested"
  | "lead_unsubscribed"
  | "untracked_reply_received"
  | "email_opened"
  | "email_bounced"
  | "email_account_added"
  | "email_account_removed"
  | "email_account_disconnected"
  | "email_account_reconnected";

export interface EmailBisonEventBlock {
  type: string; // upper-case event id, e.g. "EMAIL_SENT"
  name?: string;
  instance_url?: string;
  workspace_id?: number;
  workspace_name?: string;
}

export interface EmailBisonDataBlock {
  lead?: EmailBisonLead;
  campaign?: EmailBisonCampaign;
  sender_email?: EmailBisonSenderEmail;
  scheduled_email?: EmailBisonScheduledEmail;
  reply?: EmailBisonReply;
  campaign_event?: Record<string, unknown>;
  [key: string]: unknown;
}

// EmailBison's real webhook deliveries are UNWRAPPED — `{ event, data }` at the
// top level. The OpenAPI test-event sample shows a wrapped shape
// `{ data: { event, data } }`. We accept both so tests + real deliveries work.
export interface EmailBisonWebhookEnvelope {
  event?: EmailBisonEventBlock;
  data?: EmailBisonDataBlock | { event: EmailBisonEventBlock; data: EmailBisonDataBlock };
}

// Only subscribe to inbound-reply events. Everything else (email_sent,
// email_opened, etc.) is noise for an inbox app — EmailBison itself is the
// source of truth for outbound activity. If we ever want to render the
// outbound side of a thread we'll backfill from `GET /api/replies` /
// `GET /api/leads/{id}/replies` on demand.
export const RELEVANT_EVENTS: EmailBisonEventType[] = [
  "lead_replied",
];
