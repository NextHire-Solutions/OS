// Follow Up Boss CRM integration helper.
//
// Two outbound calls:
//   verifyApiKey(key)       — GET /v1/me. Returns the account email so
//                              the Settings card can show "Connected
//                              as foo@bar.com".
//   pushPersonEvent(key, p) — POST /v1/events. Upserts a Person + logs
//                              an event. FUB dedupes by email/phone.
//
// Auth: HTTP Basic. The API key goes in the username position with an
// EMPTY password — i.e. `apiKey:`. This is the documented FUB pattern.
//
// X-System header: FUB recommends every integration register a system
// name so they can grant higher rate limits and email about breaking
// changes. We send it on every call. The matching X-System-Key is set
// via env once we register with FUB; until then the header alone is
// the right level of detail.
//
// Errors NEVER throw. All call sites get structured `{ ok, ... }`
// results so the route layer can record `fub_last_error` cleanly
// without try/catch boilerplate.

const FUB_BASE = "https://api.followupboss.com/v1";
const X_SYSTEM = "BrokerStaffer Client Portal";
const REQUEST_TIMEOUT_MS = 10_000;

export interface FubPerson {
  // Built-in person fields. We OMIT any field whose source value is
  // empty/null at the call site, so missing data isn't a partial
  // payload at this layer.
  firstName?: string;
  lastName?: string;
  emails?: Array<{ type: string; value: string }>;
  phones?: Array<{ type: string; value: string }>;
  tags?: string[];
  // Custom fields are top-level on the Person, prefixed `custom`. The
  // exact set is built by lib/portals/build-fub-payload.ts.
  [customField: string]: unknown;
}

export type VerifyResult =
  | { ok: true; account: { name: string | null; email: string | null } }
  | { ok: false; status: number; error: string };

export type PushResult =
  | { ok: true; eventId: string | null; personId: string | null; status: 200 | 201 }
  | { ok: false; status: number; error: string };

function authHeader(apiKey: string): string {
  // base64 of `<apiKey>:` — apiKey as the username, empty password.
  const token = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${token}`;
}

function buildHeaders(apiKey: string, contentType?: string): HeadersInit {
  const h: Record<string, string> = {
    Authorization: authHeader(apiKey),
    accept: "application/json",
    "X-System": X_SYSTEM,
  };
  if (contentType) h["content-type"] = contentType;
  return h;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Validate an API key by hitting /me. Returns the account email so the
// Settings card can show "Connected as foo@bar.com".
export async function verifyApiKey(apiKey: string): Promise<VerifyResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "API key is empty" };
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${FUB_BASE}/me`, {
      method: "GET",
      headers: buildHeaders(trimmed),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, status: 0, error: msg };
  }
  const bodyText = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body.errorMessage === "string" && body.errorMessage) ||
      `Follow Up Boss returned ${res.status}`;
    return { ok: false, status: res.status, error: msg };
  }
  // /me returns the user's name + their connectedEmail. Either may be
  // null on accounts that haven't connected an email mailbox.
  const name =
    (body && typeof body.name === "string" && body.name) ||
    (body &&
      typeof body.firstName === "string" &&
      typeof body.lastName === "string" &&
      `${body.firstName} ${body.lastName}`.trim()) ||
    null;
  const email =
    (body && typeof body.connectedEmail === "string" && body.connectedEmail) ||
    (body && typeof body.leadEmailAddress === "string" && body.leadEmailAddress) ||
    null;
  return { ok: true, account: { name, email } };
}

// Upsert a Person + log an event. FUB returns 200 on update (existing
// person matched by email or phone) and 201 on create. Custom field
// keys that don't exist in the client's account are silently ignored
// by FUB — confirmed against the live API.
export async function pushPersonEvent(
  apiKey: string,
  person: FubPerson,
  // `source` is the human-facing origin tag that FUB attaches to the
  // event (visible in the FUB activity feed and usable as a smart-list
  // filter). Historically hardcoded to "BrokerStaffer" because every
  // lead came from Nicole's intros. Defaults preserve that for every
  // existing caller — only the pipeline-entry push helper actively
  // forwards a per-entry value (e.g. "Client Entry" for portal-added
  // leads). FUB accepts any string here.
  opts?: { message?: string; source?: string },
): Promise<PushResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "API key is not configured" };
  }
  // Refuse to push if we have neither email nor phone — FUB would
  // create an unfindable "Anonymous" row otherwise (verified against
  // the live API). Caller can show a clean "lead missing contact
  // info" toast instead of writing a junk record.
  const hasEmail = Array.isArray(person.emails) && person.emails.length > 0;
  const hasPhone = Array.isArray(person.phones) && person.phones.length > 0;
  if (!hasEmail && !hasPhone) {
    return {
      ok: false,
      status: 422,
      error: "Lead has no email or phone — nothing to push",
    };
  }
  const body = {
    source: opts?.source ?? "BrokerStaffer",
    system: X_SYSTEM,
    type: "General Inquiry",
    message: opts?.message ?? "Introduced via BrokerStaffer",
    person,
  };
  let res: Response;
  try {
    res = await fetchWithTimeout(`${FUB_BASE}/events`, {
      method: "POST",
      headers: buildHeaders(trimmed, "application/json"),
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, status: 0, error: msg };
  }
  const bodyText = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (res.status === 200 || res.status === 201) {
    const personId =
      parsed && typeof parsed.id === "number"
        ? String(parsed.id)
        : parsed && typeof parsed.id === "string"
          ? parsed.id
          : null;
    // FUB doesn't return a distinct eventId in the response body — the
    // event lives on the timeline of the returned Person. We persist
    // the personId in fub_event_id so the manual button can show
    // "Pushed to Follow Up Boss" and link out cleanly.
    return {
      ok: true,
      eventId: personId,
      personId,
      status: res.status as 200 | 201,
    };
  }
  const msg =
    (parsed &&
      typeof parsed.errorMessage === "string" &&
      parsed.errorMessage) ||
    `Follow Up Boss returned ${res.status}`;
  return { ok: false, status: res.status, error: msg };
}
