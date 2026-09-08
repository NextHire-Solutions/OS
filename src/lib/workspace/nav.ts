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
      { kind: "page", id: "consistency", label: "Consistency", route: "/consistency" },
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
          { id: "leads", label: "Leads", path: "/leads", verified: true },
          { id: "archive", label: "Archive", path: "/inbox/archive", verified: true },
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
           * Three views of ONE page, switched by React state:
           *   const [view, setView] = useState<'weekly'|'biweekly'|'success'>('weekly')
           *
           * There is no URL for the other two. The design promotes them to rail
           * siblings, and a rail item needs an address — so this needs a small
           * change in Client Health to seed that state from `?view=`.
           * `patches/client-health-view-param.patch` does exactly that.
           *
           * Until it is applied all three land on Weekly, where the tool's own
           * toggle still works. Marked unverified so the shell can say "opens
           * the Weekly view" rather than silently appearing broken.
           */
          { id: "weekly", label: "Weekly", path: "/", verified: true },
          { id: "biweekly", label: "Bi-Weekly", path: "/?view=biweekly", verified: false },
          { id: "success", label: "Client Success", path: "/?view=success", verified: false },
        ],
      },
      {
        kind: "product",
        id: "analytics",
        label: "Campaign Analytics",
        baseUrlEnv: "ANALYTICS_URL",
        children: [
          { id: "campaign", label: "Campaign", path: "/analytics/campaign", verified: true },
          { id: "infrastructure", label: "Infrastructure", path: "/analytics/infrastructure", verified: true },
          { id: "attribution", label: "Attribution", path: "/analytics/attribution", verified: true },
          { id: "copy", label: "Copy & Offer", path: "/analytics/copy-offer", verified: true },
          { id: "campaigns", label: "Campaigns", path: "/campaigns", verified: true },
          { id: "schedule", label: "Schedule", path: "/schedule", verified: true },
          { id: "clients", label: "Clients", path: "/clients", verified: true },
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
          { id: "master", label: "Master List", path: "/#master", verified: false },
          { id: "accounts", label: "Courted accounts", path: "/#accounts", verified: false },
          { id: "mls", label: "MLS monitor", path: "/#mls", verified: false },
          { id: "import", label: "Import Profile URLs", path: "/#import", verified: false },
        ],
      },
    ],
  },
  {
    label: "Admin",
    items: [{ kind: "page", id: "team-access", label: "Team access", route: "/admin/team" }],
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
  consistency: "/consistency",
  "team-access": "/team",
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
  const leaf = product.children.find((c) => c.id === second);
  return `${tool}:${leaf?.id ?? product.children[0]?.id ?? ""}`;
}
