import { headers } from "next/headers";
import { getAllSnapshots } from "@/lib/status/store";
import { aggregate } from "@/lib/status/derive";
import { getOverview } from "@/lib/workspace/overview";
import { getPerformance } from "@/lib/workspace/performance";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";
import { getAgentSearchOverview } from "@/lib/tools/agent-search/agents";
import { getInbox } from "@/lib/tools/master-inbox/inbox-view";
import { getReminders } from "@/lib/tools/master-inbox/reminders";
import { getSettings } from "@/lib/tools/master-inbox/settings";
import { getPortals } from "@/lib/tools/master-inbox/portals";
import { getClientsOverview } from "@/lib/clients/overview";
import { optionalEnv } from "@/lib/env";
import { Workspace } from "@/components/shell/workspace";
import { HomeScreen } from "@/components/screens/home";
import { TeamAccessScreen } from "@/components/screens/team-access";
import { DiscrepanciesScreen } from "@/components/screens/discrepancies";
import { ClientHealthWeekly } from "@/components/screens/client-health/weekly";
import { ClientHealthBiWeekly } from "@/components/screens/client-health/biweekly";
import { ClientHealthSuccess } from "@/components/screens/client-health/success";
import { OnboardingPipelineScreen } from "@/components/screens/onboarding/pipeline";
import { AgentSearchScreen } from "@/components/screens/agent-search/agents";
import { FullInbox } from "@/components/screens/master-inbox/full-inbox";
import { ThreadDetail } from "@/components/screens/master-inbox/thread-detail";
import { FolderEmpty } from "@/components/master-inbox/folder-empty";
import { PortalDetail } from "@/components/screens/master-inbox/portal-detail";
import { RemindersScreen } from "@/components/screens/master-inbox/reminders";
import { MasterInboxSettingsScreen } from "@/components/screens/master-inbox/settings";
import { PortalsScreen } from "@/components/screens/master-inbox/portals";
import { ClientsScreen } from "@/components/screens/clients";
import { PerformanceScreen } from "@/components/screens/performance";
import { idForPath, products } from "@/lib/workspace/nav";
import { ALL_TOOLS } from "@/lib/bs-auth";

/*
 * The workspace, at every address.
 *
 * A catch-all so /inbox, /analytics/attribution and /team all render here with
 * the right screen already open — a pasted link shows the screen it names on
 * the first paint, with no client-side redirect flash.
 *
 * Server-rendered from the same status store the API serves, so the first paint
 * already carries real numbers — no client waterfall, and Home is useful before
 * any JavaScript runs.
 */
/** Thread and client ids are UUIDs; a non-UUID third segment is a screen. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * Segments under /inbox that are SCREENS rather than inbox views.
 *
 * This list exists because of a real bug. Every screen below is rendered on
 * every request — the shell keeps them all mounted so switching is instant and
 * costs no round-trip (see workspace.tsx `navigate`, which uses pushState).
 * That means a screen cannot assume the URL belongs to it.
 *
 * `ThreadDetail` did assume it: it treated ANY uuid in the third segment as a
 * thread id. Visiting `/inbox/portals/<clientId>` therefore handed a CLIENT id
 * to `loadThreadDetail`, which found nothing and called `notFound()` — and
 * because it renders on every request, that 404'd the whole page, including
 * the portal screen that was supposed to be showing.
 *
 * So the check is "is this URL actually an inbox view?", not "does it end in a
 * uuid".
 */
const INBOX_SCREENS = new Set(["portals", "settings", "reminders"]);

/** True only for /inbox/<view>/<threadId>, never /inbox/portals/<clientId>. */
function threadIdFrom(slug: string[] | undefined): string | null {
  const parts = slug ?? [];
  if (parts[0] !== "inbox") return null;
  const view = parts[1];
  if (!view || INBOX_SCREENS.has(view)) return null;
  const third = parts[2];
  return third && UUID.test(third) ? third : null;
}

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  /*
   * The inbox needs these: `f` is the encoded filter, `list` the active list,
   * `page` the page number and `q` a search. They arrive as query params
   * because that is what makes an inbox view linkable — a colleague pastes a
   * filtered URL and sees the same screen.
   */
  searchParams: Promise<{ f?: string; list?: string; page?: string; q?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const initialId = idForPath(`/${(slug ?? []).join("/")}`);

  const requestHeaders = await headers();

  // Set by the proxy, which has already verified the token. Trusting it here
  // avoids a second HMAC per render; Next strips inbound headers of these names,
  // so a client cannot inject them.
  const email = requestHeaders.get("x-bs-user") ?? "";
  const claimed = (requestHeaders.get("x-bs-grants") ?? "").split(",").filter(Boolean);
  const grants = ALL_TOOLS.filter((t) => claimed.includes(t));

  /*
   * Each of these loaders feeds exactly ONE screen, and
   * between them they made around eleven upstream HTTP calls:
   *
   *   getOverview          5 calls   Home
   *   getPerformance       2 calls   Performance
   *   getClientsOverview   4 calls   Clients
   *   getWeekly            650 KB of clients, Client Health's three views
   *
   * All four ran on every route. Measured on the live deployment before this
   * changed, /performance served 925,690 bytes of HTML — 722,535 of them the
   * client list, on a page that never shows it. And opening it waited on the
   * roster's three tools and the home overview's five calls before it could
   * render two numbers — 1.0 to 2.5 seconds to first byte on pages carrying no
   * data of their own.
   *
   * Now the server loads only the screen being opened, so a pasted link still
   * paints immediately with no loading state, and the rest fetch themselves on
   * first visit and stay mounted. `getAllSnapshots` is the exception: it feeds
   * the sidebar's status dots on every screen, and it reads a cached store
   * rather than making calls of its own.
   */
  const only = (id: string) => initialId === id;

  const [snapshots, overview, performance, clientHealth, clientsOverview, onboarding, agentSearch, inbox, reminders, inboxSettings, portals] =
    await Promise.all([
    getAllSnapshots(),
    only("home") ? getOverview() : Promise.resolve(null),
    only("performance") ? getPerformance() : Promise.resolve(null),
    initialId.startsWith("clients:") ? getWeekly() : Promise.resolve(null),
    only("roster") ? getClientsOverview() : Promise.resolve(null),
    only("onboarding:pipeline") ? getOnboardingPipeline() : Promise.resolve(null),
    only("search:search") ? getAgentSearchOverview() : Promise.resolve(null),
    only("inbox:all-email")
      ? getInbox({ view: "all-email", page: 1, q: "" })
      : Promise.resolve(null),
    only("inbox:reminders") ? getReminders() : Promise.resolve(null),
    only("inbox:settings") ? getSettings() : Promise.resolve(null),
    only("inbox:portals") ? getPortals() : Promise.resolve(null),
  ]);
  const summary = aggregate(snapshots.map((s) => s.state));

  const toolUrls: Record<string, string> = {};
  for (const product of products()) {
    const url = optionalEnv(product.baseUrlEnv);
    if (url) toolUrls[product.id] = url;
  }

  /*
   * The forwarded host, so the shell can work out whether each tool sits on a
   * domain that can share our sign-in cookie.
   *
   * Behind Railway's proxy a server render sees the internal container origin,
   * so `host` alone would say `localhost:8080` and every tool would look
   * un-embeddable for the wrong reason. x-forwarded-host is what the browser
   * actually asked for.
   */
  const shellHost =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";

  const local = email ? (email.split("@")[0] ?? "there") : "there";
  const firstName = local.charAt(0).toUpperCase() + local.slice(1);

  return (
    <Workspace
      initialId={initialId}
      grants={grants}
      user={{ name: firstName, email }}
      toolUrls={toolUrls}
      shellHost={shellHost}
      screens={{
        home: (
          <HomeScreen
            snapshots={snapshots}
            summary={summary}
            overview={overview}
            firstName={firstName}
            now={new Date()}
          />
        ),
        performance: <PerformanceScreen initial={performance} />,
        roster: <ClientsScreen initial={clientsOverview} />,
        consistency: <DiscrepanciesScreen />,
        /*
         * Client Health, built here rather than embedded — the live tool is
         * untouched and keeps running as a background worker.
         *
         * All three share one read — the whole client list, which each of them
         * needs anyway. Only the view actually opened gets it from the server;
         * the other two fetch it themselves, sharing one request.
         */
        "clients:weekly": <ClientHealthWeekly initial={initialId === "clients:weekly" ? clientHealth : null} />,
        "clients:biweekly": <ClientHealthBiWeekly initial={initialId === "clients:biweekly" ? clientHealth : null} />,
        "clients:success": <ClientHealthSuccess initial={initialId === "clients:success" ? clientHealth : null} />,
        /*
         * Onboarding, read from the orchestrator's own database. That service
         * keeps running untouched — it holds the hub tokens and receives the
         * Typeform, Stripe, EmailBison and Calendly webhooks, which must keep
         * arriving on their current URLs.
         */
        "onboarding:pipeline": <OnboardingPipelineScreen initial={onboarding} />,
        /*
         * Agent Search. Server-paged out of necessity rather than taste: the
         * table holds 1.17 million agents, so the browser is never sent more
         * than one page. The scraping workers and MLS monitor keep running on
         * the live service.
         */
        "search:search": <AgentSearchScreen initial={agentSearch} />,
        /*
         * Master Inbox, read-only for now. Its own loadThreads is used
         * verbatim — that query carries corrections (a 50-row page, id sets
         * instead of .in()) whose absence is invisible until the page renders
         * empty. The live service keeps serving the client portals and
         * receiving the provider webhooks; see MASTER-INBOX-AUDIT.md.
         */
        /*
         * The tool's own inbox, running here. See full-inbox.tsx for why this
         * is a port of their page rather than a screen written against the
         * mockup — the short version is that the hand-written one was missing
         * attachments, forward, reply-all, templates, the sender picker, AI
         * drafts, snooze, the prospect panel and the filter builder.
         */
        "inbox:all-email": (() => {
          /*
           * /inbox/<view> is the list; /inbox/<view>/<threadId> is one
           * conversation. `threadIdFrom` decides which, and returns null for
           * every non-inbox-view path — see its note for the 404 that taught
           * us to check the view and not just the uuid.
           */
          const threadId = threadIdFrom(slug);
          const parts = slug ?? [];
          const view = parts[0] === "inbox" && parts[1] && !INBOX_SCREENS.has(parts[1])
            ? parts[1]
            : "all-email";
          return threadId ? (
            <ThreadDetail
              view={view}
              threadId={threadId}
              f={query.f}
              list={query.list}
              page={query.page}
              q={query.q}
            />
          ) : (
            <FullInbox view={view} f={query.f} list={query.list} page={query.page} q={query.q} />
          );
        })(),
        /*
         * Archive is a real inbox view, not a separate screen — the tool
         * renders it through the same page with `view="archive"`. It was
         * falling through to the default before, which showed the wrong
         * screen at a URL in the sidebar.
         */
        "inbox:archive": (
          <FullInbox view="archive" f={query.f} list={query.list} page={query.page} q={query.q} />
        ),
        /*
         * Leads is an empty placeholder in the live tool as well
         * (`app/(app)/leads/page.tsx` renders exactly this). Kept so the nav
         * item says the same thing the tool says rather than looking broken.
         */
        "inbox:leads": (
          <FolderEmpty
            title="Leads"
            description="Your prospect & lead database will appear here."
          />
        ),
        "inbox:reminders": <RemindersScreen initial={reminders} />,
        "inbox:settings": <MasterInboxSettingsScreen tab={(slug ?? [])[2]} />,
        /*
         * /inbox/portals lists the 47 client portals; /inbox/portals/<id> is
         * the staff drill-down into one of them. The list linked at that
         * second URL and it returned 404 — the one screen the tool has that
         * this workspace was missing.
         */
        "inbox:portals": (() => {
          // Only when the URL really is /inbox/portals/<clientId>. Same lesson
          // as threadIdFrom above: this screen renders on every request.
          const parts = slug ?? [];
          const id = parts[0] === "inbox" && parts[1] === "portals" ? parts[2] : undefined;
          return id && UUID.test(id) ? <PortalDetail clientId={id} /> : <PortalsScreen initial={portals} />;
        })(),
        "team-access": <TeamAccessScreen />,
      }}
    />
  );
}
