import { headers } from "next/headers";
import { getAllSnapshots } from "@/lib/status/store";
import { aggregate } from "@/lib/status/derive";
import { getOverview } from "@/lib/workspace/overview";
import { getPerformance } from "@/lib/workspace/performance";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import { optionalEnv } from "@/lib/env";
import { Workspace } from "@/components/shell/workspace";
import { HomeScreen } from "@/components/screens/home";
import { TeamAccessScreen } from "@/components/screens/team-access";
import { DiscrepanciesScreen } from "@/components/screens/discrepancies";
import { ClientHealthWeekly } from "@/components/screens/client-health/weekly";
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

  // In parallel: one is four upstream probes, the other three Analytics calls.
  // Sequentially they would stack on every render of the home screen.
  const [snapshots, overview, performance, clientHealth] = await Promise.all([
    getAllSnapshots(),
    getOverview(),
    getPerformance(),
    getWeekly(),
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
        consistency: <DiscrepanciesScreen />,
        // Built here, not embedded — the live tool is untouched.
        "clients:weekly": <ClientHealthWeekly data={clientHealth} />,
        "team-access": <TeamAccessScreen />,
      }}
    />
  );
}
