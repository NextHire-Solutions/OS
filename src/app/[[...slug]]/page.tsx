import { headers } from "next/headers";
import { getAllSnapshots } from "@/lib/status/store";
import { aggregate } from "@/lib/status/derive";
import { getOverview } from "@/lib/workspace/overview";
import { getPerformance } from "@/lib/workspace/performance";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import { getClientsOverview } from "@/lib/clients/overview";
import { optionalEnv } from "@/lib/env";
import { Workspace } from "@/components/shell/workspace";
import { HomeScreen } from "@/components/screens/home";
import { TeamAccessScreen } from "@/components/screens/team-access";
import { DiscrepanciesScreen } from "@/components/screens/discrepancies";
import { ClientHealthWeekly } from "@/components/screens/client-health/weekly";
import { ClientHealthBiWeekly } from "@/components/screens/client-health/biweekly";
import { ClientHealthSuccess } from "@/components/screens/client-health/success";
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
   * Client Health's data is loaded ONLY when the page is opened on one of its
   * screens. It is by far the largest thing the workspace holds — 48 clients
   * with every week of metrics each — and it used to be server-rendered into
   * every route, whether or not that route displayed it. Measured on the live
   * deployment before this changed:
   *
   *   /performance   925,690 bytes of HTML, 722,535 of them the client list
   *
   * 92% of every page was data that page does not show. The three Client
   * Health screens now fetch it themselves when they are opened, sharing one
   * request; see `loadClientHealth()`. Opening one directly still gets it
   * server-rendered, so a pasted link paints with no loading state.
   */
  const wantsClientHealth = initialId.startsWith("clients:");

  // In parallel: one is four upstream probes, the other three Analytics calls.
  // Sequentially they would stack on every render of the home screen.
  const [snapshots, overview, performance, clientHealth, clientsOverview] = await Promise.all([
    getAllSnapshots(),
    getOverview(),
    getPerformance(),
    wantsClientHealth ? getWeekly() : Promise.resolve(null),
    getClientsOverview(),
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
        // Fetches its own data on mount rather than server-rendering: it is
        // only ever opened deliberately, and loading it on every home render
        // would cost a request nobody asked for.
        performance: <PerformanceScreen performance={performance} />,
        // Both fetch on mount: each costs several upstream calls, and paying
        // for them on every home render would slow the screen people actually
        // land on.
        roster: <ClientsScreen data={clientsOverview} />,
        consistency: <DiscrepanciesScreen />,
        /*
         * Client Health, built here rather than embedded — the live tool is
         * untouched and keeps running as a background worker.
         *
         * All three share one `getWeekly()` read. The load is the whole client
         * list with every week's metrics, which all three views need anyway, so
         * splitting it into three fetches would triple the work to show the
         * same rows.
         */
        "clients:weekly": <ClientHealthWeekly initial={initialId === "clients:weekly" ? clientHealth : null} />,
        "clients:biweekly": <ClientHealthBiWeekly initial={initialId === "clients:biweekly" ? clientHealth : null} />,
        "clients:success": <ClientHealthSuccess initial={initialId === "clients:success" ? clientHealth : null} />,
        "team-access": <TeamAccessScreen />,
      }}
    />
  );
}
