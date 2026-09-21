import type { ToolId } from "@/lib/bs-auth";

/*
 * The workspace navigation tree.
 *
 * This is the one genuinely architectural decision in the design: each tool's
 * own navigation is lifted OUT of the tool and into a single rail, so the
 * workspace has one navigation model instead of four. Master Inbox currently
 * carries an icon rail plus a sidebar plus a second settings sidebar; Analytics
 * has a sidebar plus tabs; Client Health has a header with a view toggle. All
 * of it collapses into the structure below.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS A LEAF AND WHAT IS NOT
 *
 * A leaf is a DESTINATION — somewhere you can be. Tabs that filter the thing
 * you are already looking at are not navigation and stay inside the tool:
 * Master Inbox's label tabs (Interested, Meetings Booked) are saved views, and
 * Analytics' Charts/Clients/Campaigns segmented control switches how one
 * dataset is drawn. Promoting those to the rail would make it enormous and
 * would move controls away from the data they act on.
 *
 * `path` is relative to that tool's own origin. `verified` means the path was
 * confirmed against the running app rather than guessed — an unverified link
 * that 404s inside a pane is worse than no link, because the pane looks broken
 * rather than absent.
 */

export interface NavLeaf {
  id: string;
  label: string;
  /** Path within the tool. Undefined for screens the workspace itself owns. */
  path?: string;
  verified?: boolean;
  /** A count badge, when the tool can tell us one. */
  badgeKey?: "inbox-unread" | "reminders";
}

export interface NavProduct {
  kind: "product";
  id: ToolId;
  label: string;
  /** Which env var holds this tool's base URL. */
  baseUrlEnv: string;
  children: NavLeaf[];
}

export interface NavPage {
  kind: "page";
  id: string;
  label: string;
  /** Rendered by the workspace, not embedded. */
  route: string;
}

export interface NavSection {
  label: string;
  items: (NavProduct | NavPage)[];
}

export const NAV: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { kind: "page", id: "home", label: "Home", route: "/" },
      { kind: "page", id: "performance", label: "Performance", route: "/performance" },
      { kind: "page", id: "roster", label: "Clients", route: "/roster" },
    ],
  },
  {
    label: "Products",
    items: [
      {
        kind: "product",
        id: "inbox",
        label: "Master Inbox",
        baseUrlEnv: "MASTER_INBOX_URL",
        children: [
          { id: "all-email", label: "All Email", path: "/inbox/all-email", verified: true, badgeKey: "inbox-unread" },
          { id: "reminders", label: "Reminders", path: "/reminders", verified: true, badgeKey: "reminders" },
          /*
           * Leads was removed at the user's request: the workspace's own
           * Clients page is the roster now, and the tool's Leads view listed
           * the same people from Master Inbox's side of the fence. Its route
           * still resolves — an old bookmark degrades to All Email rather
           * than 404ing — it simply is not offered in the rail.
           */
          { id: "archive", label: "Archive", path: "/inbox/archive", verified: true },
          // Trash is the third folder in the tool's sidebar (Reminders, Archive,
          // Trash). Without this entry a trashed conversation could only be
          // found, restored or purged by typing the URL.
          { id: "trash", label: "Trash", path: "/inbox/trash", verified: true },
          // The MASTER portal list — the admin table of which clients have a
          // portal. The individual client portals it links to live on
          // portal.brokerstaffer.com and are deliberately outside the
          // workspace; this page is in scope, they are not.
          { id: "portals", label: "Client Portals", path: "/portals", verified: true },
          // Master Inbox's settings are eight pages behind a second sidebar.
          // One entry here; the tool keeps its own sub-navigation inside, which
          // is the right trade — hoisting eight rarely-used pages into the rail
          // would cost more than it saves.
          { id: "settings", label: "Settings", path: "/settings/clients", verified: true },
        ],
      },
      {
        kind: "product",
        id: "clients",
        label: "Client Health",
        baseUrlEnv: "CLIENT_HEALTH_URL",
        children: [
          /*
           * All three are built here, reading Client Health's own database
           * through the tool's own derive(). The live tool keeps running
           * untouched — it is a background worker now, not something we embed.
           *
           * In the live tool these are three states of one page with no URL of
           * their own. Here each is a real address, which is what lets the rail
           * link straight to Bi-Weekly and the browser's back button work.
           */
          { id: "weekly", label: "Weekly", path: "/", verified: true },
          { id: "biweekly", label: "Bi-Weekly", path: "/?view=biweekly", verified: true },
          { id: "success", label: "Client Success", path: "/?view=success", verified: true },
        ],
      },
      {
        kind: "product",
        id: "analytics",
        label: "Campaign Analytics",
        baseUrlEnv: "ANALYTICS_URL",
        children: [
          { id: "campaign", label: "Campaign", path: "/analytics/campaign", verified: true },
          // Email volume — the tool's second tab; a whole page the workspace never had.
          { id: "volume", label: "Volume", path: "/analytics/volume", verified: true },
          { id: "infrastructure", label: "Infrastructure", path: "/analytics/infrastructure", verified: true },
          { id: "attribution", label: "Attribution", path: "/analytics/attribution", verified: true },
          { id: "copy", label: "Copy & Offer", path: "/analytics/copy-offer", verified: true },
          { id: "campaigns", label: "Campaigns", path: "/analytics/campaigns", verified: true },
          { id: "schedule", label: "Schedule", path: "/analytics/schedule", verified: true },
          { id: "clients", label: "Clients", path: "/analytics/clients", verified: true },
        ],
      },
      {
        kind: "product",
        id: "onboarding",
        label: "Onboarding",
        baseUrlEnv: "ONBOARDING_URL",
        children: [
          { id: "pipeline", label: "Pipeline", path: "/", verified: true },
          { id: "stages", label: "Stages", path: "/stages", verified: true },
          { id: "templates", label: "Templates", path: "/templates", verified: true },
          { id: "settings", label: "Settings", path: "/settings", verified: true },
        ],
      },
      {
        kind: "product",
        id: "search",
        label: "Agent Search",
        baseUrlEnv: "SCRAPER_URL",
        children: [
          // One long scrolling page today. The design splits it into rail
          // items, which needs anchors the app does not have yet — so these are
          // unverified on purpose and every one lands on the same page for now.
          { id: "search", label: "Search", path: "/", verified: true },
          { id: "master", label: "Master List", path: "/", verified: true },
          { id: "accounts", label: "Courted accounts", path: "/", verified: true },
          { id: "mls", label: "MLS monitor", path: "/", verified: true },
          { id: "import", label: "Import Profile URLs", path: "/", verified: true },
        ],
      },
    ],
  },
  {
    label: "Admin",
    items: [
      { kind: "page", id: "assistant", label: "Assistant", route: "/assistant" },
      { kind: "page", id: "team-access", label: "Team access", route: "/admin/team" },
      { kind: "page", id: "reply-agent", label: "Reply agent", route: "/reply-agent" },
    ],
  },
];

/** Flattened destinations, for the command palette and for route matching. */
export interface Destination {
  id: string;
  label: string;
  group: string;
  /** Set for a tool pane. */
  tool?: ToolId;
  path?: string;
  /** Set for a workspace-owned screen. */
  route?: string;
  verified: boolean;
}

export function destinations(): Destination[] {
  const out: Destination[] = [];
  for (const section of NAV) {
    for (const item of section.items) {
      if (item.kind === "page") {
        out.push({
          id: item.id,
          label: item.label,
          group: section.label,
          route: item.route,
          verified: true,
        });
        continue;
      }
      for (const leaf of item.children) {
        out.push({
          id: `${item.id}:${leaf.id}`,
          label: leaf.label,
          group: item.label,
          tool: item.id,
          path: leaf.path,
          verified: leaf.verified ?? false,
        });
      }
    }
  }
  return out;
}

/** Every tool a person can reach, in rail order. */
export function products(): NavProduct[] {
  return NAV.flatMap((s) => s.items).filter((i): i is NavProduct => i.kind === "product");
}

/* ===========================================================================
   URLS
   ---------------------------------------------------------------------------
   Every screen has an address, so a link can be pasted into Slack and the back
   button behaves. The scheme is deliberately short and readable — this is what
   people see in the address bar, and it is the whole reason the tools feel like
   one product rather than five:

     /                     Home
     /performance          Performance
     /inbox                Master Inbox, its first screen
     /inbox/reminders      a specific screen within it
     /clients              Client Health
     /analytics            Campaign Analytics
     /search               Agent Search
     /onboarding           Onboarding
     /team                 Team access

   The tool's OWN hostname never appears. It is loaded inside the page, so the
   address bar stays on the workspace throughout.
   =========================================================================== */

/** Slug for each product, used as the first path segment. */
const PRODUCT_SLUG: Record<string, ToolId> = {
  inbox: "inbox",
  clients: "clients",
  analytics: "analytics",
  search: "search",
  onboarding: "onboarding",
};

/** The workspace's own screens. */
const PAGE_PATH: Record<string, string> = {
  home: "/",
  performance: "/performance",
  roster: "/roster",
  "team-access": "/team",
  "reply-agent": "/reply-agent",
  assistant: "/assistant",
  account: "/account",
};

/** The address for a destination id. */
export function pathForId(id: string): string {
  if (PAGE_PATH[id]) return PAGE_PATH[id];

  const [tool, leaf] = id.split(":");
  if (!tool || !PRODUCT_SLUG[tool]) return "/";

  const product = products().find((p) => p.id === tool);
  // The product's FIRST child is its bare path, so /inbox lands somewhere real
  // rather than needing /inbox/all-email.
  if (!leaf || product?.children[0]?.id === leaf) return `/${tool}`;
  return `/${tool}/${leaf}`;
}

/** The destination id for a path. Unknown paths fall back to Home. */
export function idForPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "home";

  const [first, second] = segments;
  // The rail files Team access under "Admin", and the audit and timing
  // harnesses address it as /admin/team — a refresh there rendered Home.
  if (first === "admin" && (second === "team" || second === undefined)) return "team-access";

  for (const [id, path] of Object.entries(PAGE_PATH)) {
    if (path === `/${first}`) return id;
  }

  const tool = PRODUCT_SLUG[first];
  if (!tool) return "home";

  const product = products().find((p) => p.id === tool);
  if (!product) return "home";

  if (!second) return `${tool}:${product.children[0]?.id ?? ""}`;
  // An unrecognised leaf opens the product's first screen rather than a blank
  // pane — a stale link should degrade to something useful.
  const leaf = product.children.find(
      // The id is the workspace's own segment; the declared `path` is the
      // tool's. Accepting both means a link copied from the deployed tool
      // (/analytics/copy-offer) lands on the same screen as /analytics/copy
      // instead of falling through to the product's first child.
      (c) => c.id === second || c.path === `/${tool}/${second}`,
    );
  return `${tool}:${leaf?.id ?? product.children[0]?.id ?? ""}`;
}
