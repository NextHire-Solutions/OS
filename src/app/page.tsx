import { headers } from "next/headers";
import { getAllSnapshots } from "@/lib/status/store";
import { aggregate } from "@/lib/status/derive";
import { optionalEnv } from "@/lib/env";
import { Workspace } from "@/components/shell/workspace";
import { HomeScreen } from "@/components/screens/home";
import { TeamAccessScreen } from "@/components/screens/team-access";
import { products } from "@/lib/workspace/nav";
import { ALL_TOOLS } from "@/lib/bs-auth";

/*
 * The workspace.
 *
 * Server-rendered from the same status store the API serves, so the first paint
 * already carries real numbers — no client waterfall, and Home is useful before
 * any JavaScript runs.
 */
export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const requestHeaders = await headers();

  // Set by the proxy, which has already verified the token. Trusting it here
  // avoids a second HMAC per render; Next strips inbound headers of these names,
  // so a client cannot inject them.
  const email = requestHeaders.get("x-bs-user") ?? "";
  const claimed = (requestHeaders.get("x-bs-grants") ?? "").split(",").filter(Boolean);
  const grants = ALL_TOOLS.filter((t) => claimed.includes(t));

  const snapshots = await getAllSnapshots();
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
      grants={grants}
      user={{ name: firstName, email }}
      toolUrls={toolUrls}
      shellHost={shellHost}
      screens={{
        home: (
          <HomeScreen
            snapshots={snapshots}
            summary={summary}
            firstName={firstName}
            now={new Date()}
          />
        ),
        // Fetches its own data on mount rather than server-rendering: it is
        // only ever opened deliberately, and loading it on every home render
        // would cost a request nobody asked for.
        "team-access": <TeamAccessScreen />,
      }}
    />
  );
}
