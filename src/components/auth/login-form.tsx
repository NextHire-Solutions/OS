"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/*
 * Where to land after a successful sign-in.
 *
 * `?next=` comes straight from the URL, so it is attacker-controlled. A bare
 * `startsWith("/")` check is NOT enough: the browser reads `//evil.com` as a
 * protocol-relative URL and would happily navigate off-site, which turns the
 * login page into an open redirect — a phishing primitive worth closing even
 * on an internal tool. Backslashes are rejected too, since some browsers
 * normalise `/\evil.com` the same way.
 */
function safeNext(next: string): string {
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const configError = params.get("error") === "config";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Sign in failed.");
        return;
      }

      // Full navigation, not router.push: the session cookie was just set and
      // the proxy needs to see it on a fresh request.
      window.location.href = safeNext(next);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setPending(false);
    }
  }

  const inputClass = cn(
    "mt-1.5 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-[14px]",
    "outline-none transition-colors focus:border-brand focus:bg-surface",
  );

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-4">
      {configError ? (
        <p className="rounded-lg border border-status-down-border bg-status-down-subtle px-3 py-2 text-[12px] text-status-down-fg">
          Auth is not configured on this deployment. Set AUTH_SECRET and AUTH_USERS.
        </p>
      ) : null}

      <div>
        <label htmlFor="email" className="text-[12px] font-medium text-foreground-secondary">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@brokerstaffer.com"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="password" className="text-[12px] font-medium text-foreground-secondary">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[12px] text-status-down-fg">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={cn(
          "w-full rounded-lg bg-brand px-3 py-2.5 text-[14px] font-semibold text-brand-foreground",
          "transition-colors duration-[120ms] hover:bg-brand-hover disabled:opacity-60",
        )}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
