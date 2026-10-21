import "server-only";

import { createHmac } from "node:crypto";

import { publicOrigin } from "@/lib/mcp/oauth";

import { SESSION_DAYS } from "./login";

/*
 * What the public sign-in routes share (api/portal-signin). They sit outside
 * the staff sign-in on purpose — clients are not staff — so each one checks
 * for itself: only the sign-in pages' own requests, and nothing about whether
 * an address is on a list ever shows in an answer.
 */

/** The client's session cookie — separate from staff (bs_sso), never readable by page scripts. */
export const PORTAL_COOKIE = "bs_portal";

/** The key the 6-digit codes are checked with: derived from the server's secret, never stored. */
export function signInSecret(): string {
  const base = process.env.AUTH_SECRET;
  if (!base) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", base).update("portal-signin:v1").digest("hex");
}

/** Only the sign-in pages' own requests (a browser's same-origin fetch) — not other sites, not a typed URL. */
export function fromSignInPage(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-fetch-site") === "same-origin" && (headers.get("content-type") ?? "").startsWith("application/json");
}

/** The caller's address as Railway's proxy passes it (the first hop), for the hourly limit. */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || null;
}

export const confirmBase = () => `${publicOrigin()}/portal-signin/confirm`;

export function sessionCookie(value: string) {
  return {
    name: PORTAL_COOKIE,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  };
}

export const NO_STORE = { "Cache-Control": "no-store, private, max-age=0", "X-Robots-Tag": "noindex, nofollow" } as const;

/** What a person is told when a link or code does not sign them in. */
export const REASON: Record<"invalid" | "expired" | "used" | "not-on-list" | "too-many-tries", string> = {
  invalid: "That link or code isn't right. Ask for a new sign-in link.",
  expired: "That link or code has expired. Ask for a new sign-in link.",
  used: "That link has already been used. Ask for a new sign-in link.",
  "not-on-list": "This address can no longer sign in. Please contact BrokerStaffer.",
  "too-many-tries": "Too many wrong codes. Ask for a new sign-in link.",
};
