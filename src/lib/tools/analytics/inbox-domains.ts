/*
 * The Inboxes page's Domains view, and the positive rate both views show
 * (14 Nov).
 *
 * A domain row adds up the inboxes on that domain that the page's filters
 * leave, so every filter — a vendor, a tag, a platform, the number bounds —
 * narrows the domains the same way it narrows the inboxes.
 *
 * NULL STILL MEANS "NOT KNOWN" (see inboxes.ts). A sum is of the inboxes whose
 * figure is known; when none is, the domain's figure is not known either, and
 * `missing` says how many inboxes a sum left out so the cell can say so.
 *
 * Pure, with no `@/` imports — tested directly.
 */

export interface RateInputs {
  /** Replies in Master Inbox (inbox-positives.ts). */
  masterInboxReplies: number | null;
  positiveAllTime: number | null;
}

/**
 * Positive replies per reply, both counted in Master Inbox for the same inbox,
 * so the rate is never over 100% — kept as a guard all the same. Not known
 * without both, or with no reply.
 */
export function positiveRate(row: RateInputs): number | null {
  const { masterInboxReplies: replies, positiveAllTime: positive } = row;
  if (replies === null || positive === null || replies <= 0 || positive > replies) return null;
  return positive / replies;
}

/** The part after the @, lowercased. Null when there is none. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d ? d : null;
}

export interface DomainSource extends RateInputs {
  email: string;
  sentAllTime: number | null;
}

export interface DomainRow extends RateInputs {
  domain: string;
  /** Addresses: a mailbox connected to both platforms is one inbox. */
  inboxes: number;
  sentAllTime: number | null;
  /** How many inboxes each sum left out because their figure is not known. */
  missing: { sent: number; replies: number; positive: number };
}

const FIGURES = [
  ["sent", "sentAllTime"],
  ["replies", "masterInboxReplies"],
  ["positive", "positiveAllTime"],
] as const;

/** One row per domain of these inboxes, A to Z. */
export function domainRows(rows: readonly DomainSource[]): DomainRow[] {
  const out = new Map<string, DomainRow & { addresses: Set<string> }>();
  for (const r of rows) {
    const domain = domainOf(r.email);
    if (!domain) continue;
    let d = out.get(domain);
    if (!d) {
      d = {
        domain, inboxes: 0, addresses: new Set(),
        sentAllTime: null, masterInboxReplies: null, positiveAllTime: null,
        missing: { sent: 0, replies: 0, positive: 0 },
      };
      out.set(domain, d);
    }
    d.addresses.add(r.email.trim().toLowerCase());
    for (const [name, field] of FIGURES) {
      const v = r[field];
      if (v === null) d.missing[name]++;
      else d[field] = (d[field] ?? 0) + v;
    }
  }
  return [...out.values()]
    .map(({ addresses, ...d }) => ({ ...d, inboxes: addresses.size }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

export interface DomainColumnDef {
  key: string;
  label: string;
  hint?: string;
}

/** The Domains view's columns after Domain, in the order the table draws them. */
export const DOMAIN_COLUMNS: readonly DomainColumnDef[] = [
  { key: "inboxes", label: "Inboxes", hint: "Inboxes on this domain that match the filters" },
  { key: "sent", label: "Sent (all time)" },
  // "Replies" alone here: the Domains view has no platform Replied to tell it from, and the long name cut off Positive rate at 1,280px.
  { key: "miReplies", label: "Replies", hint: "Replies (Master Inbox): conversations where a lead replied to this domain's inboxes, one per lead and campaign, from May 2026; out-of-office and automatic replies left out" },
  { key: "positive", label: "Positive replies", hint: "Replies labelled Interested in Master Inbox, or introduced — not EmailBison's Interested flag" },
  { key: "positiveRate", label: "Positive rate", hint: "Positive replies ÷ Replies" },
];

/** What a Domains column sorts by. Null is "not known", which sorts last either way. */
export function domainSortValue(row: DomainRow, key: string): string | number | null {
  switch (key) {
    case "domain":
      return row.domain;
    case "inboxes":
      return row.inboxes;
    case "sent":
      return row.sentAllTime;
    case "miReplies":
      return row.masterInboxReplies;
    case "positive":
      return row.positiveAllTime;
    case "positiveRate":
      return positiveRate(row);
    default:
      return null;
  }
}
