/*
 * Who may see and change other people's access.
 *
 * Separate from tool grants on purpose. A grant answers "may this person open
 * Analytics"; being an admin answers "may this person decide who opens
 * Analytics". Collapsing the two would mean anyone with all four tools could
 * also hand out all four tools, which is a different and much larger power.
 */

// Relative, not the "@/" alias, so `node --test` can run this file's tests
// without a bundler resolving path mappings.
import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

/**
 * Admins come from ADMIN_EMAILS, a comma or newline separated list.
 *
 * When it is UNSET, every signed-in operator is an admin. That mirrors the
 * BS_GRANTS bootstrap rule and exists for the same reason: on the first deploy
 * nobody is listed, and a workspace whose admin screen refuses its only user is
 * useless. AUTH_USERS is itself an allow-list only a Railway operator can edit,
 * so the fail-open reaches nobody who could not already sign in.
 *
 * Once ADMIN_EMAILS is set it is authoritative — signing in no longer implies
 * being an admin. `describe()` reports which mode is live so the screen can say
 * so out loud rather than leaving it to be discovered.
 */
export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = adminEmails();
  // Unset => everyone signed in. See the note above.
  if (admins.length === 0) return true;
  return admins.includes(email.trim().toLowerCase());
}

export function describeAdmins(): { governed: boolean; count: number } {
  const admins = adminEmails();
  return { governed: admins.length > 0, count: admins.length };
}

/** What the Team access screen renders as columns. */
export interface ToolDescriptor {
  id: ToolId;
  label: string;
  description: string;
}

/*
 * Kept here rather than derived from the connector registry, because these two
 * lists answer different questions and drift apart on purpose. The connector
 * registry is "what the status board monitors" — it still includes the Database
 * app. This is "what a person can be granted", which excludes it.
 */
export const GRANTABLE_TOOLS: ToolDescriptor[] = [
  { id: "inbox", label: "Master Inbox", description: "Unified sales inbox for cold outreach replies." },
  { id: "clients", label: "Client Health", description: "Live client outreach health." },
  { id: "analytics", label: "Campaign Analytics", description: "Campaign performance and attribution." },
  { id: "search", label: "Agent Search", description: "Sources agent data from Courted, Zillow and Realtor.com." },
];

/** Narrows arbitrary input to real tool ids. Unknown names grant nothing. */
export function coerceTools(input: unknown): ToolId[] {
  const claimed = Array.isArray(input) ? input.map((v) => String(v).trim().toLowerCase()) : [];
  return ALL_TOOLS.filter((t) => claimed.includes(t));
}
