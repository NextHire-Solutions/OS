/*
 * THE MASTER CLIENT RECORD, FIELD BY FIELD — the client's architecture
 * document as code.
 *
 * Every field of §6 ("Master Client Record") and §12 ("Dates & Billing"), in
 * the document's own words and order, with the four answers §7 demands of each
 * one and the columns §15 asks the data dictionary to carry:
 *
 *   Field · Definition · Source of Truth · Who Can Edit · Tools That Use It · Sync Required?
 *
 * The Clients page table, the record panel, the tool views (§8) and the data
 * dictionary screen all render FROM THIS LIST, so a field cannot be spelled one
 * way on one screen and another way on the next (§13: "different terminology
 * for the same piece of information").
 *
 * Dependency-free: imported by server loaders and client components alike.
 */

export type FieldCategory =
  | "client"       // §6 Client Information
  | "billing"      // §6 Billing Information
  | "campaign"     // §6 Campaign Information
  | "performance"  // §6 Performance / Target Information
  | "lifecycle";   // §12 dates that §6 does not list

export const CATEGORY_LABEL: Record<FieldCategory, string> = {
  client: "Client Information",
  billing: "Billing Information",
  campaign: "Campaign Information",
  performance: "Performance / Target Information",
  lifecycle: "Lifecycle Dates",
};

/** Where the value physically lives today — shown as a chip next to the value. */
export type Source =
  | "Master record"
  | "Client Health"
  | "Master Inbox"
  | "Database"
  | "Analytics"
  | "Campaign system"
  | "Stripe"
  | "Derived";

export type FieldKind = "id" | "text" | "status" | "plan" | "date" | "number" | "person" | "list" | "tz" | "interval" | "count" | "url" | "email" | "money";

export interface FieldDef {
  key: string;
  /** Exactly as the document names it. */
  label: string;
  category: FieldCategory;
  kind: FieldKind;
  definition: string;
  /** §7 "Where does this information originate?" */
  sourceOfTruth: string;
  /** The system holding the value — the chip. */
  source: Source;
  /** §7 "Where can it be edited?" */
  editIn: string;
  /** Editable in place on the Clients page's record panel. */
  editable: boolean;
  /**
   * Kept on the record and in the Data dictionary, but not shown in the table,
   * the tool views or the record panel (the user's call, 30 Sep: "we can hide
   * date added" — it is the migration day for every existing client).
   */
  hidden?: boolean;
  /** §7 "Which tools consume it?" */
  tools: string[];
  /** §15 "Sync Required?" and §7 "What happens when it changes?" */
  sync: string;
}

const MASTER = "Master Client Record";

export const FIELDS: FieldDef[] = [
  /* ------------------------------------------------ §6 Client Information --- */
  { key: "clientId", label: "Client ID", category: "client", kind: "id",
    definition: "The unique identifier every tool uses for this client.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Nobody — assigned once at creation", editable: false, tools: ["All tools"], sync: "No — never changes" },
  { key: "name", label: "Client name", category: "client", kind: "text",
    definition: "The name the business uses for the client.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["All relevant tools"], sync: "Yes — renamed in every tool" },
  { key: "status", label: "Status", category: "client", kind: "status",
    definition: "Onboarding, Active, Paused or Churned (§9).", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["All relevant tools"], sync: "Yes — propagates to every tool, portal, campaigns and billing" },
  /* Profile completeness (client feedback, 6 Oct) — completeness.ts. */
  { key: "completeness", label: "Profile complete", category: "client", kind: "count",
    definition: "How much of the client's profile is filled in, of 22 checks: plan, onboarding and sign-up dates, account manager, salesperson, sender, website, Zillow, POC name and email, timezone, billing schedule, monthly target, markets, MLS, area, who leads are introduced to, brokerage, Stripe, a saved view, leads and a portal. The record lists what is missing and where to fill it.",
    sourceOfTruth: MASTER, source: "Derived", editIn: "Fill the missing fields on the client's record", editable: false, tools: ["All tools"], sync: "Recomputed as fields change" },
  { key: "plan", label: "Plan", category: "client", kind: "plan",
    definition: "Minimum, Production or Partner.", sourceOfTruth: MASTER, source: "Client Health",
    editIn: "Clients", editable: true, tools: ["Health", "Billing", "Portal"], sync: "Yes" },
  /*
   * Removed from every screen at the client's request (6 Oct): a client's dates
   * are its sign-up date (first $1 charge) and its onboarding date. Client
   * Health still keeps start_date as a fallback for its billing-cycle maths, so
   * the value is not deleted — only no longer shown or edited.
   */
  { key: "startDate", label: "Start date", category: "client", kind: "date", hidden: true,
    definition: "Client Health's own service start, kept only as its billing-cycle fallback. Not shown — use Sign up date and Onboarding date.", sourceOfTruth: MASTER, source: "Client Health",
    editIn: "Nobody — removed from screens", editable: false, tools: ["Health"], sync: "No" },
  { key: "onboardingDate", label: "Onboarding date", category: "client", kind: "date",
    definition: "When onboarding began.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients — set to the day a client is added; editable", editable: true, tools: ["Onboarding", "Performance"], sync: "No — a recorded moment" },
  { key: "dateAdded", label: "Date added", category: "client", kind: "date", hidden: true,
    definition: "When the client record was created.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Nobody — set at creation", editable: false, tools: ["Onboarding"], sync: "No" },
  { key: "market", label: "Market", category: "client", kind: "number",
    definition: "How many markets the client covers.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Database", "Campaigns"], sync: "Yes" },
  { key: "mls", label: "MLS", category: "client", kind: "list",
    definition: "The MLS boards the client's leads come from.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Database", "Campaigns"], sync: "Yes" },
  { key: "area", label: "Area", category: "client", kind: "list",
    definition: "The areas the client covers.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Database", "Campaigns"], sync: "Yes" },
  { key: "timezone", label: "Timezone", category: "client", kind: "tz",
    definition: "The client's timezone.", sourceOfTruth: MASTER, source: "Client Health",
    editIn: "Clients", editable: true, tools: ["Health", "Campaigns", "Analytics"], sync: "Yes" },
  { key: "team", label: "Team", category: "client", kind: "count",
    definition: "The client's own people who use the portal.", sourceOfTruth: MASTER, source: "Master Inbox",
    editIn: "Client portal", editable: false, tools: ["Portal", "Onboarding"], sync: "Yes" },
  { key: "agents", label: "Agents", category: "client", kind: "count",
    definition: "The client's agents — the people introductions are made for.", sourceOfTruth: MASTER, source: "Master Inbox",
    editIn: "Client portal", editable: false, tools: ["Portal", "Onboarding", "Database"], sync: "Yes" },
  { key: "dnc", label: "DNC list", category: "client", kind: "count",
    definition: "Who must never be contacted for this client.", sourceOfTruth: MASTER, source: "Master Inbox",
    editIn: "Client portal", editable: false, tools: ["Portal", "Database", "Campaigns"], sync: "Yes — pushed to EmailBison and Instantly" },
  { key: "sender", label: "Sender", category: "client", kind: "person",
    definition: "The sending identity the client's campaigns go out under.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Onboarding", "Campaigns"], sync: "Yes" },
  { key: "salesperson", label: "Salesperson", category: "client", kind: "person",
    definition: "Who sold the client.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Onboarding", "Sales"], sync: "Yes" },
  { key: "accountManager", label: "Account Manager", category: "client", kind: "person",
    definition: "Who runs the account day to day.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Onboarding", "Health", "CSM"], sync: "Yes" },
  { key: "signupDate", label: "Sign up date", category: "client", kind: "date",
    definition: "When the client signed up: its FIRST $1 charge in Stripe (the card check at sign-up), across every card it has paid with — replacing a card does not change it. With no $1 charge: the date entered here, else its first charge. Flagged when it falls after onboarding began (the same day is fine).", sourceOfTruth: "Stripe", source: "Stripe",
    editIn: "Stripe decides it; entered in Clients only when Stripe has no $1 charge", editable: true, tools: ["Sales", "Billing"], sync: "No — a recorded moment" },
  { key: "website", label: "Website", category: "client", kind: "url",
    definition: "The client's website.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Sales", "CSM"], sync: "No" },
  { key: "zillowUrl", label: "Zillow profile", category: "client", kind: "url",
    definition: "The client's Zillow profile.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Sales", "CSM"], sync: "No" },
  { key: "pocName", label: "POC name", category: "client", kind: "text",
    definition: "The client's point of contact for the business — not necessarily who leads are introduced to.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["CSM", "Billing"], sync: "No" },
  { key: "pocEmail", label: "POC email", category: "client", kind: "email",
    definition: "The point of contact's email address.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["CSM", "Billing"], sync: "No" },

  /* ----------------------------------------------- §6 Billing Information --- */
  { key: "firstBillingDate", label: "First billing date", category: "billing", kind: "date",
    definition: "The first date the client was billed: the first cycle date of its billing schedule.", sourceOfTruth: "Billing / Master Client Record", source: "Derived",
    editIn: "Follows the billing anchor", editable: false, tools: ["Health", "Billing"], sync: "Recomputed when the anchor changes" },
  { key: "billingAnchorDate", label: "Billing anchor date", category: "billing", kind: "date",
    definition: "A billing date the cycle is counted from.", sourceOfTruth: "Billing / Master Client Record", source: "Client Health",
    editIn: "Clients", editable: true, tools: ["Health", "Billing"], sync: "Yes" },
  { key: "billingInterval", label: "Billing interval", category: "billing", kind: "interval",
    definition: "Every 14 days, every 28 days, or monthly.", sourceOfTruth: "Billing / Master Client Record", source: "Client Health",
    editIn: "Clients", editable: true, tools: ["Health", "Billing"], sync: "Yes" },
  { key: "nextBillingDate", label: "Next billing date", category: "billing", kind: "date",
    definition: "The next date the client is billed.", sourceOfTruth: "Billing / Master Client Record", source: "Derived",
    editIn: "Follows the anchor and interval", editable: false, tools: ["Health", "Billing"], sync: "Recomputed daily" },
  { key: "stripeCustomerId", label: "Stripe Customer ID", category: "billing", kind: "id",
    definition: "The client's customer in Stripe.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Billing"], sync: "Links the record to Stripe" },
  { key: "stripeSubscriptionId", label: "Stripe Subscription ID", category: "billing", kind: "id",
    definition: "The subscription Stripe bills the client on.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Billing"], sync: "Yes — paused and resumed with the status" },
  { key: "totalSpend", label: "Total spend", category: "billing", kind: "money",
    definition: "Everything the client has paid: every successful Stripe charge, less refunds — as the Stripe customer page shows it.", sourceOfTruth: "Stripe", source: "Stripe",
    editIn: "Nobody — read from Stripe", editable: false, tools: ["Billing", "Commissions"], sync: "No — read live" },
  { key: "mrr", label: "MRR", category: "billing", kind: "money",
    definition: "Monthly recurring revenue: the client's live subscriptions as a monthly amount, Stripe's way ($750 every 14 days = $1,630.58).", sourceOfTruth: "Stripe", source: "Stripe",
    editIn: "Nobody — read from Stripe", editable: false, tools: ["Billing", "Commissions"], sync: "No — read live" },

  /* ---------------------------------------------- §6 Campaign Information --- */
  { key: "campaignId", label: "Campaign ID", category: "campaign", kind: "list",
    definition: "The platform id of each campaign sending for the client.", sourceOfTruth: "Campaign System", source: "Campaign system",
    editIn: "Instantly / EmailBison", editable: false, tools: ["Database", "Analytics"], sync: "Read from the platforms" },
  { key: "campaignName", label: "Campaign name", category: "campaign", kind: "list",
    definition: "The name of each of the client's campaigns.", sourceOfTruth: "Campaign System", source: "Campaign system",
    editIn: "Instantly / EmailBison", editable: false, tools: ["Health", "Analytics", "Database"], sync: "Read from the platforms" },
  { key: "campaignAliases", label: "Campaign aliases", category: "campaign", kind: "list",
    definition: "Other names the client's campaigns and inbox use for it.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Health", "Analytics", "Master Inbox"], sync: "Yes — written to every matcher" },
  { key: "campaignLocation", label: "MLS/location", category: "campaign", kind: "list",
    definition: "Where each campaign's leads come from.", sourceOfTruth: "Database", source: "Database",
    editIn: "Database", editable: false, tools: ["Database"], sync: "Read from the Database" },
  { key: "assignedLeads", label: "Assigned leads", category: "campaign", kind: "number",
    definition: "Leads assigned to the client's campaigns.", sourceOfTruth: "Database", source: "Database",
    editIn: "Database", editable: false, tools: ["Database", "Analytics"], sync: "Read from the Database" },
  { key: "savedViews", label: "Saved views", category: "campaign", kind: "list",
    definition: "The client's saved views in the Database (its agent searches) — matched by name or by the view's Client filter, or linked on the record.", sourceOfTruth: "Database", source: "Database",
    editIn: "Database (save a view named after the client), or link one on the record's Campaigns tab", editable: false, tools: ["Database", "Campaigns"], sync: "Read from the Database" },
  { key: "campaignSender", label: "Sender", category: "campaign", kind: "person",
    definition: "The sending identity on the client's campaigns.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients", editable: true, tools: ["Campaigns"], sync: "Yes" },
  { key: "campaignStatus", label: "Campaign status", category: "campaign", kind: "text",
    definition: "Running, paused or finished — per campaign.", sourceOfTruth: "Campaign System", source: "Campaign system",
    editIn: "Instantly / EmailBison, or Play/Pause in Client Health", editable: false, tools: ["Health", "Analytics", "Database"], sync: "Read live" },

  /* ------------------------------------ §6 Performance / Target Information --- */
  { key: "weeklyTarget", label: "Weekly introduction target", category: "performance", kind: "number",
    definition: "Introductions promised per week — replaced on screen by the billing-cycle target, kept for the tools that read it.", sourceOfTruth: MASTER, source: "Client Health",
    editIn: "Set from the plan", editable: false, tools: ["Health", "Analytics"], sync: "Yes" },
  { key: "monthlyTarget", label: "Monthly introduction target", category: "performance", kind: "number",
    definition: "Introductions due per 28-day period.", sourceOfTruth: MASTER, source: "Client Health",
    editIn: "Clients", editable: true, tools: ["Health", "Analytics"], sync: "Yes" },
  { key: "introductions", label: "Introductions delivered", category: "performance", kind: "number",
    definition: "Introductions made to the client, all time.", sourceOfTruth: "Analytics / Operational Systems", source: "Master Inbox",
    editIn: "Generated — nobody edits it", editable: false, tools: ["Analytics", "Health"], sync: "Fed back automatically" },
  { key: "replies", label: "Replies", category: "performance", kind: "number",
    definition: "Replies to the client's campaigns.", sourceOfTruth: "Database", source: "Database",
    editIn: "Generated — nobody edits it", editable: false, tools: ["Database", "Analytics"], sync: "Fed back automatically" },
  { key: "bounces", label: "Bounces", category: "performance", kind: "number",
    definition: "Emails to the client's leads that bounced.", sourceOfTruth: "Database", source: "Database",
    editIn: "Generated — nobody edits it", editable: false, tools: ["Database", "Analytics"], sync: "Fed back automatically" },
  { key: "inReview", label: "Leads in review", category: "performance", kind: "number",
    definition: "Leads waiting for review before they are sent.", sourceOfTruth: "Database", source: "Database",
    editIn: "Database", editable: false, tools: ["Database"], sync: "Fed back automatically" },
  { key: "exported", label: "Leads exported", category: "performance", kind: "number",
    definition: "Leads exported to the sending platforms.", sourceOfTruth: "Database", source: "Database",
    editIn: "Database", editable: false, tools: ["Database"], sync: "Fed back automatically" },

  /* ----------------------------------------------------- §12 lifecycle dates --- */
  { key: "pauseDate", label: "Pause date", category: "lifecycle", kind: "date",
    definition: "When the client was last paused. Pauses since 13 Sep 2026 are recorded automatically when the status changes to Paused; enter an earlier one here so Performance can count it.",
    sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients — recorded automatically on every change to Paused; enter a pause from before 13 Sep 2026 by hand", editable: true, tools: ["Health", "Billing", "Performance"], sync: "No — a recorded moment" },
  { key: "churnDate", label: "Churn date", category: "lifecycle", kind: "date",
    definition: "When the client last churned.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Clients — set to the day the status changes to Churned; editable", editable: true, tools: ["Health", "Billing", "Performance", "Commissions"], sync: "No — a recorded moment" },
  { key: "reactivationDate", label: "Reactivation date", category: "lifecycle", kind: "date",
    definition: "When the client last came back to Active from Paused or Churned.", sourceOfTruth: MASTER, source: "Master record",
    editIn: "Recorded automatically on every status change", editable: false, tools: ["Health", "Billing"], sync: "No — a recorded moment" },
];

export const FIELD_BY_KEY: Record<string, FieldDef> = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

export const CATEGORIES: FieldCategory[] = ["client", "billing", "campaign", "performance", "lifecycle"];

export function fieldsIn(category: FieldCategory): FieldDef[] {
  return FIELDS.filter((f) => f.category === category && !f.hidden);
}

/** Shown on screen: every field but the hidden ones (the dictionary lists all). */
export const shown = (key: string) => !FIELD_BY_KEY[key]?.hidden;

/* ======================================================================
 * §8 TOOL-SPECIFIC VIEWS — each tool's list, in the document's words and
 * order. A view is the SAME record, showing only the part that tool needs
 * (§5, §20). `key` names a column the Clients table knows how to render.
 * ==================================================================== */

export type ToolViewId = "health" | "database" | "portal" | "onboarding" | "analytics";

export interface ToolViewColumn {
  key: string;
  /** The document's word for this column in this tool's list. */
  label: string;
}

export interface ToolView {
  id: ToolViewId;
  label: string;
  /** The document's "Should focus on:" list, verbatim. */
  columns: ToolViewColumn[];
  /** Where the tool's own screen lives in the OS. */
  openIn: { label: string; href: string };
}

export const TOOL_VIEWS: ToolView[] = [
  {
    id: "health", label: "Client Health Dashboard",
    columns: [
      { key: "name", label: "Client" }, { key: "plan", label: "Plan" }, { key: "status", label: "Status" },
      { key: "weeklyTarget", label: "Weekly introduction target" }, { key: "monthlyTarget", label: "Monthly introduction target" },
      { key: "onboardingDate", label: "Onboarding date" }, { key: "billingAnchorDate", label: "Billing anchor date" },
      { key: "billingInterval", label: "Billing interval" }, { key: "timezone", label: "Timezone" },
      { key: "campaignName", label: "Campaign" }, { key: "campaignAliases", label: "Aliases" },
      { key: "performance", label: "Performance" }, { key: "health", label: "Health indicators" },
    ],
    openIn: { label: "Open Client Health", href: "/clients" },
  },
  {
    id: "database", label: "Database",
    columns: [
      { key: "name", label: "Client" }, { key: "status", label: "Client status" }, { key: "campaignLocation", label: "MLS/location" },
      { key: "campaignName", label: "Campaign" }, { key: "campaignId", label: "Campaign ID" }, { key: "assignedLeads", label: "Leads" },
      { key: "sequencers", label: "Sequencers" }, { key: "replies", label: "Replies" }, { key: "bounces", label: "Bounces" },
      { key: "inReview", label: "In Review" }, { key: "exported", label: "Exported" }, { key: "onboardingStatus", label: "Onboarding status" },
    ],
    openIn: { label: "Open the Database view", href: "/search/clients" },
  },
  {
    id: "portal", label: "Client Portal",
    columns: [
      { key: "name", label: "Client/team" }, { key: "team", label: "Team" }, { key: "agents", label: "Agents" }, { key: "dnc", label: "DNC list" },
      { key: "portal", label: "Relevant client-facing information" },
    ],
    openIn: { label: "Open Client Portals", href: "/inbox/portals" },
  },
  {
    id: "onboarding", label: "Onboarding",
    columns: [
      { key: "name", label: "Client" }, { key: "salesperson", label: "Salesperson" }, { key: "accountManager", label: "Account Manager" },
      { key: "team", label: "Team" }, { key: "agents", label: "Agents" }, { key: "dnc", label: "DNC" }, { key: "sender", label: "Sender" },
      { key: "dateAdded", label: "Date added" }, { key: "onboardingProgress", label: "Onboarding progress" },
    ],
    openIn: { label: "Open Onboarding", href: "/onboarding" },
  },
  {
    id: "analytics", label: "Analytics",
    columns: [
      { key: "name", label: "Client" }, { key: "campaigns", label: "Campaigns" }, { key: "introductions", label: "Introductions" },
      { key: "replies", label: "Replies" }, { key: "assignedLeads", label: "Leads" }, { key: "performance", label: "Performance" },
      { key: "campaignMetrics", label: "Other campaign-level metrics" },
    ],
    openIn: { label: "Open Campaign Management", href: "/analytics/clients" },
  },
];
