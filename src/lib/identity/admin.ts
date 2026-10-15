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

/** The addresses in AUTH_USERS — the Railway-managed allow-list. Never hashes. */
function authUserEmails(): string[] {
  const raw = process.env.AUTH_USERS;
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, entry.lastIndexOf(":") === -1 ? undefined : entry.lastIndexOf(":")).trim().toLowerCase())
    .filter(Boolean);
}

/** True for an address that signs in through AUTH_USERS (managed in Railway, not here). */
export function isEnvAccount(email: string | null | undefined): boolean {
  if (!email) return false;
  return authUserEmails().includes(email.trim().toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = adminEmails();
  const key = email.trim().toLowerCase();
  /*
   * Unset => everyone in AUTH_USERS. See the note above — with one addition:
   * "everyone signed in" once meant exactly AUTH_USERS, and since 0004 it does
   * not. An invited person is never an admin by default; the fail-open only
   * ever reaches the Railway-managed allow-list. The first live invite came
   * back as "Owner, every tool" before this line existed.
   */
  if (admins.length === 0) return authUserEmails().includes(key);
  return admins.includes(key);
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
  /** The menu section it sits in — Team access groups its switches by it. */
  group: "Workspace" | "Products";
}

/*
 * Kept here rather than derived from the connector registry, because these two
 * lists answer different questions and drift apart on purpose. The connector
 * registry is "what the status board monitors" — it still includes the Database
 * app. This is "what a person can be granted", which excludes it.
 */
export const GRANTABLE_TOOLS: ToolDescriptor[] = [
  /*
   * Workspace pages, in menu order — their own switches since 15 Oct (they
   * followed a role or the admin rule). An admin holds every switch, always.
   * Commissions still shows a non-admin only their own payouts.
   */
  { id: "roster", label: "Clients", description: "The master client list and each client's record, billing included.", group: "Workspace" },
  { id: "commissions", label: "Commissions", description: "Payouts. An admin sees everyone's; anyone else only their own.", group: "Workspace" },
  { id: "performance", label: "Performance", description: "Revenue, subscriptions and the billing calendar, across every client.", group: "Workspace" },
  // Products, in menu order.
  { id: "inbox", label: "Master Inbox", description: "Unified sales inbox for cold outreach replies.", group: "Products" },
  // Its own switch since 13 Oct; it used to come with Master Inbox.
  { id: "portals", label: "Client Portals", description: "The client portals: each one's link, on/off, SMS alerts and pipeline.", group: "Products" },
  { id: "clients", label: "Client Health", description: "Live client outreach health.", group: "Products" },
  // Three switches since 15 Oct; until then one switch opened all three sections.
  { id: "analytics", label: "Campaign Analytics", description: "Campaign performance, volume, infrastructure and attribution.", group: "Products" },
  { id: "campaigns", label: "Campaign Management", description: "Running campaigns: sequences, launching, pausing, inboxes and schedules.", group: "Products" },
  { id: "inboxes", label: "Inboxes", description: "Every sending inbox, with its limits, sends, replies and bounces.", group: "Products" },
  { id: "search", label: "Agent Search", description: "Sources agent data from Courted, Zillow and Realtor.com.", group: "Products" },
  // Onboarding was removed on 9 Oct: no longer offered. The tool id stays valid
  // (existing grants and sessions carry it) and simply opens nothing.
];

/** Narrows arbitrary input to real tool ids. Unknown names grant nothing. */
export function coerceTools(input: unknown): ToolId[] {
  const claimed = Array.isArray(input) ? input.map((v) => String(v).trim().toLowerCase()) : [];
  return ALL_TOOLS.filter((t) => claimed.includes(t));
}
