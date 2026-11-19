import { METADATA_HEADERS, type GmailMessage } from "./gmail-message.ts";

/*
 * TICKETS — the Gmail API and Google's OAuth, read-only (gmail.readonly). No SDK: plain fetch, like the rest of the OS.
 *
 * Quota (Google, May 2026): 6,000 units a minute per user per project; messages.get 20 (60 for format=full),
 * history.list 2, messages.list 5, threads.get 40, attachments.get 20. Each mailbox gets its own budget of 4,000 a
 * minute, so a first fill never runs into Google's limit and leaves room for the team's other Google tools.
 * 429 and 5xx are retried with backoff (Retry-After honoured); a 401 refreshes the access token once.
 *
 * GMAIL_API_BASE / GOOGLE_OAUTH_BASE point the code at a stand-in for local tests; never set in production.
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email", "profile"];

const gmailBase = () => (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/+$/, "");
const tokenUrl = () => `${(process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/+$/, "")}/token`;
const revokeUrl = () => `${(process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/+$/, "")}/revoke`;
const userinfoUrl = () => `${(process.env.GOOGLE_OAUTH_BASE ? process.env.GOOGLE_OAUTH_BASE.replace(/\/+$/, "") : "https://www.googleapis.com/oauth2/v3")}/userinfo`;

export class GmailAuthError extends Error {
  readonly revoked: boolean;
  constructor(message: string, revoked: boolean) { super(message); this.name = "GmailAuthError"; this.revoked = revoked; }
}
export class GmailHistoryGone extends Error {
  constructor() { super("Gmail history id too old"); this.name = "GmailHistoryGone"; }
}
export class GmailError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "GmailError"; this.status = status; }
}

export interface OAuthConfig { clientId: string; clientSecret: string; redirectUri: string }

/** Google's answer to a refresh, or the reason it was refused (invalid_grant = access was taken away). */
export async function refreshAccessToken(cfg: Pick<OAuthConfig, "clientId" | "clientSecret">, refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    const code = json.error ?? `http_${res.status}`;
    const revoked = /invalid_grant|unauthorized_client|admin_policy_enforced|invalid_client/i.test(code);
    throw new GmailAuthError(`${code}${json.error_description ? `: ${json.error_description}` : ""}`, revoked);
  }
  return { accessToken: json.access_token, expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000 };
}

/** The consent screen's address: read-only Gmail, a refresh token every time (prompt=consent). */
export function consentUrl(cfg: OAuthConfig, state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Exchange the consent code: the refresh token, the granted scopes, and whose mailbox it is. */
export async function exchangeCode(cfg: OAuthConfig, code: string): Promise<{ refreshToken: string; accessToken: string; scope: string; email: string; name: string | null }> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !t.access_token) throw new Error(`Google refused the sign-in (${t.error ?? res.status}${t.error_description ? `: ${t.error_description}` : ""})`);
  if (!t.refresh_token) throw new Error("Google gave no lasting access. Remove the OS from your Google account's third-party access and connect again.");
  const scope = t.scope ?? "";
  if (!/gmail\.readonly|mail\.google\.com|gmail\.modify/.test(scope)) throw new Error("Gmail access wasn't granted. Connect again and leave the Gmail box ticked.");
  const ui = await fetch(userinfoUrl(), { headers: { Authorization: `Bearer ${t.access_token}` } });
  const info = (await ui.json().catch(() => ({}))) as { email?: string; email_verified?: boolean; name?: string };
  const email = String(info.email ?? "").trim().toLowerCase();
  if (!ui.ok || !email) throw new Error("Couldn't tell which Google account was connected");
  return { refreshToken: t.refresh_token, accessToken: t.access_token, scope, email, name: info.name ?? null };
}

/** Give the access back to Google (disconnect). Best effort: a token Google already dropped is fine. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const r = await fetch(revokeUrl(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok || r.status === 400;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- the client --- */

const UNIT_BUDGET_PER_MIN = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GmailListPage { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number }
export interface GmailHistoryPage {
  history?: Array<{ id: string; messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>;
  nextPageToken?: string;
  historyId?: string;
}

export class GmailClient {
  private token: { value: string; expiresAt: number } | null = null;
  private spent: Array<{ at: number; units: number }> = [];
  /** Units used by this client so far (for the sync's report). */
  units = 0;

  readonly mailbox: string;
  private readonly mint: () => Promise<{ accessToken: string; expiresAt: number }>;

  constructor(mailbox: string, mint: () => Promise<{ accessToken: string; expiresAt: number }>) {
    this.mailbox = mailbox;
    this.mint = mint;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const t = await this.mint();
    this.token = { value: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  private async pace(units: number) {
    for (;;) {
      const now = Date.now();
      this.spent = this.spent.filter((s) => now - s.at < 60_000);
      const used = this.spent.reduce((n, s) => n + s.units, 0);
      if (used + units <= UNIT_BUDGET_PER_MIN || !this.spent.length) break;
      await sleep(Math.max(250, 60_000 - (now - this.spent[0].at)));
    }
    this.spent.push({ at: Date.now(), units });
    this.units += units;
  }

  private async get<T>(path: string, params: Record<string, string | string[] | undefined>, units: number): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
    }
    const url = `${gmailBase()}/gmail/v1/users/me${path}${q.size ? `?${q}` : ""}`;
    await this.pace(units);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text().catch(() => "");
      if (res.status === 401 && !refreshed) { refreshed = true; await this.accessToken(true); continue; }
      if (res.status === 404 && path.startsWith("/history")) throw new GmailHistoryGone();
      const retriable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body));
      if (retriable && attempt < 4) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 600 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw new GmailError(`Gmail ${res.status} on ${path.split("?")[0]}: ${body.slice(0, 200)}`, res.status);
    }
  }

  profile() {
    return this.get<{ emailAddress: string; historyId: string; messagesTotal?: number }>("/profile", {}, 1);
  }
  listMessages(q: string, pageToken?: string, maxResults = 500) {
    return this.get<GmailListPage>("/messages", { q, pageToken, maxResults: String(maxResults), includeSpamTrash: "false" }, 5);
  }
  metadata(id: string) {
    return this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: METADATA_HEADERS }, 20);
  }
  full(id: string) {
    return this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" }, 60);
  }
  thread(id: string) {
    return this.get<{ id: string; messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: METADATA_HEADERS }, 40);
  }
  history(startHistoryId: string, pageToken?: string) {
    return this.get<GmailHistoryPage>("/history", { startHistoryId, pageToken, historyTypes: "messageAdded", maxResults: "500" }, 2);
  }
  attachment(messageId: string, attachmentId: string) {
    return this.get<{ size?: number; data?: string }>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {}, 20);
  }
}
