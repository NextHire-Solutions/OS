// FilterState — the shape stored in custom_views.filter_json AND encoded
// into URL search params for ad-hoc filtering. Each FilterRow is a single
// condition the user has built.
//
// Two consumers:
//   - <FilterBuilder> (client) — mutates FilterState locally, then either
//     URL-encodes it (Apply) or POSTs it to /api/custom-views (Save).
//   - loadThreads (server) — reads it from searchParams or filter_json and
//     applies clauses + post-filtering.

export type FilterField =
  | "labels"
  | "channels"
  | "campaigns"
  | "clients"
  | "reply_since"
  | "last_message_from"
  | "message_counts"
  | "read_status"
  | "subject"
  | "keywords"
  | "name"
  | "email"
  | "domain";

export type FilterOperator =
  | "is"
  | "not"
  | "equals"
  | "greater_than"
  | "less_than"
  | "contains";

export interface FilterRow {
  id: string; // local row id (uuid-ish)
  enabled: boolean;
  field: FilterField;
  // Sub-type, e.g. "mi_user_reply" / "lead_reply" for reply_since,
  // or "sent" / "received" for message_counts. Empty for fields without one.
  subtype?: string;
  operator: FilterOperator;
  // Value is field-dependent. For multi-select (labels, channels) it's
  // an array of ids; for numeric (reply_since days, message_counts) a number;
  // for text (subject, keywords, name) a string.
  value: unknown;
}

export interface FilterState {
  rows: FilterRow[];
}

export const EMPTY_FILTER: FilterState = { rows: [] };

// URL-encode the filter state. Single search param `f` carries a base64-encoded
// JSON blob. Keeps the URL bar tidy and the encoding stable.
export function encodeFilter(state: FilterState): string {
  const json = JSON.stringify(state);
  // btoa is browser-only; on server we hand-roll with Buffer-equivalent.
  if (typeof window !== "undefined") {
    return window.btoa(unescape(encodeURIComponent(json)));
  }
  return Buffer.from(json, "utf-8").toString("base64");
}

export function decodeFilter(input: string | undefined): FilterState {
  if (!input) return EMPTY_FILTER;
  try {
    const json =
      typeof window !== "undefined"
        ? decodeURIComponent(escape(window.atob(input)))
        : Buffer.from(input, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.rows)) return EMPTY_FILTER;
    return { rows: parsed.rows as FilterRow[] };
  } catch {
    return EMPTY_FILTER;
  }
}

export function countActiveRows(state: FilterState): number {
  return state.rows.filter((r) => r.enabled).length;
}

// Default row shapes when the user adds a new condition. Keeps the UI
// consistent and ensures the operator/value match the field.
export function defaultRow(field: FilterField): FilterRow {
  const id = Math.random().toString(36).slice(2, 10);
  switch (field) {
    case "labels":
      return { id, enabled: true, field, operator: "is", value: [] };
    case "channels":
      return { id, enabled: true, field, operator: "is", value: [] };
    case "campaigns":
      // Stored as an array of campaign_id strings (text). Falls through to
      // the same multi-select UI shape as labels/channels.
      return { id, enabled: true, field, operator: "is", value: [] };
    case "clients":
      // Stored as an array of client_id UUIDs. Same multi-select shape as
      // campaigns; threads.client_id is set at sync time by deriveClient.
      return { id, enabled: true, field, operator: "is", value: [] };
    case "reply_since":
      return {
        id,
        enabled: true,
        field,
        subtype: "mi_user_reply",
        operator: "greater_than",
        value: 3,
      };
    case "last_message_from":
      return { id, enabled: true, field, operator: "equals", value: "me" };
    case "message_counts":
      return {
        id,
        enabled: true,
        field,
        subtype: "sent",
        operator: "equals",
        value: 1,
      };
    case "read_status":
      return { id, enabled: true, field, operator: "equals", value: "unread" };
    case "subject":
    case "keywords":
    case "name":
    case "email":
    case "domain":
      return { id, enabled: true, field, operator: "contains", value: "" };
  }
}

export const FIELD_LABELS: Record<FilterField, string> = {
  labels: "Labels",
  channels: "Channels",
  campaigns: "Campaigns",
  clients: "Clients",
  reply_since: "Reply Since",
  last_message_from: "Last Message From",
  message_counts: "Message Counts",
  read_status: "Read Status",
  subject: "Subject",
  keywords: "Keywords",
  name: "Name",
  email: "Email",
  domain: "Domain",
};
