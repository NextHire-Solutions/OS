import type { Concept } from "./types";

/*
 * The concepts more than one tool claims to know, and exactly what each tool
 * means by its number.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ADDING A CONCEPT
 *
 * Every `definition` here was read out of the tool's source, not guessed. If
 * you add a source, go and read how it computes the number first. A definition
 * that is nearly right is worse than none: it turns "these disagree, why?" into
 * "these disagree, and the explanation is wrong", which costs more trust than
 * the original mystery did.
 *
 * The point of this file is that most disagreements are NOT bugs. They are two
 * honest answers to two subtly different questions. Written down, they stop
 * generating tickets.
 */

export const CONCEPTS: Concept[] = [
  {
    id: "clients",
    label: "Clients",
    question: "How many clients do we have?",
    // Client rosters are edited by hand and sync on different schedules, so a
    // one-client difference is normal churn, not a fault.
    tolerance: 0.03,
    sources: [
      {
        tool: "clients",
        key: "roster",
        label: "Client Health — roster",
        definition:
          "Every row in the clients table, including hidden and paused ones. The raw list, before any status filtering.",
        origin: "Client Health · Supabase",
        window: "current",
        platforms: ["instantly", "emailbison"],
      },
      {
        tool: "clients",
        key: "active",
        label: "Client Health — active only",
        definition:
          "Clients that are neither hidden nor manually paused. Derived from two flags, where `hidden` wins over `client_paused`, so a hidden-and-paused client counts once as churned.",
        origin: "Client Health · Supabase",
        requiresEnv: "CLIENT_HEALTH_READ_TOKEN",
        window: "current",
        platforms: ["instantly", "emailbison"],
      },
      {
        tool: "analytics",
        key: "clients",
        label: "Analytics — clients",
        definition:
          "Clients configured for campaign attribution. A client exists here only if someone created it to match campaign names, so clients with no campaigns are usually absent.",
        origin: "Analytics · Supabase",
        requiresEnv: "ANALYTICS_AUTH_SECRET",
        window: "current",
        platforms: ["emailbison"],
      },
    ],
  },

  {
    id: "emails-sent",
    label: "Emails sent",
    question: "How many emails went out?",
    tolerance: 0.02,
    sources: [
      {
        tool: "analytics",
        key: "sent",
        label: "Analytics — sent (30d)",
        definition:
          "Emails sent through EmailBison in the last 30 days. EmailBison ONLY — anything sent via Instantly is invisible here, which is the single biggest reason this number reads low against Client Health.",
        origin: "EmailBison",
        requiresEnv: "ANALYTICS_AUTH_SECRET",
        window: "30d",
        platforms: ["emailbison"],
      },
      {
        tool: "clients",
        key: "emails",
        label: "Client Health — emails sent",
        definition:
          "Emails sent this ISO week (Monday-start) across all clients, summed from BOTH Instantly and EmailBison. A different window and a wider set of platforms than Analytics.",
        origin: "Instantly + EmailBison",
        window: "iso-week",
        platforms: ["instantly", "emailbison"],
      },
    ],
  },

  {
    id: "replies",
    label: "Replies",
    question: "How many people replied?",
    tolerance: 0.05,
    sources: [
      {
        tool: "analytics",
        key: "replies",
        label: "Analytics — replies (30d)",
        definition:
          "Replies to EmailBison campaigns in the last 30 days, counted as reply events. Includes automated replies unless a campaign is configured to exclude them.",
        origin: "EmailBison",
        requiresEnv: "ANALYTICS_AUTH_SECRET",
        window: "30d",
        platforms: ["emailbison"],
      },
      {
        tool: "analytics",
        key: "human-replies",
        label: "Analytics — human replies (30d)",
        definition:
          "The same 30 days, excluding replies classified as automated (out-of-office, autoresponders). Always lower than total replies, by design.",
        origin: "EmailBison",
        requiresEnv: "ANALYTICS_AUTH_SECRET",
        window: "30d",
        platforms: ["emailbison"],
      },
      {
        tool: "inbox",
        key: "threads",
        label: "Master Inbox — open threads",
        definition:
          "Conversations currently in the inbox, ALL TIME, across both Instantly and EmailBison. Not a 30-day figure and not a count of reply events — one person replying four times is one thread here and four replies in Analytics.",
        origin: "Master Inbox · Supabase",
        requiresEnv: "MASTER_INBOX_ADMIN_TOKEN",
        window: "all-time",
        platforms: ["instantly", "emailbison"],
      },
    ],
  },

  {
    id: "introductions",
    label: "Introductions",
    question: "How many introductions have been made?",
    tolerance: 0.02,
    sources: [
      {
        tool: "clients",
        key: "intros",
        label: "Client Health — intros this week",
        definition:
          "Introductions recorded this ISO week (Monday-start), pulled from the Corofy API and from Master Inbox. Two sources merged, so an introduction recorded in both is de-duplicated here but may be counted once in each upstream.",
        origin: "Corofy + Master Inbox",
        window: "iso-week",
        platforms: ["corofy", "master-inbox"],
      },
      {
        tool: "inbox",
        key: "introduction-label",
        label: "Master Inbox — Introduction label",
        definition:
          "Threads carrying the `Introduction` label, all time. A label is applied per thread by a person or the AI labeller, so this counts conversations tagged as introductions rather than introductions delivered to a client.",
        origin: "Master Inbox · Supabase",
        requiresEnv: "MASTER_INBOX_ADMIN_TOKEN",
        window: "all-time",
        platforms: ["instantly", "emailbison"],
      },
    ],
  },
];

export function conceptById(id: string): Concept | undefined {
  return CONCEPTS.find((c) => c.id === id);
}
