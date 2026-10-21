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

/**
 * Only the sign-in pages' own requests (a browser's same-origin fetch) — not
 * other sites, not a typed URL. A browser that sends no Sec-Fetch-Site at all
 * (Safari before 16.4, e.g. iPhones on iOS 15) is judged by its Origin
 * instead, which every browser sends on a POST (22 Oct audit).
 */
export function fromSignInPage(headers: { get(name: string): string | null }, origin: string = publicOrigin()): boolean {
  if (!(headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return headers.get("origin") === origin;
}

/**
 * The caller's address for the hourly limit: the LAST X-Forwarded-For hop —
 * the one Railway's edge adds itself. The first hop is whatever the caller
 * wrote, so it could be changed on every request (22 Oct audit).
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1)?.slice(0, 64) || null;
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

/**
 * One answer for every code that doesn't sign in (22 Oct audit): "isn't
 * right" against "has expired" told a caller whether an address was on a
 * list (only listed addresses ever have a code). The link page keeps its own
 * reasons — a link is a secret only its owner holds.
 */
export const CODE_REFUSED = "That code didn't work. Use the code in your newest sign-in email, or ask for a new link.";

/** What a person is told when a link does not sign them in. */
export const REASON: Record<"invalid" | "expired" | "used" | "not-on-list" | "too-many-tries", string> = {
  invalid: "That link or code isn't right. Ask for a new sign-in link.",
  expired: "That link or code has expired. Ask for a new sign-in link.",
  used: "That link has already been used. Ask for a new sign-in link.",
  "not-on-list": "This address can no longer sign in. Please contact BrokerStaffer.",
  "too-many-tries": "Too many wrong codes. Ask for a new sign-in link.",
};
