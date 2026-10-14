import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { RailBrand } from "@/components/shell/rail-brand";
import { SSO_COOKIE, verifySso } from "@/lib/bs-auth";
import { connectorUserCheck } from "@/lib/mcp/access";
import { checkAuthorizeRequest, deny } from "@/lib/mcp/oauth";

export const metadata: Metadata = { title: "Connect Claude — BrokerStaffer" };
export const dynamic = "force-dynamic";

/*
 * "Connect Claude to BrokerStaffer OS" (15 Oct) — where Claude's sign-in lands.
 *
 * The proxy sends anyone signed out to /login first and brings them back
 * here, so the person is on their ordinary OS session: Claude never sees a
 * password. Allow posts to /api/oauth/authorize, which re-checks everything
 * and sends the browser back to Claude with a code. Drawn like the login page.
 */

type Params = Record<string, string | string[] | undefined>;

const label = { fontSize: 12, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" as const, color: "var(--muted)" };
const body = { fontSize: 13.5, color: "var(--ink)", lineHeight: 1.55 };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--page)" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 11, color: "var(--logo)", marginBottom: 22 }}>
          <RailBrand />
        </div>
        <div className="card" style={{ padding: "26px 26px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {children}
        </div>
      </div>
    </main>
  );
}

function Problem({ title, message, cancelHref }: { title: string; message: string; cancelHref?: string }) {
  return (
    <Card>
      <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em", color: "var(--ink)" }}>{title}</h1>
      <p style={{ ...body, color: "var(--muted)" }}>{message}</p>
      {cancelHref ? (
        <a className="btn" href={cancelHref} style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center" }}>
          Back to Claude
        </a>
      ) : null}
    </Card>
  );
}

export default async function ConnectClaudePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const get = (name: string) => (typeof params[name] === "string" ? (params[name] as string) : null);
  const secret = process.env.AUTH_SECRET ?? "";

  const checked = await checkAuthorizeRequest(secret, get);
  if (!checked.ok) {
    // A good client with a bad request is told so at its own address; anything else is shown here.
    if (checked.redirect) redirect(checked.redirect);
    return <Problem title="This link can't be used" message={checked.message} />;
  }
  const request = checked.request;

  const me = await verifySso(secret, (await cookies()).get(SSO_COOKIE)?.value);
  if (!me) {
    // The proxy normally does this; kept so the page never renders a form for nobody.
    const back = `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  const user = await connectorUserCheck(me.email);
  if (!user.ok) {
    return <Problem title="Claude can't be connected" message={user.reason} cancelHref={deny(request)} />;
  }

  const hidden: Array<[string, string | null]> = [
    ["response_type", "code"],
    ["client_id", request.clientId],
    ["redirect_uri", request.redirectUri],
    ["code_challenge", request.codeChallenge],
    ["code_challenge_method", "S256"],
    ["state", request.state],
    ["scope", request.scope],
    ["resource", get("resource")],
  ];

  return (
    <Card>
      <div>
        <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em", color: "var(--ink)" }}>Connect Claude</h1>
        <p style={{ ...body, color: "var(--muted)", marginTop: 6 }}>
          <strong style={{ color: "var(--ink)" }}>{request.clientName}</strong> wants to read BrokerStaffer OS as{" "}
          <strong style={{ color: "var(--ink)" }}>{me.email}</strong>.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={label}>Claude will be able to</span>
        <p style={body}>
          Look up anything the Assistant page can: clients and their records, billing and Stripe, commissions,
          campaigns and inboxes, portals and their pipelines, introductions, and Master Inbox conversations.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={label}>Claude won&apos;t be able to</span>
        <p style={body}>
          Send email, pause or change campaigns, bill anyone, or change any record. This connection is read-only.
        </p>
      </div>

      <form method="post" action="/api/oauth/authorize" style={{ display: "flex", gap: 10, marginTop: 4 }}>
        {hidden.map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
        <button type="submit" name="decision" value="allow" className="btn btn-pri" style={{ flex: 1 }}>
          Allow
        </button>
        <button type="submit" name="decision" value="deny" className="btn" style={{ flex: 1 }}>
          Cancel
        </button>
      </form>

      <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
        Disconnect it any time in Claude&apos;s settings. Changing your OS password also disconnects it.
      </p>
    </Card>
  );
}
