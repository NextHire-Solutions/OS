import { connectorUserCheck } from "@/lib/mcp/access";
import { json, preflight } from "@/lib/mcp/http";
import { exchange } from "@/lib/mcp/oauth";

/*
 * The Claude connector's token endpoint (15 Oct): a sign-in code for tokens,
 * and a refresh token for new ones. Open at the proxy — the code's PKCE
 * verifier, or the refresh token, is the credential; both are checked in
 * lib/mcp/oauth.ts `exchange`, against the live user record.
 */

export const dynamic = "force-dynamic";

/** The request's fields, from a form body (the standard) or JSON (some clients). */
async function fieldsOf(request: Request): Promise<(name: string) => string | null> {
  const type = request.headers.get("content-type") ?? "";
  let fields: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string") fields[k] = v;
  } else {
    fields = Object.fromEntries(new URLSearchParams(await request.text()));
  }
  /*
   * A client that authenticates with HTTP Basic sends its id there. There is
   * no client secret to check — every client is public and proves itself
   * with PKCE — so only the id is taken.
   */
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (basic && !fields.client_id) {
    try {
      fields.client_id = decodeURIComponent(atob(basic).split(":")[0] ?? "");
    } catch {
      /* not Basic after all */
    }
  }
  return (name) => fields[name] ?? null;
}

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return json({ error: "server_error", error_description: "Not configured." }, 503);
  const form = await fieldsOf(request);
  const result = await exchange(secret, form, connectorUserCheck);
  if (result.status !== 200) {
    console.warn(`[mcp-auth] token ${form("grant_type") ?? "?"} refused: ${String(result.body.error_description ?? result.body.error)}`);
  }
  return json(result.body, result.status);
}

export function OPTIONS() {
  return preflight();
}
