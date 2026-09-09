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
import { MasterInboxScreen } from "@/components/screens/master-inbox/inbox";
import { RemindersScreen } from "@/components/screens/master-inbox/reminders";
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
export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
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

  const [snapshots, overview, performance, clientHealth, clientsOverview, onboarding, agentSearch, inbox, reminders] =
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
        "inbox:all-email": <MasterInboxScreen initial={inbox} />,
        "inbox:reminders": <RemindersScreen initial={reminders} />,
        "team-access": <TeamAccessScreen />,
      }}
    />
  );
}
