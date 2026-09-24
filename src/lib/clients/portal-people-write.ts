import "server-only";

import { PUBLIC_PORTAL_HOST } from "@/lib/tools/master-inbox/portals/public-url";

/*
 * Editing a client's team, agents and DNC list FROM the OS.
 *
 * §21 step 6 lists Team, Agents and DNC among the things that change, and the
 * requirement is that an edit works from either side — the OS or the client's
 * own portal — and that both see the same thing.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NOTHING TO "SYNC", AND THAT IS THE POINT
 *
 * These lists live in exactly one place: Master Inbox's client_team_members,
 * client_agents and client_dnc_entries. The portal reads and writes those rows
 * directly. So two-way does not mean two stores kept in step by a job — it
 * means the OS writes THE SAME ROWS. One store cannot drift from itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CALLS THE PORTAL'S API INSTEAD OF WRITING THE TABLES
 *
 * The OS has the database credentials and could insert directly. It must not,
 * because those rows are not just rows:
 *
 *   - Adding a DNC entry calls enforceBlocklist() FIRST, which blocks the
 *     address on Instantly and on EmailBison, and only then writes the row with
 *     pushed_to_instantly / pushed_to_emailbison set to what actually happened.
 *   - Adding an AGENT does the same — a client's own agents must not be emailed
 *     by that client's campaigns.
 *   - Every change notifies Slack.
 *
 * A direct insert would produce a DNC entry that suppresses nobody, with flags
 * claiming it did. That is worse than having no feature at all: it looks like
 * protection and isn't. There is no staff-side route for these tables — the
 * portal API is the only door, so the OS uses it.
 *
 * The client's own portal token is the credential. It never leaves the server.
 *
 * ---------------------------------------------------------------------------
 * WHICH PORTAL
 *
 * A client with several markets has several portals, each with its OWN lists —
 * Properties & Estates has 746 agents on Florida and 152 on Boston. So an edit
 * must name the portal it applies to, and the caller must prove that portal
 * belongs to this client. There is no "the client's portal".
 */

export type PeopleResource = "team" | "agents" | "dnc";

export const PEOPLE_RESOURCES: readonly PeopleResource[] = ["team", "agents", "dnc"];

export function isPeopleResource(v: string): v is PeopleResource {
  return (PEOPLE_RESOURCES as readonly string[]).includes(v);
}

/**
 * The portal endpoint for a resource.
 *
 * A closed union rather than a path fragment, so no caller can ever steer this
 * at another part of the portal API by passing a crafted string.
 */
export function portalEndpoint(
  token: string,
  resource: PeopleResource,
  id?: string,
): string {
  const t = (token ?? "").trim();
  if (!t) throw new Error("a portal token is required");
  if (!isPeopleResource(resource)) throw new Error(`unknown resource "${resource}"`);
  const base = `https://${PUBLIC_PORTAL_HOST}/api/portal/${encodeURIComponent(t)}/${resource}`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export interface AddPersonInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  license?: string | null;
  brokerage?: string | null;
  domain?: string | null;
  notes?: string | null;
  kind?: "agent" | "company";
}

export type Shaped =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The request body for one add, validated the way the portal validates it.
 *
 * Checked here as well as there so a bad edit fails in the OS with a sentence
 * a person can act on, rather than as a 400 relayed from another service. The
 * portal remains the authority — this never sends something it would reject.
 */
export function shapeAdd(resource: PeopleResource, input: AddPersonInput): Shaped {
  const name = clean(input.name);
  if (!name) return { ok: false, error: "A name is required." };

  if (resource === "team") {
    const email = clean(input.email);
    // The only one of the three where email is mandatory: the team table is a
    // notification roster and has unique(client_id, email).
    if (!email) return { ok: false, error: "A team member needs an email address." };
    if (!EMAIL.test(email)) return { ok: false, error: `"${email}" is not a valid email address.` };
    if (name.length > 120) return { ok: false, error: "A team member's name is limited to 120 characters." };
    return {
      ok: true,
      body: {
        name,
        email,
        ...(clean(input.title) ? { title: clean(input.title) } : {}),
        ...(clean(input.phone) ? { phone: clean(input.phone) } : {}),
      },
    };
  }

  if (resource === "agents") {
    const email = clean(input.email);
    if (email && !EMAIL.test(email)) return { ok: false, error: `"${email}" is not a valid email address.` };
    if (name.length > 160) return { ok: false, error: "An agent's name is limited to 160 characters." };
    return {
      ok: true,
      body: {
        name,
        ...(email ? { email } : {}),
        ...(clean(input.phone) ? { phone: clean(input.phone) } : {}),
        ...(clean(input.license) ? { license: clean(input.license) } : {}),
      },
    };
  }

  // dnc
  const kind = input.kind === "company" ? "company" : "agent";
  const email = clean(input.email);
  const domain = clean(input.domain);
  if (email && !EMAIL.test(email)) return { ok: false, error: `"${email}" is not a valid email address.` };
  /*
   * A DNC row with nothing to block is the dangerous empty case: it appears on
   * the list, so somebody believes that person is protected, while no address
   * or domain was ever sent to Instantly or EmailBison.
   */
  if (kind === "agent" && !email) {
    return { ok: false, error: "A do-not-contact agent needs an email address, or nothing is actually blocked." };
  }
  if (kind === "company" && !domain) {
    return { ok: false, error: "A do-not-contact company needs a domain, or nothing is actually blocked." };
  }
  if (name.length > 160) return { ok: false, error: "A name is limited to 160 characters." };
  return {
    ok: true,
    body: {
      kind,
      name,
      ...(email ? { email } : {}),
      ...(domain ? { domain } : {}),
      ...(clean(input.phone) ? { phone: clean(input.phone) } : {}),
      ...(clean(input.brokerage) ? { brokerage: clean(input.brokerage) } : {}),
      ...(clean(input.notes) ? { notes: clean(input.notes) } : {}),
    },
  };
}

export interface WriteResult {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

const TIMEOUT_MS = 30_000;

async function call(url: string, init: RequestInit): Promise<WriteResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    const error = res.ok
      ? undefined
      : (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    return { ok: res.ok, status: res.status, body, error };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: e instanceof Error ? e.message : "the portal did not answer",
    };
  }
}

/** Adds one person. Blocklist enforcement happens inside the portal, as always. */
export async function addPortalPerson(
  portalToken: string,
  resource: PeopleResource,
  input: AddPersonInput,
): Promise<WriteResult> {
  const shaped = shapeAdd(resource, input);
  if (!shaped.ok) return { ok: false, status: 400, body: null, error: shaped.error };
  return call(portalEndpoint(portalToken, resource), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(shaped.body),
  });
}

/**
 * Removes one person by row id.
 *
 * Worth knowing, and surfaced to the caller rather than buried: removing a DNC
 * entry takes it off OUR list. It does not un-block the address on Instantly or
 * EmailBison — suppression there is one-way — so the person stays suppressed
 * upstream until somebody clears them in those tools.
 */
export async function removePortalPerson(
  portalToken: string,
  resource: PeopleResource,
  id: string,
): Promise<WriteResult> {
  if (!(id ?? "").trim()) return { ok: false, status: 400, body: null, error: "an id is required" };
  return call(portalEndpoint(portalToken, resource, id), { method: "DELETE" });
}
